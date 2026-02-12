#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

for (const envFile of [".env.local", ".env"]) {
  const full = path.join(process.cwd(), envFile);
  if (fs.existsSync(full)) dotenv.config({ path: full, override: false });
}

const evidencePath = path.join(process.cwd(), "docs", "submission", "main-track-evidence.json");
if (!fs.existsSync(evidencePath)) {
  throw new Error(`Missing ${evidencePath}`);
}

const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));

function setIf(name, target, key) {
  const value = process.env[name]?.trim();
  if (!value) return;
  target[key] = value;
}

function extractUniqueTxHashes(html) {
  const matches = html.match(/0x[a-fA-F0-9]{64}/g) || [];
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

async function fetchTokenTxHashes(tokenAddress) {
  if (!tokenAddress) return [];
  const url = `https://monadscan.com/address/${tokenAddress}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const html = await res.text();
    return extractUniqueTxHashes(html);
  } catch {
    return [];
  }
}

const contracts = (evidence.monadIntegration ??= {}).contracts ??= {};
setIf("NEXT_PUBLIC_VAULT_ADDRESS", contracts, "vault");
setIf("NEXT_PUBLIC_HCLAW_LOCK_ADDRESS", contracts, "hclawLock");
setIf("NEXT_PUBLIC_HCLAW_POLICY_ADDRESS", contracts, "hclawPolicy");
setIf("NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS", contracts, "hclawRewards");
setIf("NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS", contracts, "agenticLpVault");
setIf("HCLAW_TREASURY_ROUTER_ADDRESS", contracts, "treasuryRouter");

const tokenAddress = process.env.NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS?.trim();
if (tokenAddress) {
  evidence.token ??= {};
  if (!evidence.token.nadFunTokenUrl || evidence.token.nadFunTokenUrl.includes("<")) {
    evidence.token.nadFunTokenUrl = `https://nad.fun/tokens/${tokenAddress}`;
  }
}

const txHashes = await fetchTokenTxHashes(tokenAddress);
if (txHashes.length > 0) {
  evidence.monadIntegration.transactions = txHashes.slice(0, 2).map((hash, idx) => ({
    label: `HCLAW token mainnet tx ${idx + 1} (MonadScan)`,
    hash,
  }));
}

const demoUrl = process.env.HACKATHON_DEMO_VIDEO_URL?.trim();
if (demoUrl) {
  evidence.demoVideo ??= {};
  evidence.demoVideo.url = demoUrl;
}

fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Updated ${evidencePath}`);
