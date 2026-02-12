#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const root = process.cwd();
for (const filename of [".env.local", ".env"]) {
  const file = path.join(root, filename);
  if (fs.existsSync(file)) {
    dotenv.config({ path: file, override: false });
  }
}

function parseBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true";
}

function requireEnv(name, errors) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    errors.push(`${name} is required`);
    return "";
  }
  return value.trim();
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isPrivateKey(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

const errors = [];
const warnings = [];

const monadTestnet = parseBoolEnv("NEXT_PUBLIC_MONAD_TESTNET", true);
const hlTestnet = parseBoolEnv("NEXT_PUBLIC_HYPERLIQUID_TESTNET", monadTestnet);

const allowRuntimeSwitch = parseBoolEnv("ALLOW_RUNTIME_NETWORK_SWITCH", false);
if (allowRuntimeSwitch) {
  errors.push("ALLOW_RUNTIME_NETWORK_SWITCH must be false for production");
}

const vaultAddress = requireEnv("NEXT_PUBLIC_VAULT_ADDRESS", errors);
if (vaultAddress && !isAddress(vaultAddress)) {
  errors.push("NEXT_PUBLIC_VAULT_ADDRESS must be a valid 0x address");
}

const onMainnet = !monadTestnet || !hlTestnet;
if (onMainnet) {
  const hclawToken = requireEnv("NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS", errors);
  requireEnv("HYPERCLAW_API_KEY", errors);
  const hclawLock = requireEnv("NEXT_PUBLIC_HCLAW_LOCK_ADDRESS", errors);
  const hclawPolicy = requireEnv("NEXT_PUBLIC_HCLAW_POLICY_ADDRESS", errors);
  const hclawRewards = requireEnv("NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS", errors);
  const agenticVault = requireEnv("NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS", errors);
  requireEnv("HCLAW_POINTS_CLOSE_KEY", errors);

  for (const [key, value] of [
    ["NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS", hclawToken],
    ["NEXT_PUBLIC_HCLAW_LOCK_ADDRESS", hclawLock],
    ["NEXT_PUBLIC_HCLAW_POLICY_ADDRESS", hclawPolicy],
    ["NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS", hclawRewards],
    ["NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS", agenticVault],
  ]) {
    if (value && !isAddress(value)) {
      errors.push(`${key} must be a valid 0x address`);
    }
  }

  const buyback = Number.parseInt(process.env.HCLAW_BUYBACK_SPLIT_BPS || "4000", 10);
  const incentive = Number.parseInt(process.env.HCLAW_INCENTIVE_SPLIT_BPS || "4000", 10);
  const reserve = Number.parseInt(process.env.HCLAW_RESERVE_SPLIT_BPS || "2000", 10);
  if (
    !Number.isFinite(buyback) ||
    !Number.isFinite(incentive) ||
    !Number.isFinite(reserve) ||
    buyback < 0 ||
    incentive < 0 ||
    reserve < 0 ||
    buyback + incentive + reserve !== 10000
  ) {
    errors.push(
      "HCLAW treasury split bps must be non-negative integers and sum to 10000"
    );
  }
}

if (!hlTestnet) {
  const builderAddress = requireEnv("NEXT_PUBLIC_BUILDER_ADDRESS", errors);
  const builderFee = requireEnv("NEXT_PUBLIC_BUILDER_FEE", errors);

  if (builderAddress && !isAddress(builderAddress)) {
    errors.push("NEXT_PUBLIC_BUILDER_ADDRESS must be a valid 0x address");
  }

  const fee = Number.parseInt(builderFee, 10);
  if (!Number.isFinite(fee) || fee <= 0) {
    errors.push("NEXT_PUBLIC_BUILDER_FEE must be a positive integer");
  }
}

if (!monadTestnet) {
  if (!process.env.MONAD_MAINNET_RPC_URL && !process.env.NEXT_PUBLIC_MONAD_MAINNET_RPC_URL) {
    warnings.push(
      "MONAD_MAINNET_RPC_URL (or NEXT_PUBLIC_MONAD_MAINNET_RPC_URL) is not set; default public RPC may rate-limit production traffic"
    );
  }

  const stables = (process.env.RELAY_STABLE_TOKENS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  if (stables.length === 0) {
    errors.push("RELAY_STABLE_TOKENS must be set before mainnet ERC20 relay deposits");
  } else {
    const invalid = stables.filter((t) => !isAddress(t));
    if (invalid.length > 0) {
      errors.push(`RELAY_STABLE_TOKENS has invalid addresses: ${invalid.join(", ")}`);
    }
  }

  const bridgeEnabled = parseBoolEnv("MAINNET_BRIDGE_ENABLED", false);
  if (bridgeEnabled) {
    const hyperunitUrl = requireEnv("HYPERUNIT_API_URL", errors);
    if (hyperunitUrl && !/^https?:\/\//.test(hyperunitUrl)) {
      errors.push("HYPERUNIT_API_URL must be a valid http(s) URL");
    }

    const relayKey = process.env.RELAY_MONAD_PRIVATE_KEY || process.env.MONAD_PRIVATE_KEY || "";
    if (!relayKey || !isPrivateKey(relayKey.trim())) {
      errors.push(
        "Bridge mode requires RELAY_MONAD_PRIVATE_KEY (or MONAD_PRIVATE_KEY) as a valid 0x private key"
      );
    }

    const hasDebridge =
      !!process.env.DEBRIDGE_MONAD_CHAIN_ID ||
      !!process.env.DEBRIDGE_HYPERLIQUID_CHAIN_ID ||
      !!process.env.DEBRIDGE_MONAD_TOKEN_IN ||
      !!process.env.DEBRIDGE_HYPERLIQUID_TOKEN_OUT;
    if (hasDebridge) {
      requireEnv("DEBRIDGE_MONAD_CHAIN_ID", errors);
      requireEnv("DEBRIDGE_HYPERLIQUID_CHAIN_ID", errors);
      requireEnv("DEBRIDGE_MONAD_TOKEN_IN", errors);
      requireEnv("DEBRIDGE_HYPERLIQUID_TOKEN_OUT", errors);
    } else {
      warnings.push(
        "MAINNET_BRIDGE_ENABLED=true but deBridge fallback envs are missing; Hyperunit-only mode will be used"
      );
    }
  }
}

if (!process.env.MONAD_PRIVATE_KEY) {
  warnings.push("MONAD_PRIVATE_KEY is not set (required for admin ops and deployments)");
}
if (!process.env.HYPERLIQUID_PRIVATE_KEY) {
  warnings.push("HYPERLIQUID_PRIVATE_KEY is not set (required for operator funding)");
}

console.log("HyperClaw mainnet preflight");
console.log(`- Monad network: ${monadTestnet ? "testnet" : "mainnet"}`);
console.log(`- Hyperliquid network: ${hlTestnet ? "testnet" : "mainnet"}`);
console.log(`- Runtime network switch: ${allowRuntimeSwitch ? "enabled" : "disabled"}`);

if (warnings.length > 0) {
  console.log("\nWarnings:");
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
}

if (errors.length > 0) {
  console.error("\nFAILED:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("\nPASS: no blocking mainnet config issues detected.");
