/**
 * Account Manager
 *
 * Multi-account management for Hyperliquid trading accounts.
 * Supports three account types:
 * - "trading": Traditional accounts with encrypted private keys
 * - "readonly": Watch-only accounts (no signing capability)
 * - "pkp": Lit Protocol PKP accounts (distributed key management)
 *
 * PKP accounts are the most secure option - private keys never exist
 * in full form and signing is done via Lit Protocol's threshold network.
 *
 * Accounts are stored in .data/accounts.json.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import { type Address } from "viem";
import type { HlAccount, PKPAccountInfo, PKPTradingConstraints } from "./types";
import { readJSON, writeJSON } from "./store-backend";

const ACCOUNTS_FILE = "accounts.json";

function privateKeyToAccountCompat(privateKey: `0x${string}`) {
  // Delay loading viem/accounts until a private-key account operation is used.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { privateKeyToAccount } = require("viem/accounts");
  return privateKeyToAccount(privateKey);
}

// Encryption key derived from env or fallback (hackathon)
function getEncryptionKey(): Buffer {
  const envKey = process.env.ACCOUNT_ENCRYPTION_KEY;
  if (!envKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "ACCOUNT_ENCRYPTION_KEY must be set in production. " +
        "Generate one with: openssl rand -hex 32"
      );
    }
    // Dev-only fallback — logged as warning so it's visible
    console.warn(
      "[AccountManager] ACCOUNT_ENCRYPTION_KEY not set — using dev-only fallback. " +
      "Set this env var before deploying."
    );
    return createHash("sha256").update("hyperclaw-dev-key-unsafe").digest();
  }
  return createHash("sha256").update(envKey).digest();
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
  const parts = encrypted.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Invalid encrypted key format");
  }
  const iv = Buffer.from(parts[0], "hex");
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(parts[1], "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/** Encrypt/decrypt for agent API keys (uses same ACCOUNT_ENCRYPTION_KEY) */
export { encrypt, decrypt };

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
 * Add a new trading, read-only, or PKP account
 */
export async function addAccount(params: {
  alias: string;
  privateKey?: string; // omit for read-only and PKP
  address?: Address; // required for read-only, derived for trading/PKP
  isDefault?: boolean;
  agentId?: string;
  // PKP-specific params
  pkp?: PKPAccountInfo;
}): Promise<HlAccount> {
  const accounts = await readAccounts();

  // Check alias uniqueness
  if (accounts.find((a) => a.alias === params.alias)) {
    throw new Error(`Account alias "${params.alias}" already exists`);
  }

  let address: Address;
  let encryptedKey: string | undefined;
  let type: "trading" | "readonly" | "pkp";
  let pkp: PKPAccountInfo | undefined;

  if (params.pkp) {
    // PKP account: distributed key via Lit Protocol
    address = params.pkp.ethAddress;
    type = "pkp";
    pkp = params.pkp;
  } else if (params.privateKey) {
    // Trading account: derive address from key
    const account = privateKeyToAccountCompat(params.privateKey as `0x${string}`);
    address = account.address;
    encryptedKey = encrypt(params.privateKey);
    type = "trading";
  } else if (params.address) {
    // Read-only account
    address = params.address;
    type = "readonly";
  } else {
    throw new Error("Either privateKey, address, or pkp must be provided");
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
    pkp,
  };

  accounts.push(account);
  await writeAccounts(accounts);
  return account;
}

/**
 * Add a PKP (Programmable Key Pair) account for an agent
 *
 * This is the secure way to create agent wallets - the private key
 * never exists in full form and signing is done via Lit Protocol.
 */
export async function addPKPAccount(params: {
  alias: string;
  agentId: string;
  pkpTokenId: string;
  pkpPublicKey: string;
  pkpEthAddress: Address;
  litActionCid?: string;
  constraints?: PKPTradingConstraints;
  isDefault?: boolean;
}): Promise<HlAccount> {
  return addAccount({
    alias: params.alias,
    agentId: params.agentId,
    isDefault: params.isDefault,
    pkp: {
      tokenId: params.pkpTokenId,
      publicKey: params.pkpPublicKey,
      ethAddress: params.pkpEthAddress,
      litActionCid: params.litActionCid,
      constraints: params.constraints,
    },
  });
}

/**
 * Get PKP info for an agent's account
 */
export async function getPKPForAgent(
  agentId: string
): Promise<PKPAccountInfo | null> {
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.agentId === agentId && a.type === "pkp");
  return account?.pkp || null;
}

/**
 * Update PKP constraints for an account
 *
 * Note: This updates the stored constraints, but to actually enforce new
 * constraints you need to deploy a new Lit Action and update the PKP permissions.
 */
export async function updatePKPConstraints(
  alias: string,
  constraints: PKPTradingConstraints
): Promise<void> {
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.alias === alias);
  
  if (!account) throw new Error(`Account "${alias}" not found`);
  if (account.type !== "pkp") throw new Error(`Account "${alias}" is not a PKP account`);
  if (!account.pkp) throw new Error(`Account "${alias}" has no PKP info`);
  
  account.pkp.constraints = constraints;
  await writeAccounts(accounts);
}

/**
 * Update the Lit Action CID for a PKP account
 */
export async function updatePKPLitAction(
  alias: string,
  litActionCid: string
): Promise<void> {
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.alias === alias);
  
  if (!account) throw new Error(`Account "${alias}" not found`);
  if (account.type !== "pkp") throw new Error(`Account "${alias}" is not a PKP account`);
  if (!account.pkp) throw new Error(`Account "${alias}" has no PKP info`);
  
  account.pkp.litActionCid = litActionCid;
  await writeAccounts(accounts);
}

/**
 * Check if an account is a PKP account
 */
export async function isPKPAccount(aliasOrAgentId: string): Promise<boolean> {
  const accounts = await readAccounts();
  const account = accounts.find(
    (a) => a.alias === aliasOrAgentId || a.agentId === aliasOrAgentId
  );
  return account?.type === "pkp";
}

/**
 * List all PKP accounts
 */
export async function listPKPAccounts(): Promise<
  Array<Omit<HlAccount, "encryptedKey">>
> {
  const accounts = await readAccounts();
  return accounts
    .filter((a) => a.type === "pkp")
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ encryptedKey, ...rest }) => rest);
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
