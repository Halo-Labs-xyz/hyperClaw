#!/usr/bin/env node

/**
 * E2E test script for Hyperclaw Railway production deployment.
 * Covers every page and API route on the site.
 *
 * Usage:
 *   E2E_BASE_URL=https://your-app.up.railway.app node scripts/e2e-railway.mjs
 *   node scripts/e2e-railway.mjs --url https://your-app.up.railway.app
 *   npm run test:e2e:railway -- --url https://your-app.up.railway.app
 *
 * Base URL resolution order:
 *   --url <url> | E2E_BASE_URL | PUBLIC_BASE_URL | exit with instructions
 */

import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

// Load .env
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
  console.error(`
E2E_BASE_URL or --url required.

Set the Railway production URL:

  export E2E_BASE_URL=https://your-app.up.railway.app
  node scripts/e2e-railway.mjs

Or pass it inline:

  node scripts/e2e-railway.mjs --url https://your-app.up.railway.app

Or use the npm script:

  npm run test:e2e:railway -- --url https://your-app.up.railway.app
`);
  process.exit(1);
}

const BASE = baseUrl.replace(/\/$/, "");
const FAKE_ID = "00000000-0000-0000-0000-000000000000";

// acceptStatus: array of acceptable HTTP status codes (route reachable + handles request)
// expectHtml/expectJson: validate response body
// method: GET | POST (default GET)
// body: optional JSON body for POST
const tests = [
  // Pages
  { name: "GET /", url: `${BASE}/`, expectStatus: 200, expectHtml: true },
  { name: "GET /agents", url: `${BASE}/agents`, expectStatus: 200, expectHtml: true },
  { name: "GET /agents/new", url: `${BASE}/agents/new`, expectStatus: 200, expectHtml: true },
  { name: "GET /agents/[id]", url: `${BASE}/agents/${FAKE_ID}`, expectStatus: [200, 404], expectHtml: true },
  { name: "GET /arena", url: `${BASE}/arena`, expectStatus: 200, expectHtml: true },
  { name: "GET /hclaw", url: `${BASE}/hclaw`, expectStatus: 200, expectHtml: true },
  { name: "GET /monitor", url: `${BASE}/monitor`, expectStatus: 200, expectHtml: true },
  { name: "GET /strategy", url: `${BASE}/strategy`, expectStatus: 200, expectHtml: true },
  { name: "GET /notification", url: `${BASE}/notification`, expectStatus: [200, 405], expectHtml: true },
  { name: "GET /~offline", url: `${BASE}/~offline`, expectStatus: 200, expectHtml: true },

  // Core API
  {
    name: "GET /api/health",
    url: `${BASE}/api/health`,
    expectStatus: 200,
    expectJson: true,
    expectFields: ["healthy", "timestamp"],
    validate: (d) => d?.healthy === true && typeof d?.bootstrap === "object",
  },
  { name: "GET /api/network", url: `${BASE}/api/network`, expectStatus: 200, expectJson: true, expectFields: ["monadTestnet", "hlTestnet"] },
  { name: "GET /api/startup", url: `${BASE}/api/startup`, expectStatus: [200, 500] },
  {
    name: "GET /api/unibase/health",
    url: `${BASE}/api/unibase/health`,
    expectStatus: 200,
    expectJson: true,
  },
  { name: "GET /api/unibase/agents", url: `${BASE}/api/unibase/agents`, expectStatus: 200, expectJson: true },

  // Market API - mids can be {} (degraded) or array
  {
    name: "GET /api/market?action=mids",
    url: `${BASE}/api/market?action=mids`,
    expectStatus: 200,
    expectJson: true,
    expectFields: ["mids"],
    validate: (d) => typeof d?.mids === "object" && d.mids !== null,
  },
  { name: "GET /api/market?action=markets", url: `${BASE}/api/market?action=markets`, expectStatus: 200, expectJson: true },
  { name: "GET /api/market?action=assets", url: `${BASE}/api/market?action=assets`, expectStatus: 200, expectJson: true },
  { name: "GET /api/market?action=all-markets", url: `${BASE}/api/market?action=all-markets`, expectStatus: 200, expectJson: true },
  { name: "GET /api/market?action=book (no coin)", url: `${BASE}/api/market?action=book`, expectStatus: 400, expectJson: true },
  { name: "GET /api/market?action=funding (no coin)", url: `${BASE}/api/market?action=funding`, expectStatus: 400, expectJson: true },

  // HCLAW
  { name: "GET /api/hclaw/state", url: `${BASE}/api/hclaw/state`, expectStatus: 200, expectJson: true, expectFields: ["configured"] },
  { name: "GET /api/hclaw/treasury", url: `${BASE}/api/hclaw/treasury`, expectStatus: 200, expectJson: true },
  { name: "GET /api/hclaw/lock", url: `${BASE}/api/hclaw/lock`, expectStatus: 200, expectJson: true },
  { name: "GET /api/hclaw/rewards", url: `${BASE}/api/hclaw/rewards`, expectStatus: 200, expectJson: true },
  { name: "GET /api/hclaw/points", url: `${BASE}/api/hclaw/points`, expectStatus: 200, expectJson: true },
  { name: "GET /api/hclaw/epochs/close", url: `${BASE}/api/hclaw/epochs/close`, expectStatus: 200, expectJson: true },

  // Builder
  { name: "GET /api/builder/info", url: `${BASE}/api/builder/info`, expectStatus: 200, expectJson: true },
  { name: "GET /api/builder/claim", url: `${BASE}/api/builder/claim`, expectStatus: [200, 401], expectJson: true },
  { name: "GET /api/builder/approve", url: `${BASE}/api/builder/approve`, expectStatus: [200, 401], expectJson: true },

  // Deposit, agents, accounts
  { name: "GET /api/deposit (no params)", url: `${BASE}/api/deposit`, expectStatus: 400, expectJson: true },
  { name: "GET /api/agents", url: `${BASE}/api/agents`, expectStatus: 200, expectJson: true },
  { name: "GET /api/accounts", url: `${BASE}/api/accounts`, expectStatus: 200, expectJson: true, expectFields: ["accounts"] },

  // Token, phala, ironclaw
  { name: "GET /api/token", url: `${BASE}/api/token`, expectStatus: 200, expectJson: true },
  { name: "GET /api/phala", url: `${BASE}/api/phala`, expectStatus: [200, 401, 503], expectJson: true },
  { name: "GET /api/ironclaw", url: `${BASE}/api/ironclaw`, expectStatus: [200, 401], expectJson: true },

  // Stream APIs
  { name: "GET /api/stream/prices?snapshot=true", url: `${BASE}/api/stream/prices?snapshot=true`, expectStatus: 200, expectJson: true },
  { name: "GET /api/stream/positions (no user)", url: `${BASE}/api/stream/positions`, expectStatus: 400, expectJson: true },
  { name: "GET /api/stream/orders (no user)", url: `${BASE}/api/stream/orders`, expectStatus: 400, expectJson: true },
  { name: "GET /api/stream/book (no coin)", url: `${BASE}/api/stream/book`, expectStatus: 400, expectJson: true },
  { name: "GET /api/stream/balances (no user)", url: `${BASE}/api/stream/balances`, expectStatus: 400, expectJson: true },

  // Lifecycle, orchestrator
  { name: "GET /api/lifecycle", url: `${BASE}/api/lifecycle`, expectStatus: 200, expectJson: true },
  { name: "GET /api/agents/orchestrator", url: `${BASE}/api/agents/orchestrator`, expectStatus: [200, 401], expectJson: true },

  // Agent detail routes (fake ID -> 404)
  { name: "GET /api/agents/[id]", url: `${BASE}/api/agents/${FAKE_ID}`, expectStatus: 404, expectJson: true },
  { name: "GET /api/agents/[id]/chat", url: `${BASE}/api/agents/${FAKE_ID}/chat`, expectStatus: 404, expectJson: true },

  // POST routes - verify route reachable (expect 400/401/404)
  { name: "POST /api/deposit", url: `${BASE}/api/deposit`, method: "POST", body: {}, expectStatus: [400, 200] },
  { name: "POST /api/fund", url: `${BASE}/api/fund`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/network", url: `${BASE}/api/network`, method: "POST", body: {}, expectStatus: [200, 403] },
  { name: "POST /api/trade", url: `${BASE}/api/trade`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/trade/cancel", url: `${BASE}/api/trade/cancel`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/trade/leverage", url: `${BASE}/api/trade/leverage`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/unibase/poll", url: `${BASE}/api/unibase/poll`, method: "POST", body: {}, expectStatus: [400, 404] },
  { name: "POST /api/unibase/register", url: `${BASE}/api/unibase/register`, method: "POST", body: {}, expectStatus: [400, 401, 404] },
  { name: "POST /api/unibase/invoke/[agentId]", url: `${BASE}/api/unibase/invoke/${FAKE_ID}`, method: "POST", body: {}, expectStatus: [400, 404] },
  { name: "POST /api/agents", url: `${BASE}/api/agents`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/accounts", url: `${BASE}/api/accounts`, method: "POST", body: {}, expectStatus: [401, 400] },
  { name: "POST /api/agents/[id]/approve", url: `${BASE}/api/agents/${FAKE_ID}/approve`, method: "POST", body: {}, expectStatus: [400, 404] },
  { name: "POST /api/agents/[id]/tick", url: `${BASE}/api/agents/${FAKE_ID}/tick`, method: "POST", body: {}, expectStatus: [400, 401, 404] },
  { name: "POST /api/agents/[id]/bridge-fund", url: `${BASE}/api/agents/${FAKE_ID}/bridge-fund`, method: "POST", body: {}, expectStatus: [400, 404, 410] },
  { name: "POST /api/agents/[id]/unit-deposit-address", url: `${BASE}/api/agents/${FAKE_ID}/unit-deposit-address`, method: "POST", body: {}, expectStatus: [400, 404, 410] },
  { name: "POST /api/agents/[id]/chat", url: `${BASE}/api/agents/${FAKE_ID}/chat`, method: "POST", body: {}, expectStatus: [400, 404] },
  { name: "POST /api/builder/claim", url: `${BASE}/api/builder/claim`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/builder/approve", url: `${BASE}/api/builder/approve`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/hclaw/rewards", url: `${BASE}/api/hclaw/rewards`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/hclaw/points", url: `${BASE}/api/hclaw/points`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/hclaw/treasury", url: `${BASE}/api/hclaw/treasury`, method: "POST", body: {}, expectStatus: [401, 400] },
  { name: "POST /api/hclaw/lock", url: `${BASE}/api/hclaw/lock`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/hclaw/epochs/close", url: `${BASE}/api/hclaw/epochs/close`, method: "POST", body: {}, expectStatus: [401, 400] },
  { name: "POST /api/lifecycle", url: `${BASE}/api/lifecycle`, method: "POST", body: {}, expectStatus: [400] },
  { name: "POST /api/wallet/attest", url: `${BASE}/api/wallet/attest`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/ironclaw", url: `${BASE}/api/ironclaw`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/mcp", url: `${BASE}/api/mcp`, method: "POST", body: {}, expectStatus: [400, 401] },
  { name: "POST /api/telegram/webhook", url: `${BASE}/api/telegram/webhook`, method: "POST", body: {}, expectStatus: [200, 400, 404] },
];

function normalizeStatus(expected) {
  return Array.isArray(expected) ? expected : [expected];
}

async function runTest({
  name,
  url,
  expectStatus,
  expectHtml,
  expectJson,
  expectFields,
  validate,
  method = "GET",
  body,
}) {
  const start = Date.now();
  const acceptStatus = normalizeStatus(expectStatus);
  try {
    const opts = {
      method,
      headers: { Accept: "application/json, text/html" },
      redirect: "follow",
    };
    if (method === "POST" && body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const elapsed = Date.now() - start;

    const statusOk = acceptStatus.includes(res.status);
    let bodyOk = true;
    let validateOk = true;
    let data = null;

    const contentType = res.headers.get("content-type") ?? "";

    if (expectHtml) {
      bodyOk = contentType.includes("text/html") || res.ok || acceptStatus.includes(res.status);
    } else if (expectJson) {
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        bodyOk = false;
      }
      if (expectFields && data) {
        bodyOk = expectFields.every((f) => f in data);
      }
      if (validate && data) {
        try {
          validateOk = validate(data);
        } catch {
          validateOk = false;
        }
      }
    }

    const pass = statusOk && bodyOk && validateOk;
    const icon = pass ? "✓" : "✗";
    const color = pass ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";

    console.log(
      `${color}${icon}${reset} ${name} ${pass ? "" : `(status=${res.status}) `}${elapsed}ms`
    );
    if (!pass && data && typeof data === "object" && "error" in data) {
      console.log(`    └─ ${data.error}`);
    }
    return { name, pass, status: res.status, elapsed };
  } catch (err) {
    console.log(`\x1b[31m✗\x1b[0m ${name} FAILED: ${err.message}`);
    return { name, pass: false, error: err.message };
  }
}

async function main() {
  console.log(`\nE2E testing Railway production: ${BASE}\n`);

  const results = [];
  for (const t of tests) {
    results.push(await runTest(t));
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const allPassed = passed === total;

  console.log(`\n${passed}/${total} checks passed`);
  if (allPassed) {
    console.log("\n✓ E2E tests passed\n");
    process.exit(0);
  } else {
    console.log("\n✗ Some E2E tests failed\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
