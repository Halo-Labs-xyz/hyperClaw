#!/usr/bin/env node

import process from "node:process";

const baseUrl = process.env.HCLAW_APP_URL || "http://127.0.0.1:3014";

async function fetchJson(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(body)}`);
  }
  return body;
}

async function run() {
  const [points, treasury] = await Promise.all([
    fetchJson("/api/hclaw/points"),
    fetchJson("/api/hclaw/treasury"),
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    epoch: points.epoch,
    treasuryTotals: treasury.totals,
    agenticVault: treasury.agenticVault,
    recentFlows: Array.isArray(treasury.flows) ? treasury.flows.slice(0, 10) : [],
  };

  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error("Weekly report failed:", error);
  process.exit(1);
});
