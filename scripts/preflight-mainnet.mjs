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

function requireOneOfEnv(names, errors, label) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== "") {
      return value.trim();
    }
  }
  errors.push(`${label} is required (set one of: ${names.join(", ")})`);
  return "";
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

const vaultAddress = requireOneOfEnv(
  [
    "NEXT_PUBLIC_MONAD_MAINNET_VAULT_ADDRESS",
    "NEXT_PUBLIC_VAULT_ADDRESS_MAINNET",
    "NEXT_PUBLIC_VAULT_ADDRESS",
  ],
  errors,
  "Mainnet vault address"
);
if (vaultAddress && !isAddress(vaultAddress)) {
  errors.push("Mainnet vault address must be a valid 0x address");
}

const onMainnet = !monadTestnet || !hlTestnet;
if (onMainnet) {
  const hclawToken = requireOneOfEnv(
    ["NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS_MAINNET", "NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS"],
    errors,
    "Mainnet HCLAW token address"
  );
  requireEnv("HYPERCLAW_API_KEY", errors);
  const hclawLock = requireOneOfEnv(
    ["NEXT_PUBLIC_HCLAW_LOCK_ADDRESS_MAINNET", "NEXT_PUBLIC_HCLAW_LOCK_ADDRESS"],
    errors,
    "Mainnet HCLAW lock address"
  );
  const hclawPolicy = requireOneOfEnv(
    ["NEXT_PUBLIC_HCLAW_POLICY_ADDRESS_MAINNET", "NEXT_PUBLIC_HCLAW_POLICY_ADDRESS"],
    errors,
    "Mainnet HCLAW policy address"
  );
  const hclawRewards = requireOneOfEnv(
    ["NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS_MAINNET", "NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS"],
    errors,
    "Mainnet HCLAW rewards address"
  );
  const agenticVault = requireOneOfEnv(
    ["NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS_MAINNET", "NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS"],
    errors,
    "Mainnet agentic LP vault address"
  );
  requireEnv("HCLAW_POINTS_CLOSE_KEY", errors);

  for (const [key, value] of [
    ["Mainnet HCLAW token address", hclawToken],
    ["Mainnet HCLAW lock address", hclawLock],
    ["Mainnet HCLAW policy address", hclawPolicy],
    ["Mainnet HCLAW rewards address", hclawRewards],
    ["Mainnet agentic LP vault address", agenticVault],
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

  // MAINNET_BRIDGE_ENABLED, Hyperunit, deBridge removed — users bridge via LI.FI in Deposit tab.
}

if (!process.env.MONAD_PRIVATE_KEY) {
  warnings.push("MONAD_PRIVATE_KEY is not set (required for admin ops and deployments)");
}
if (!process.env.HYPERLIQUID_PRIVATE_KEY) {
  warnings.push("HYPERLIQUID_PRIVATE_KEY is not set (required for operator funding)");
}

const attestationEnabled = parseBoolEnv("MONAD_AGENT_ATTESTATION_ENABLED", true);
const attestationRequired = parseBoolEnv(
  "MONAD_AGENT_ATTESTATION_REQUIRED",
  process.env.NODE_ENV === "production"
);
if (attestationEnabled && attestationRequired) {
  const attestorKey =
    process.env.AIP_ATTESTATION_PRIVATE_KEY ||
    process.env.RELAY_MONAD_PRIVATE_KEY ||
    process.env.MONAD_PRIVATE_KEY;
  if (!attestorKey || !isPrivateKey(attestorKey.trim())) {
    errors.push(
      "Monad agent attestation is enabled+required but no valid AIP_ATTESTATION_PRIVATE_KEY/RELAY_MONAD_PRIVATE_KEY/MONAD_PRIVATE_KEY is configured"
    );
  }
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
