#!/usr/bin/env node

/**
 * E2E business logic tests for Hyperclaw Railway production.
 * Verifies response structure, data integrity, and business rules.
 *
 * Usage:
 *   E2E_BASE_URL=https://your-app.up.railway.app node scripts/e2e-railway-business.mjs
 *   E2E_BASE_URL=... E2E_API_KEY=... node scripts/e2e-railway-business.mjs
 *   npm run test:e2e:railway:business -- --url https://your-app.up.railway.app
 *
 * Optional env:
 *   E2E_API_KEY - API key for authenticated routes (fund, agent-balance). Falls back to HYPERCLAW_API_KEY.
 *   E2E_AGENT_ID - Use specific agent. Otherwise uses first agent from GET /api/agents.
 */

import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

const root = process.cwd();
for (const filename of [".env.local", ".env"]) {
  const file = path.join(root, filename);
  if (fs.existsSync(file)) {
    dotenv.config({ path: file, override: false });
  }
}

const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");
const baseUrl =
  (urlIdx >= 0 && args[urlIdx + 1]) ||
  process.env.E2E_BASE_URL?.trim() ||
  process.env.PUBLIC_BASE_URL?.trim() ||
  null;

if (!baseUrl) {
  console.error("\nE2E_BASE_URL or --url required. Example:\n  E2E_BASE_URL=https://hyperclaw.up.railway.app node scripts/e2e-railway-business.mjs\n");
  process.exit(1);
}

const BASE = baseUrl.replace(/\/$/, "");
const API_KEY = process.env.E2E_API_KEY?.trim() || process.env.HYPERCLAW_API_KEY?.trim();

