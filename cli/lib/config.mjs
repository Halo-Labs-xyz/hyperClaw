/**
 * CLI configuration management.
 * Reads from: HC_* env vars, .env, ~/.hyperclaw/config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

function resolveConfigFile() {
  // Test and automation override: keep config writes out of ~/.hyperclaw
  if (process.env.HC_CONFIG_PATH) return process.env.HC_CONFIG_PATH;
  const dir = process.env.HC_CONFIG_DIR || join(homedir(), ".hyperclaw");
  return join(dir, "config.json");
}

const CONFIG_FILE = resolveConfigFile();
const CONFIG_DIR = dirname(CONFIG_FILE);

const DEFAULTS = {
  baseUrl: "",
  apiKey: "",
  privyId: "",
  walletAddress: "",
  network: "mainnet",
};

function loadFileConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function getConfig() {
  const file = loadFileConfig();
  return {
    baseUrl: process.env.HC_BASE_URL || process.env.PUBLIC_BASE_URL || file.baseUrl || DEFAULTS.baseUrl,
    apiKey: process.env.HC_API_KEY || process.env.HYPERCLAW_API_KEY || file.apiKey || DEFAULTS.apiKey,
    privyId: process.env.HC_PRIVY_ID || file.privyId || DEFAULTS.privyId,
    walletAddress: process.env.HC_WALLET_ADDRESS || file.walletAddress || DEFAULTS.walletAddress,
    network: process.env.HC_NETWORK || file.network || DEFAULTS.network,
  };
}

export function saveConfig(updates) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const current = loadFileConfig();
  const merged = { ...current, ...updates };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

export function getConfigPath() {
  return CONFIG_FILE;
}
