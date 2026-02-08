/**
 * Account Manager
 *
 * Multi-account management for Hyperliquid trading accounts.
 * Mirrors CLI's `hl account add/ls/remove/set-default` pattern.
 * Uses JSON file store (hackathon-appropriate) instead of SQLite.
 *
 * Accounts are stored in .data/accounts.json with encrypted private keys.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import { privateKeyToAccount } from "viem/accounts";
import { type Address } from "viem";
import type { HlAccount } from "./types";
import { readJSON, writeJSON } from "./store-backend";

const ACCOUNTS_FILE = "accounts.json";

// Encryption key derived from env or fallback (hackathon)
function getEncryptionKey(): Buffer {
  const envKey = process.env.ACCOUNT_ENCRYPTION_KEY;
  if (envKey) {
    return createHash("sha256").update(envKey).digest();
  }
  // Fallback for dev: derive from a stable seed
  return createHash("sha256").update("hyperclaw-dev-key").digest();
}

function encrypt(text: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(encrypted: string): string {
  const key = getEncryptionKey();
  const [ivHex, encText] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encText, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ============================================
// Account storage (uses store-backend: file or S3)
// ============================================

async function readAccounts(): Promise<HlAccount[]> {
  return readJSON<HlAccount[]>(ACCOUNTS_FILE, []);
}

async function writeAccounts(accounts: HlAccount[]): Promise<void> {
  await writeJSON(ACCOUNTS_FILE, accounts);
}

// ============================================
// Account CRUD
// ============================================

/**
 * Add a new trading or read-only account
 */
export async function addAccount(params: {
  alias: string;
  privateKey?: string; // omit for read-only
  address?: Address; // required for read-only, derived for trading
  isDefault?: boolean;
  agentId?: string;
}): Promise<HlAccount> {
  const accounts = await readAccounts();

  // Check alias uniqueness
  if (accounts.find((a) => a.alias === params.alias)) {
    throw new Error(`Account alias "${params.alias}" already exists`);
  }

  let address: Address;
  let encryptedKey: string | undefined;
  let type: "trading" | "readonly";

  if (params.privateKey) {
    // Trading account: derive address from key
    const account = privateKeyToAccount(params.privateKey as `0x${string}`);
    address = account.address;
    encryptedKey = encrypt(params.privateKey);
    type = "trading";
  } else if (params.address) {
    // Read-only account
    address = params.address;
    type = "readonly";
  } else {
    throw new Error("Either privateKey or address must be provided");
  }

  // If setting as default, unset others
  if (params.isDefault) {
    for (const a of accounts) {
      a.isDefault = false;
    }
  }

  const account: HlAccount = {
    alias: params.alias,
    address,
    type,
    isDefault: params.isDefault ?? accounts.length === 0, // first account is default
    encryptedKey,
    agentId: params.agentId,
    createdAt: Date.now(),
  };

  accounts.push(account);
  await writeAccounts(accounts);
  return account;
}

/**
 * List all accounts (private keys are not exposed)
 */
export async function listAccounts(): Promise<
  Array<Omit<HlAccount, "encryptedKey">>
> {
  const accounts = await readAccounts();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return accounts.map(({ encryptedKey, ...rest }) => rest);
}

/**
 * Get default account
 */
export async function getDefaultAccount(): Promise<HlAccount | null> {
  const accounts = await readAccounts();
  return accounts.find((a) => a.isDefault) || accounts[0] || null;
}

/**
 * Get account by alias
 */
export async function getAccountByAlias(
  alias: string
): Promise<HlAccount | null> {
  const accounts = await readAccounts();
  return accounts.find((a) => a.alias === alias) || null;
}

/**
 * Get account linked to an agent
 */
export async function getAccountForAgent(
  agentId: string
): Promise<HlAccount | null> {
  const accounts = await readAccounts();
  return accounts.find((a) => a.agentId === agentId) || null;
}

/**
 * Retrieve decrypted private key for a trading account
 * Only used server-side for order execution
 */
export async function getPrivateKeyForAccount(
  alias: string
): Promise<string | null> {
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.alias === alias);
  if (!account || !account.encryptedKey) return null;
  return decrypt(account.encryptedKey);
}

/**
 * Retrieve decrypted private key for an agent's account
 */
export async function getPrivateKeyForAgent(
  agentId: string
): Promise<string | null> {
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.agentId === agentId);
  if (!account || !account.encryptedKey) return null;
  return decrypt(account.encryptedKey);
}

/**
 * Set default account
 */
export async function setDefaultAccount(alias: string): Promise<void> {
  const accounts = await readAccounts();
  let found = false;
  for (const a of accounts) {
    if (a.alias === alias) {
      a.isDefault = true;
      found = true;
    } else {
      a.isDefault = false;
    }
  }
  if (!found) throw new Error(`Account "${alias}" not found`);
  await writeAccounts(accounts);
}

/**
 * Remove an account
 */
export async function removeAccount(alias: string): Promise<void> {
  const accounts = await readAccounts();
  const filtered = accounts.filter((a) => a.alias !== alias);
  if (filtered.length === accounts.length) {
    throw new Error(`Account "${alias}" not found`);
  }

  // If removed account was default, set first remaining as default
  if (
    filtered.length > 0 &&
    !filtered.some((a) => a.isDefault)
  ) {
    filtered[0].isDefault = true;
  }

  await writeAccounts(filtered);
}

/**
 * Link an account to an agent
 */
export async function linkAccountToAgent(
  alias: string,
  agentId: string
): Promise<void> {
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.alias === alias);
  if (!account) throw new Error(`Account "${alias}" not found`);

  // Unlink any existing account for this agent
  for (const a of accounts) {
    if (a.agentId === agentId) {
      a.agentId = undefined;
    }
  }

  account.agentId = agentId;
  await writeAccounts(accounts);
}
