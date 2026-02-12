#!/usr/bin/env node

import process from "node:process";
import { spawnSync } from "node:child_process";

const isTestnet = process.env.NEXT_PUBLIC_MONAD_TESTNET !== "false";
const rpcUrl = process.env.MONAD_RPC_URL || (isTestnet ? "https://testnet-rpc.monad.xyz" : "https://rpc.monad.xyz");

const hclawToken = process.env.NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS;
const nadFunLens = process.env.NADFUN_LENS_ADDRESS || "0x73363d4090fd6a012fb31514733235af2de0cda7";
const rebateToken = process.env.HCLAW_REBATE_TOKEN_ADDRESS || "0x0000000000000000000000000000000000000000";

const buybackRecipient = process.env.HCLAW_BUYBACK_RECIPIENT;
const incentiveRecipient = process.env.HCLAW_INCENTIVE_RECIPIENT;
const reserveRecipient = process.env.HCLAW_RESERVE_RECIPIENT;
const agenticExecutor = process.env.HCLAW_AGENTIC_EXECUTOR;

if (!hclawToken) {
  console.error("NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS is required.");
  process.exit(1);
}
if (!process.env.MONAD_PRIVATE_KEY) {
  console.error("MONAD_PRIVATE_KEY is required to deploy contracts.");
  process.exit(1);
}
if (!buybackRecipient || !incentiveRecipient || !reserveRecipient || !agenticExecutor) {
  console.error(
    "HCLAW_BUYBACK_RECIPIENT, HCLAW_INCENTIVE_RECIPIENT, HCLAW_RESERVE_RECIPIENT, and HCLAW_AGENTIC_EXECUTOR are required."
  );
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
  console.log("Deploying HCLAW stack...");
  console.log(`Network: ${isTestnet ? "Monad testnet" : "Monad mainnet"}`);
  console.log(`RPC: ${rpcUrl}`);

  const lockAddress = deploy("contracts/HclawLock.sol:HclawLock", [hclawToken]);
  console.log(`HclawLock: ${lockAddress}`);

  const policyAddress = deploy("contracts/HclawPolicy.sol:HclawPolicy", [
    hclawToken,
    nadFunLens,
    lockAddress,
  ]);
  console.log(`HclawPolicy: ${policyAddress}`);

  const vaultV3Address = deploy("contracts/HyperclawVaultV3.sol:HyperclawVaultV3", [
    hclawToken,
    nadFunLens,
    policyAddress,
  ]);
  console.log(`HyperclawVaultV3: ${vaultV3Address}`);

  const rewardsAddress = deploy(
    "contracts/HclawRewardsDistributor.sol:HclawRewardsDistributor",
    [hclawToken, rebateToken]
  );
  console.log(`HclawRewardsDistributor: ${rewardsAddress}`);

  const treasuryRouterAddress = deploy(
    "contracts/HclawTreasuryRouter.sol:HclawTreasuryRouter",
    [buybackRecipient, incentiveRecipient, reserveRecipient]
  );
  console.log(`HclawTreasuryRouter: ${treasuryRouterAddress}`);

  const agenticVaultAddress = deploy("contracts/AgenticLPVault.sol:AgenticLPVault", [agenticExecutor]);
  console.log(`AgenticLPVault: ${agenticVaultAddress}`);

  console.log("\nExport these env vars:");
  console.log(`NEXT_PUBLIC_VAULT_ADDRESS=${vaultV3Address}`);
  console.log(`NEXT_PUBLIC_HCLAW_LOCK_ADDRESS=${lockAddress}`);
  console.log(`NEXT_PUBLIC_HCLAW_POLICY_ADDRESS=${policyAddress}`);
  console.log(`NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS=${rewardsAddress}`);
  console.log(`NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS=${agenticVaultAddress}`);
  console.log(`HCLAW_TREASURY_ROUTER_ADDRESS=${treasuryRouterAddress}`);
}

main();