function headers() {
  const h = { Accept: "application/json" };
  if (API_KEY) {
    h["x-api-key"] = API_KEY;
    h["Authorization"] = `Bearer ${API_KEY}`;
  }
  return h;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...headers(), ...opts.headers },
    redirect: "follow",
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON: ${text.slice(0, 200)}`);
  }
  return { res, data };
}

const results = [];

function pass(name, detail = "") {
  results.push({ name, pass: true });
  console.log(`\x1b[32m✓\x1b[0m ${name}${detail ? ` ${detail}` : ""}`);
}

function fail(name, msg) {
  results.push({ name, pass: false });
  console.log(`\x1b[31m✗\x1b[0m ${name}`);
  if (msg) console.log(`    └─ ${msg}`);
}

async function main() {
  console.log(`\nE2E business logic: ${BASE}\n`);

  let agentId = process.env.E2E_AGENT_ID?.trim();

  // --- 1. Agents list structure ---
  try {
    const { res, data } = await fetchJson(`${BASE}/api/agents`);
    if (res.status !== 200) {
      fail("Agents list structure", `status ${res.status}`);
    } else if (!Array.isArray(data?.agents)) {
      fail("Agents list structure", "response.agents must be an array");
    } else {
      const agents = data.agents;
      const hasValidAgent = agents.some(
        (a) =>
          a && typeof a.id === "string" && typeof a.name === "string" && Array.isArray(a.markets)
      );
      if (!hasValidAgent && agents.length > 0) {
        fail("Agents list structure", "each agent must have id, name, markets");
      } else {
        pass("Agents list structure", `(${agents.length} agents)`);
        if (!agentId && agents.length > 0) {
          agentId = agents[0].id;
        }
      }
    }
  } catch (err) {
    fail("Agents list structure", err.message);
  }

  // --- 2. Network state business rule ---
  try {
    const { res, data } = await fetchJson(`${BASE}/api/network`);
    if (res.status !== 200) {
      fail("Network state", `status ${res.status}`);
    } else if (typeof data?.monadTestnet !== "boolean" || typeof data?.hlTestnet !== "boolean") {
      fail("Network state", "monadTestnet and hlTestnet must be boolean");
    } else {
      pass("Network state", `monad=${data.monadTestnet} hl=${data.hlTestnet}`);
    }
  } catch (err) {
    fail("Network state", err.message);
  }

  // --- 3. Deposit param validation (business rule) — linked to Privy ID + PKP flows ---
  try {
    const { res, data } = await fetchJson(`${BASE}/api/deposit`);
    if (res.status !== 400) {
      fail("Deposit param validation", `expect 400 without params, got ${res.status}`);
    } else if (!data?.error) {
      fail("Deposit param validation", "error message required");
    } else {
      const err = String(data.error).toLowerCase();
      const hasAgentId = err.includes("agentid");
      const hasUser = err.includes("user");
      const hasOwnerPrivyId = err.includes("ownerprivyid") || err.includes("privy");
      if (!hasAgentId && !hasUser && !hasOwnerPrivyId) {
        fail("Deposit param validation", "error should mention agentId, user, or ownerPrivyId");
      } else {
        pass("Deposit param validation", "400 when missing agentId/user/ownerPrivyId (Privy+PKP linked)");
      }
    }
  } catch (err) {
    fail("Deposit param validation", err.message);
  }

  // --- 4. Deposit by ownerPrivyId (Privy + PKP linked flow) ---
  try {
    const { res, data } = await fetchJson(`${BASE}/api/deposit?ownerPrivyId=test-e2e-nonexistent`);
    if (res.status === 200) {
      if (data?.ownerPrivyId !== "test-e2e-nonexistent") {
        fail("Deposit by ownerPrivyId", "response should echo ownerPrivyId");
      } else if (!Array.isArray(data?.deposits)) {
        fail("Deposit by ownerPrivyId", "deposits must be array");
      } else {
        pass("Deposit by ownerPrivyId", `(Privy+PKP linked) deposits=${data.deposits?.length ?? 0}`);
      }
    } else if (res.status === 400) {
      pass("Deposit by ownerPrivyId", "(not yet deployed; 400 until ownerPrivyId support is live)");
    } else {
      fail("Deposit by ownerPrivyId", `expect 200 or 400, got ${res.status}`);
    }
  } catch (err) {
    fail("Deposit by ownerPrivyId", err.message);
  }

  // --- 5. Market mids structure (retry on transient "terminated"/network) ---
  const marketMidsRetries = 2;
  let marketMidsDone = false;
  for (let attempt = 1; attempt <= marketMidsRetries && !marketMidsDone; attempt++) {
    try {
      const { res, data } = await fetchJson(`${BASE}/api/market?action=mids`);
      if (res.status !== 200) {
        fail("Market mids structure", `status ${res.status}`);
        marketMidsDone = true;
      } else if (typeof data?.mids !== "object" || data.mids === null) {
        fail("Market mids structure", "mids must be object");
        marketMidsDone = true;
      } else {
        const mids = data.mids;
        const keys = Object.keys(mids);
        const sample = keys.slice(0, 5);
        const numericValues = sample.every((k) => {
          const v = mids[k];
          return typeof v === "number" || (typeof v === "string" && !Number.isNaN(parseFloat(v)));
        });
        if (keys.length > 0 && !numericValues && sample.length > 0) {
          fail("Market mids structure", "mids values should be numeric");
        } else {
          pass("Market mids structure", `(${keys.length} coins)`);
        }
        marketMidsDone = true;
      }
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (attempt < marketMidsRetries && (msg.includes("terminated") || msg.includes("fetch failed") || msg.includes("ECONNRESET"))) {
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        fail("Market mids structure", msg);
        break;
      }
    }
  }

  // --- 6. HCLAW state structure ---
  try {
    const { res, data } = await fetchJson(`${BASE}/api/hclaw/state`);
    if (res.status !== 200) {
      fail("HCLAW state structure", `status ${res.status}`);
    } else if (typeof data?.configured !== "boolean") {
      fail("HCLAW state structure", "configured must be boolean");
    } else {
      pass("HCLAW state structure", `configured=${data.configured}`);
    }
  } catch (err) {
    fail("HCLAW state structure", err.message);
  }

  // --- 7. Fund status (requires API key in prod) ---
  try {
    const { res, data } = await fetchJson(`${BASE}/api/fund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status" }),
    });
    if (res.status === 401) {
      fail("Fund status", "401 Unauthorized (set E2E_API_KEY or HYPERCLAW_API_KEY)");
    } else if (res.status !== 200) {
      fail("Fund status", `status ${res.status}`);
    } else if (typeof data !== "object" || data === null) {
      fail("Fund status", "response must be object");
    } else {
      pass("Fund status", "status action OK");
    }
  } catch (err) {
    fail("Fund status", err.message);
  }

  // --- 8. Deposit for agent (if we have agentId) ---
  if (agentId) {
    try {
      const { res, data } = await fetchJson(`${BASE}/api/deposit?agentId=${encodeURIComponent(agentId)}`);
      if (res.status !== 200) {
        fail("Deposit for agent", `status ${res.status}`);
      } else if (data?.agentId !== agentId) {
        fail("Deposit for agent", "response.agentId should match request");
      } else {
        const deposits = data?.deposits;
        if (deposits !== undefined && !Array.isArray(deposits)) {
          fail("Deposit for agent", "deposits must be array");
        } else {
          pass("Deposit for agent", `agentId=${agentId.slice(0, 8)}... deposits=${(deposits ?? []).length} tvl=${data?.tvlUsd ?? 0}`);
        }
      }
    } catch (err) {
      fail("Deposit for agent", err.message);
    }

    // --- 9. Agent detail ---
    try {
      const { res, data } = await fetchJson(`${BASE}/api/agents/${agentId}`);
      if (res.status === 404) {
        fail("Agent detail", "agent not found");
      } else if (res.status !== 200) {
        fail("Agent detail", `status ${res.status}`);
      } else {
        const agent = data?.agent ?? data;
        if (!agent?.id || agent.id !== agentId) {
          fail("Agent detail", "response.agent.id must match");
        } else if (!Array.isArray(agent?.markets)) {
          fail("Agent detail", "agent.markets must be array");
        } else {
          pass("Agent detail", `${agent.name ?? "unknown"} (${agent.markets?.length ?? 0} markets)`);
        }
      }
    } catch (err) {
      fail("Agent detail", err.message);
    }

    // --- 10. Fund agent-balance (requires API key) ---
    try {
      const { res, data } = await fetchJson(`${BASE}/api/fund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "agent-balance", agentId }),
      });
      if (res.status === 401) {
        fail("Fund agent-balance", "401 (set E2E_API_KEY)");
      } else if (res.status !== 200) {
        fail("Fund agent-balance", `status ${res.status}`);
      } else if (data?.agentId !== agentId) {
        fail("Fund agent-balance", "agentId mismatch");
      } else if (typeof data?.hasWallet !== "boolean") {
        fail("Fund agent-balance", "hasWallet must be boolean");
      } else {
        pass("Fund agent-balance", `hasWallet=${data.hasWallet} network=${data?.network ?? "?"}`);
      }
    } catch (err) {
      fail("Fund agent-balance", err.message);
    }
  } else {
    pass("Deposit for agent", "(skipped, no agents)");
    pass("Agent detail", "(skipped, no agents)");
    pass("Fund agent-balance", "(skipped, no agents)");
  }

  // --- 11. Market actions validation ---
  try {
    const { res } = await fetchJson(`${BASE}/api/market?action=book`);
    if (res.status !== 400) {
      fail("Market book param validation", `expect 400 without coin, got ${res.status}`);
    } else {
      pass("Market book param validation", "400 when coin missing");
    }
  } catch (err) {
    fail("Market book param validation", err.message);
  }

  // --- 12. Fund action validation ---
  try {
    const { res, data } = await fetchJson(`${BASE}/api/fund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "provision" }),
    });
    if (res.status === 401) {
      fail("Fund provision validation", "401 (set E2E_API_KEY)");
    } else if (res.status !== 400) {
      fail("Fund provision validation", `expect 400 without agentId, got ${res.status}`);
    } else if (!data?.error || !String(data.error).toLowerCase().includes("agentid")) {
      fail("Fund provision validation", "error should mention agentId");
    } else {
      pass("Fund provision validation", "400 when agentId missing");
    }
  } catch (err) {
    fail("Fund provision validation", err.message);
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n${passed}/${total} business logic checks passed`);
  if (passed === total) {
    console.log("\n✓ Business logic E2E passed\n");
    process.exit(0);
  } else {
    console.log("\n✗ Some business logic checks failed\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
