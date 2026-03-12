import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, "..");

const host = "127.0.0.1";

const hyperclawApiKey = `hc_${randomBytes(16).toString("hex")}`;

let app = null;
let appPort = 0;
let baseUrl = "";
let appLogs = "";

function withAuth(headers = {}) {
  return {
    ...headers,
    "x-api-key": hyperclawApiKey,
  };
}

async function requestJson(url, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, raw };
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not resolve free port"));
        return;
      }
      const port = address.port;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForAppReady() {
  const timeoutMs = 120_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (app?.exitCode !== null && app?.exitCode !== undefined) {
      throw new Error(
        `hyperClaw dev process exited before readiness check (exit code ${app.exitCode})\n${appLogs}`
      );
    }

    try {
      const response = await requestJson(`${baseUrl}/api/liquidclaw/intents`, {
        method: "POST",
        headers: withAuth({ "Content-Type": "application/json" }),
        body: {},
      });
      if (response.status === 400) {
        return;
      }
    } catch {
      // Keep polling until server is ready.
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for hyperClaw on ${baseUrl}\n${appLogs}`);
}

before(async () => {
  appPort = await findFreePort();
  baseUrl = `http://${host}:${appPort}`;

  const appEnv = {
    ...process.env,
    HYPERCLAW_API_KEY: hyperclawApiKey,
  };

  app = spawn("npm", ["run", "dev", "--", "-H", host, "-p", String(appPort)], {
    cwd: root,
    env: appEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  app.stdout.on("data", (chunk) => {
    appLogs += chunk.toString();
  });
  app.stderr.on("data", (chunk) => {
    appLogs += chunk.toString();
  });

  await waitForAppReady();
});

after(async () => {
  if (!app) return;

  if (app.exitCode === null) {
    app.kill("SIGTERM");
    try {
      await Promise.race([
        once(app, "exit"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for dev server to exit")), 20_000)
        ),
      ]);
    } catch {
      app.kill("SIGKILL");
      await once(app, "exit");
    }
  }
});

describe("LiquidClaw bridge route smokes", () => {
  test("auth guard on intents route", async () => {
    const missingAuth = await requestJson(`${baseUrl}/api/liquidclaw/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {},
    });
    assert.equal(missingAuth.status, 401);
    assert.equal(missingAuth.json?.error, "Unauthorized. Provide a valid API key.");

    const wrongAuth = await requestJson(`${baseUrl}/api/liquidclaw/intents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "wrong-key",
      },
      body: {},
    });
    assert.equal(wrongAuth.status, 401);
  });

  test("intent -> execute -> verify -> run lookup lifecycle", async () => {
    const intentId = `intent_ws82_${randomBytes(6).toString("hex")}`;

    const intent = await requestJson(`${baseUrl}/api/liquidclaw/intents`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }),
      body: {
        intent_id: intentId,
        agent_id: "agent_ws8",
        user_id: "privy:ws8-user",
        market_context_hash: `ctx_${randomBytes(8).toString("hex")}`,
        strategy: {
          operation: "vault_rebalance",
          vault: {
            chain: "monad",
            vault_address: "0x1111111111111111111111111111111111111111",
            asset: "MON",
            target_notional_usd: "12500",
          },
        },
        risk_limits: {
          max_drawdown_bps: 450,
          max_leverage_x: 3,
          require_attestation: true,
        },
      },
    });

    assert.equal(intent.status, 202);
    assert.equal(intent.json?.accepted, true);
    assert.equal(intent.json?.run_id, intentId);
    assert.equal(intent.json?.intent?.intent_id, intentId);
    assert.equal(intent.json?.intent?.strategy?.vault?.chain, "monad");
    assert.equal(intent.json?.intent?.risk_limits?.require_attestation, true);
    assert.equal(intent.json?.stage?.intent, "completed");
    assert.equal(intent.json?.stage?.execution, "pending");
    assert.equal(intent.json?.stage?.verification, "pending");
    assert.match(intent.json?.intent_hash ?? "", /^[a-f0-9]{64}$/);

    const preExecuteRun = await requestJson(`${baseUrl}/api/liquidclaw/runs/${intentId}`, {
      method: "GET",
      headers: withAuth(),
    });
    assert.equal(preExecuteRun.status, 200);
    assert.equal(preExecuteRun.json?.lookup?.kind, "intent_id");
    assert.equal(preExecuteRun.json?.lifecycle, "intent_accepted");

    const execute = await requestJson(`${baseUrl}/api/liquidclaw/execute`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }),
      body: {
        intent_id: intentId,
        mode: "paper",
        symbol: "eth",
        side: "buy",
        notional: 12000,
        price_ref: 3000,
      },
    });

    assert.equal(execute.status, 202);
    assert.equal(execute.json?.accepted, true);
    assert.equal(execute.json?.execution?.intent_id, intentId);
    assert.equal(execute.json?.execution?.symbol, "ETH");
    assert.equal(execute.json?.execution?.mode, "paper");
    assert.equal(execute.json?.execution?.simulated_fills?.length, 2);
    assert.match(execute.json?.execution?.decision_hash ?? "", /^[a-f0-9]{64}$/);
    assert.match(execute.json?.execution?.receipt_hash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(execute.json?.stage?.verification, "pending");

    const receiptId = execute.json?.execution?.receipt_id;
    assert.equal(typeof receiptId, "string");
    assert.match(receiptId, /^rcpt_[a-f0-9]{24}$/);

    const verifyUnknown = await requestJson(`${baseUrl}/api/liquidclaw/verify`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }),
      body: { receipt_id: "rcpt_not_found" },
    });
    assert.equal(verifyUnknown.status, 404);

    const verify = await requestJson(`${baseUrl}/api/liquidclaw/verify`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }),
      body: {
        receipt_id: receiptId,
        backend: "eigencloud_primary",
        status: "verified",
        proof_ref: `proof_${randomBytes(6).toString("hex")}`,
      },
    });
    assert.equal(verify.status, 202);
    assert.equal(verify.json?.accepted, true);
    assert.equal(verify.json?.verification?.receipt_id, receiptId);
    assert.equal(verify.json?.verification?.backend, "eigencloud_primary");
    assert.equal(verify.json?.verification?.status, "verified");
    assert.match(verify.json?.verification?.verification_hash ?? "", /^[a-f0-9]{64}$/);

    const verificationId = verify.json?.verification?.verification_id;
    assert.equal(typeof verificationId, "string");
    assert.match(verificationId, /^ver_[a-f0-9\-]{36}$/);

    const runByReceipt = await requestJson(`${baseUrl}/api/liquidclaw/runs/${receiptId}`, {
      method: "GET",
      headers: withAuth(),
    });
    assert.equal(runByReceipt.status, 200);
    assert.equal(runByReceipt.json?.lookup?.kind, "receipt_id");
    assert.equal(runByReceipt.json?.lifecycle, "verified");
    assert.equal(runByReceipt.json?.run?.execution?.receipt_id, receiptId);

    const runByVerification = await requestJson(`${baseUrl}/api/liquidclaw/runs/${verificationId}`, {
      method: "GET",
      headers: withAuth(),
    });
    assert.equal(runByVerification.status, 200);
    assert.equal(runByVerification.json?.lookup?.kind, "verification_id");
    assert.equal(runByVerification.json?.lifecycle, "verified");
    assert.equal(runByVerification.json?.run?.verification?.verification_id, verificationId);
  });

  test("vault and wallet attestation smoke paths", async () => {
    const intent = await requestJson(`${baseUrl}/api/liquidclaw/intents`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }),
      body: {
        agent_id: "agent_vault_attestation",
        user_id: "privy:vault-attestation",
        market_context_hash: `ctx_${randomBytes(8).toString("hex")}`,
        strategy: {
          vault_snapshot: {
            tvl_usd: "250000.00",
            max_deposit_usd: "5000.00",
            collateral_token: "MON",
          },
          attestation_snapshot: {
            provider: "wallet_attestation",
            attested: false,
          },
        },
        risk_limits: {
          enforce_wallet_attestation: true,
        },
      },
    });

    assert.equal(intent.status, 202);
    assert.equal(intent.json?.accepted, true);
    assert.equal(intent.json?.intent?.strategy?.vault_snapshot?.collateral_token, "MON");
    assert.equal(intent.json?.intent?.strategy?.attestation_snapshot?.provider, "wallet_attestation");

    const missingFields = await requestJson(`${baseUrl}/api/wallet/attest`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }),
      body: {
        action: "status",
      },
    });
    assert.equal(missingFields.status, 400);
    assert.equal(missingFields.json?.error, "privyUserId and walletAddress are required");

    const walletAddress = "0x1111111111111111111111111111111111111111";
    const status = await requestJson(`${baseUrl}/api/wallet/attest`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }),
      body: {
        action: "status",
        privyUserId: "privy:attestation-smoke",
        walletAddress,
      },
    });
    assert.equal(status.status, 200);
    assert.equal(status.json?.attested, false);

    const prepare = await requestJson(`${baseUrl}/api/wallet/attest`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }),
      body: {
        action: "prepare",
        privyUserId: "privy:attestation-smoke",
        walletAddress,
      },
    });
    assert.equal(prepare.status, 200);
    assert.equal(prepare.json?.attested, false);
    assert.equal(typeof prepare.json?.challengeId, "string");
    assert.equal(typeof prepare.json?.message, "string");
    assert.equal(typeof prepare.json?.expiresAt, "number");

    const verifyMissingSignature = await requestJson(`${baseUrl}/api/wallet/attest`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }),
      body: {
        action: "verify",
        privyUserId: "privy:attestation-smoke",
        walletAddress,
        challengeId: prepare.json?.challengeId,
      },
    });
    assert.equal(verifyMissingSignature.status, 400);
    assert.equal(
      verifyMissingSignature.json?.error,
      "challengeId and signature are required for verify action"
    );
  });
});
