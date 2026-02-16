#!/usr/bin/env node

import process from "node:process";

const BASE_URL = (process.env.HCLAW_APP_URL || process.env.APP_URL || "http://127.0.0.1:3014").replace(/\/$/, "");
const NETWORK = process.env.HCLAW_NETWORK === "testnet" ? "testnet" : "mainnet";
const USER = (process.env.HCLAW_CHECK_USER || "").trim().toLowerCase();
const API_KEY = process.env.HYPERCLAW_API_KEY || "";
const MIN_OPERATOR_USDC = Number.parseFloat(process.env.HCLAW_MIN_OPERATOR_USDC || "1000");

function isHexAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function toNum(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function fmtUsd(n) {
  return `$${toNum(n).toFixed(2)}`;
}

async function requestJson(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body, url };
}

async function run() {
  const checks = [];
  const failures = [];
  const plan = [];

  const userQuery = USER && isHexAddress(USER) ? `&user=${USER}` : "";

  const state = await requestJson(`/api/hclaw/state?network=${NETWORK}${userQuery}`);
  const stateConfigured = Boolean(state.body?.configured);
  const tokenAddress = state.body?.state?.tokenAddress;
  const lockAddress = state.body?.state?.lockAddress;
  const stateOk = state.ok && stateConfigured && isHexAddress(tokenAddress) && isHexAddress(lockAddress);
  checks.push({
    name: "state",
    ok: stateOk,
    detail: stateOk
      ? `token=${tokenAddress} lock=${lockAddress}`
      : `configured=${state.body?.configured} token=${tokenAddress ?? "n/a"} lock=${lockAddress ?? "n/a"}`,
  });
  if (!stateOk) {
    failures.push("HCLAW state is not fully configured");
    plan.push("Set correct mainnet/testnet HCLAW token + lock env variables and redeploy.");
  }

  const lock = await requestJson(`/api/hclaw/lock?network=${NETWORK}${userQuery}`);
  const lockContract = lock.body?.contract || {};
  const lockOk =
    lock.ok &&
    Boolean(lockContract.deployed) &&
    lockContract.compatible !== false &&
    lockContract.paused !== true;
  checks.push({
    name: "lock",
    ok: lockOk,
    detail: lockOk
      ? `address=${lockContract.address} paused=${Boolean(lockContract.paused)}`
      : `address=${lockContract.address ?? "n/a"} deployed=${Boolean(lockContract.deployed)} compatible=${lockContract.compatible} paused=${lockContract.paused}`,
  });
  if (!lockOk) {
    failures.push("HCLAW lock contract is not ready");
    if (!lockContract.deployed || lockContract.compatible === false) {
      plan.push("Set NEXT_PUBLIC_HCLAW_LOCK_ADDRESS_<NETWORK> to deployed HclawLock address.");
    }
    if (lockContract.paused === true) {
      plan.push("Unpause HclawLock via owner: setPaused(false).");
    }
  }

  const points = await requestJson(`/api/hclaw/points${USER && isHexAddress(USER) ? `?user=${USER}` : ""}`);
  const epoch = points.body?.epoch;
  const now = Date.now();
  const epochEndTs = Number(epoch?.endTs || 0);
  const epochStatus = String(epoch?.status || "unknown");
  const epochStale = epochEndTs > 0 && epochEndTs <= now && epochStatus !== "closed";
  const pointsOk = points.ok && Boolean(epoch?.epochId) && !epochStale;
  checks.push({
    name: "points/epoch",
    ok: pointsOk,
    detail: pointsOk
      ? `epoch=${epoch?.epochId} status=${epochStatus} endTs=${epochEndTs}`
      : `epoch=${epoch?.epochId ?? "n/a"} status=${epochStatus} endTs=${epochEndTs || "n/a"}`,
  });
  if (!pointsOk) {
    failures.push("Epoch state is stale or unavailable");
    plan.push("Run epoch close now and schedule epoch keeper job.");
  }

  const rewards = await requestJson(`/api/hclaw/rewards${USER && isHexAddress(USER) ? `?user=${USER}` : ""}`);
  const rewardsOk = rewards.ok && Array.isArray(rewards.body?.rewards);
  checks.push({
    name: "rewards",
    ok: rewardsOk,
    detail: rewardsOk ? `rows=${rewards.body.rewards.length}` : `status=${rewards.status}`,
  });
  if (!rewardsOk) {
    failures.push("Rewards endpoint unhealthy");
    plan.push("Verify rewards contract env vars and Supabase reward tables.");
  }

  const treasury = await requestJson(`/api/hclaw/treasury?network=${NETWORK}`);
  const vaultConfigured = Boolean(treasury.body?.agenticVault?.configured);
  const treasuryOk = treasury.ok && Boolean(treasury.body?.totals) && vaultConfigured;
  checks.push({
    name: "treasury/agentic",
    ok: treasuryOk,
    detail: treasuryOk
      ? `agenticVault.configured=true totals.amountUsd=${fmtUsd(treasury.body?.totals?.amountUsd)}`
      : `agenticVault.configured=${vaultConfigured} status=${treasury.status}`,
  });
  if (!treasuryOk) {
    failures.push("Treasury/agentic vault metrics not live");
    plan.push("Set NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS_<NETWORK> to deployed AgenticLPVault.");
  }

  const epochCloseGet = await requestJson("/api/hclaw/epochs/close");
  const epochCloseOk = epochCloseGet.ok && Boolean(epochCloseGet.body?.epoch?.epochId);
  checks.push({
    name: "epoch-close-get",
    ok: epochCloseOk,
    detail: epochCloseOk
      ? `epoch=${epochCloseGet.body.epoch.epochId}`
      : `status=${epochCloseGet.status}`,
  });

  const operatorBalance = await requestJson("/api/fund", {
    method: "POST",
    headers: API_KEY ? { "x-api-key": API_KEY } : {},
    body: JSON.stringify({ action: "operator-balance" }),
  });

  const operatorAvailable = toNum(operatorBalance.body?.perp?.availableBalance);
  const operatorOk = operatorBalance.ok && operatorAvailable >= MIN_OPERATOR_USDC;
  checks.push({
    name: "operator-funding",
    ok: operatorOk,
    detail: operatorBalance.ok
      ? `available=${fmtUsd(operatorAvailable)} min=${fmtUsd(MIN_OPERATOR_USDC)}`
      : `status=${operatorBalance.status} error=${operatorBalance.body?.error ?? "n/a"}`,
  });
  if (!operatorOk) {
    failures.push("Operator HL balance below buffer or unreadable");
    const deficit = Math.max(0, MIN_OPERATOR_USDC - operatorAvailable);
    if (!operatorBalance.ok) {
      plan.push("Fix API auth (`HYPERCLAW_API_KEY`) and validate operator balance endpoint.");
    } else {
      plan.push(
        `Top up operator Hyperliquid USDC by at least ${fmtUsd(deficit)} (target buffer ${fmtUsd(
          MIN_OPERATOR_USDC
        )}).`
      );
    }
  }

  console.log(`HCLAW Ops Check @ ${new Date().toISOString()}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Network: ${NETWORK}`);
  if (USER && isHexAddress(USER)) console.log(`User: ${USER}`);
  console.log("");

  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name} - ${c.detail}`);
  }

  console.log("");
  if (failures.length === 0) {
    console.log("System status: GREEN");
  } else {
    console.log("System status: RED");
    console.log("Failures:");
    for (const f of failures) console.log(`- ${f}`);
  }

  console.log("");
  console.log("Flywheel Schedule:");
  console.log("- every 15m: run `node scripts/hclaw-ops-check.mjs`");
  console.log("- every 60m: run `node scripts/hclaw-epoch-keeper.mjs`");
  console.log("- weekly: run `node scripts/close-hclaw-epoch.mjs` as manual backstop");

  if (plan.length > 0) {
    console.log("");
    console.log("Remediation Plan:");
    for (const step of plan) console.log(`- ${step}`);
  }

  process.exit(failures.length === 0 ? 0 : 2);
}

run().catch((error) => {
  console.error("HCLAW ops check failed:", error);
  process.exit(1);
});

