#!/usr/bin/env node

import process from "node:process";

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const epochDurationDays = Number.parseInt(process.env.HCLAW_EPOCH_DURATION_DAYS || "7", 10);
const lookbackDays = Number.parseInt(process.env.HCLAW_BACKFILL_LOOKBACK_DAYS || "14", 10);

function epochWindow(nowMs = Date.now()) {
  const epochMs = Math.max(1, epochDurationDays) * 24 * 60 * 60 * 1000;
  const startTs = Math.floor(nowMs / epochMs) * epochMs;
  const endTs = startTs + epochMs;
  const epochId = `epoch-${Math.floor(startTs / 1000)}`;
  return { epochId, startTs, endTs };
}

async function rest(path, { method = "GET", body } = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { Prefer: "resolution=merge-duplicates,return=minimal" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} failed: ${text}`);
  }

  if (!text.trim()) return [];
  return JSON.parse(text);
}

function scoreLpPoints(usdValue) {
  const lpScore = Math.max(0, usdValue) / 100;
  return Math.round(lpScore * 0.35 * 1_000_000) / 1_000_000;
}

async function run() {
  const { epochId, startTs, endTs } = epochWindow();
  const minTs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  const deposits = await rest(
    `hc_deposits?select=user_address,usd_value,timestamp&timestamp=gte.${minTs}`
  );

  const byUser = new Map();
  for (const row of deposits) {
    const user = String(row.user_address).toLowerCase();
    const value = Number(row.usd_value || 0);
    byUser.set(user, (byUser.get(user) || 0) + value);
  }

  await rest("hc_hclaw_points_epochs", {
    method: "POST",
    body: [
      {
        epoch_id: epochId,
        start_ts: startTs,
        end_ts: endTs,
        status: "open",
        root_hash: null,
        settled_ts: null,
      },
    ],
  });

  let balanceCount = 0;
  let rewardCount = 0;

  for (const [user, volume] of byUser.entries()) {
    const lpPoints = scoreLpPoints(volume);
    const totalPoints = lpPoints;
    const rebateUsd = Math.round(lpPoints * 0.05 * 1_000_000) / 1_000_000;
    const incentiveHclaw = Math.round(totalPoints * 0.2 * 1_000_000) / 1_000_000;

    await rest("hc_hclaw_points_balances", {
      method: "POST",
      body: [
        {
          epoch_id: epochId,
          user_address: user,
          lock_points: 0,
          lp_points: lpPoints,
          ref_points: 0,
          quest_points: 0,
          total_points: totalPoints,
        },
      ],
    });
    balanceCount += 1;

    await rest("hc_hclaw_rewards", {
      method: "POST",
      body: [
        {
          user_address: user,
          epoch_id: epochId,
          rebate_usd: rebateUsd,
          incentive_hclaw: incentiveHclaw,
          claimed: false,
        },
      ],
    });
    rewardCount += 1;
  }

  console.log(
    JSON.stringify(
      {
        epochId,
        depositsScanned: deposits.length,
        usersScored: byUser.size,
        balancesUpserted: balanceCount,
        rewardsUpserted: rewardCount,
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
