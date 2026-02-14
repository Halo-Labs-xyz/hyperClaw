#!/usr/bin/env node

/**
 * Deploy HclawBuybackLock contract.
 *
 * This contract receives treasury buyback MON, buys HCLAW on nad.fun, and locks
 * it in the HclawLock contract. Use its address as HCLAW_BUYBACK_RECIPIENT when
 * deploying HclawTreasuryRouter (or update the router's recipients).
 *
 * Usage:
 *   HCLAW_LOCK_ADDRESS=0x... node scripts/deploy-hclaw-buyback-lock.mjs
 *   npm run deploy:hclaw-buyback-lock
 *
 * Required env:
 *   MONAD_PRIVATE_KEY
 *   NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS (or HCLAW_TOKEN_ADDRESS)
 *   NEXT_PUBLIC_HCLAW_LOCK_ADDRESS (or HCLAW_LOCK_ADDRESS)
 *
 * Optional:
 *   NADFUN_LENS_ADDRESS (default: mainnet 0x7e78..., testnet 0xB056...)
 *   HCLAW_BUYBACK_LOCK_DURATION_DAYS (default: 180)
 */

import process from "node:process";
import { spawnSync } from "node:child_process";

const isTestnet = process.env.NEXT_PUBLIC_MONAD_TESTNET !== "false";
const rpcUrl =
  process.env.MONAD_RPC_URL ||
  (isTestnet ? "https://testnet-rpc.monad.xyz" : "https://rpc.monad.xyz");

const hclawToken =
  process.env.NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS || process.env.HCLAW_TOKEN_ADDRESS;
const hclawLock =
  process.env.NEXT_PUBLIC_HCLAW_LOCK_ADDRESS ||
  process.env.HCLAW_LOCK_ADDRESS ||
  process.env.NEXT_PUBLIC_HCLAW_LOCK_ADDRESS_MAINNET ||
  process.env.NEXT_PUBLIC_MONAD_MAINNET_HCLAW_LOCK_ADDRESS;
const nadFunLens =
  process.env.NADFUN_LENS_ADDRESS ||
  process.env.NADFUN_LENS_ADDRESS ||
  (isTestnet ? "0xB056d79CA5257589692699a46623F901a3BB76f1" : "0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea");
const lockDurationDays = parseInt(process.env.HCLAW_BUYBACK_LOCK_DURATION_DAYS || "180", 10);

if (!hclawToken) {
  console.error("NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS or HCLAW_TOKEN_ADDRESS is required.");
  process.exit(1);
}
if (!hclawLock) {
  console.error("NEXT_PUBLIC_HCLAW_LOCK_ADDRESS or HCLAW_LOCK_ADDRESS is required.");
  process.exit(1);
}
if (!process.env.MONAD_PRIVATE_KEY) {
  console.error("MONAD_PRIVATE_KEY is required.");
  process.exit(1);
}
if (![30, 90, 180].includes(lockDurationDays)) {
  console.error("HCLAW_BUYBACK_LOCK_DURATION_DAYS must be 30, 90, or 180.");
  process.exit(1);
}

function deploy(contractPath, constructorArgs = []) {
  const args = [
    "create",
    contractPath,
    "--rpc-url",
    rpcUrl,
    "--private-key",
    process.env.MONAD_PRIVATE_KEY,
  ];
  if (constructorArgs.length > 0) {
    args.push("--constructor-args", ...constructorArgs);
  }

  const result = spawnSync("forge", args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`Failed deploying ${contractPath}`);
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const match = combined.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
  if (!match) {
    throw new Error(`Could not parse deployment address for ${contractPath}`);
  }

  return match[1];
}

function main() {
  console.log("Deploying HclawBuybackLock...");
  console.log(`Network: ${isTestnet ? "Monad testnet" : "Monad mainnet"}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`HCLAW token: ${hclawToken}`);
  console.log(`HclawLock: ${hclawLock}`);
  console.log(`NadFun lens: ${nadFunLens}`);
  console.log(`Lock duration: ${lockDurationDays} days`);

  const address = deploy("contracts/HclawBuybackLock.sol:HclawBuybackLock", [
    nadFunLens,
    hclawToken,
    hclawLock,
    String(lockDurationDays),
  ]);

  console.log(`\nHclawBuybackLock: ${address}`);
  console.log("\nSet this as HCLAW_BUYBACK_RECIPIENT when deploying HclawTreasuryRouter,");
  console.log("or call configureRecipients(buyback, incentive, reserve) on the router.");
  console.log("\nExport:");
  console.log(`HCLAW_BUYBACK_RECIPIENT=${address}`);
}

main();
