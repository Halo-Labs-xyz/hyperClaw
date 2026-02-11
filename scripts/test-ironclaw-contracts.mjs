#!/usr/bin/env node

/**
 * Integration contracts for:
 * - app/api/mcp/route.ts
 * - app/api/ironclaw/route.ts
 *
 * This script boots:
 * 1) A mock IronClaw webhook server
 * 2) hyperClaw Next.js dev server on localhost
 *
 * Then validates the HTTP contracts end-to-end.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, "..");

const host = "127.0.0.1";
const requestedAppPort = Number(process.env.HYPERCLAW_CONTRACT_PORT || 3014);
const mockIronClawPort = Number(process.env.MOCK_IRONCLAW_PORT || 0);

const hyperclawApiKey = `hc_${randomBytes(16).toString("hex")}`;
const mcpApiKey = `mcp_${randomBytes(16).toString("hex")}`;
const webhookSecret = `whsec_${randomBytes(16).toString("hex")}`;
const hclawCloseKey = `hclose_${randomBytes(16).toString("hex")}`;

const mockState = {
  health: "healthy",
  lastWebhookBody: null,
};

function log(message) {
  process.stdout.write(`${message}\n`);
}

function createJsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startMockIronclawServer() {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      if (mockState.health === "healthy") {
        createJsonResponse(res, 200, { status: "healthy", channel: "http" });
      } else {
        createJsonResponse(res, 503, { status: "unhealthy", channel: "http" });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/webhook") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        createJsonResponse(res, 400, { response: "Invalid JSON" });
        return;
      }

      mockState.lastWebhookBody = body;

      if (body.secret !== webhookSecret) {
        createJsonResponse(res, 401, { response: "Invalid webhook secret" });
        return;
      }

      if (typeof body.content === "string" && body.content.includes("force-fail")) {
        createJsonResponse(res, 500, { response: "mock webhook failure" });
        return;
      }

      createJsonResponse(res, 200, {
        message_id: `msg_${randomBytes(4).toString("hex")}`,
        status: "ok",
        response: `ack:${body.content}`,
      });
      return;
    }

    createJsonResponse(res, 404, { error: "not found" });
  });

  server.listen(mockIronClawPort, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve mock IronClaw listen address");
  }
  return { server, port: address.port };
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

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
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

async function resolveAppPort() {
  if (await isPortFree(requestedAppPort)) return requestedAppPort;
  const fallback = await findFreePort();
  log(
    `Port ${requestedAppPort} is already in use; using free test port ${fallback} instead.`
  );
  return fallback;
}

async function waitForAppReady(baseUrl, apiKey, appProcess) {
  const timeoutMs = 120_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (appProcess.exitCode !== null) {
      throw new Error(
        `hyperClaw dev process exited before readiness check (exit code ${appProcess.exitCode})`
      );
    }

    try {
      const response = await requestJson(`${baseUrl}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: { jsonrpc: "2.0", id: 1, method: "initialize" },
      });
      if (
        response.status === 200 &&
        response.json?.jsonrpc === "2.0" &&
        response.json?.result?.protocolVersion
      ) {
        return;
      }
    } catch {
      // Keep polling until server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for hyperClaw on ${baseUrl}`);
}

async function run() {
  log("Starting mock IronClaw server...");
  const { server: mockServer, port: mockPort } = await startMockIronclawServer();
  const appPort = await resolveAppPort();

  const appEnv = {
    ...process.env,
    HYPERCLAW_API_KEY: hyperclawApiKey,
    MCP_API_KEY: mcpApiKey,
    HCLAW_POINTS_CLOSE_KEY: hclawCloseKey,
    IRONCLAW_WEBHOOK_URL: `http://${host}:${mockPort}/webhook`,
    IRONCLAW_WEBHOOK_SECRET: webhookSecret,
  };

  log(`Starting hyperClaw dev server on http://${host}:${appPort} ...`);
  const app = spawn("npm", ["run", "dev", "--", "-H", host, "-p", String(appPort)], {
    cwd: root,
    env: appEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let appLogs = "";
  app.stdout.on("data", (chunk) => {
    appLogs += chunk.toString();
  });
  app.stderr.on("data", (chunk) => {
    appLogs += chunk.toString();
  });

  const base = `http://${host}:${appPort}`;

  try {
    await waitForAppReady(base, hyperclawApiKey, app);
    log("Running contract checks...");

    // /api/mcp auth matrix
    {
      const body = { jsonrpc: "2.0", id: 1, method: "initialize" };

      const missingAuth = await requestJson(`${base}/api/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      assert.equal(missingAuth.status, 401);
      assert.equal(missingAuth.json?.error?.code, -32001);

      const wrongAuth = await requestJson(`${base}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "wrong-key",
        },
        body,
      });
      assert.equal(wrongAuth.status, 401);
      assert.equal(wrongAuth.json?.error?.code, -32001);

      const xApiKeyAuth = await requestJson(`${base}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": hyperclawApiKey,
        },
        body,
      });
      assert.equal(xApiKeyAuth.status, 200);
      assert.equal(xApiKeyAuth.json?.jsonrpc, "2.0");
      assert.equal(xApiKeyAuth.json?.id, 1);
      assert.equal(typeof xApiKeyAuth.json?.result?.protocolVersion, "string");

      const bearerAuth = await requestJson(`${base}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mcpApiKey}`,
        },
        body,
      });
      assert.equal(bearerAuth.status, 200);
      assert.equal(bearerAuth.json?.jsonrpc, "2.0");
      assert.equal(bearerAuth.json?.id, 1);
      assert.equal(typeof bearerAuth.json?.result?.protocolVersion, "string");
    }

    // /api/mcp initialize + tools/list + tools/call success/failure contracts
    {
      const listTools = await requestJson(`${base}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": hyperclawApiKey,
        },
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      });
      assert.equal(listTools.status, 200);
      assert.equal(Array.isArray(listTools.json?.result?.tools), true);
      assert.equal(
        listTools.json?.result?.tools?.some((tool) => tool.name === "hyperclaw_list_agents"),
        true
      );

      const callSuccess = await requestJson(`${base}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": hyperclawApiKey,
        },
        body: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "hyperclaw_list_agents",
            arguments: {},
          },
        },
      });
      assert.equal(callSuccess.status, 200);
      assert.equal(callSuccess.json?.result?.isError, false);
      assert.equal(Array.isArray(callSuccess.json?.result?.content), true);

      const callError = await requestJson(`${base}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": hyperclawApiKey,
        },
        body: {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "hyperclaw_agent_status",
            arguments: {},
          },
        },
      });
      assert.equal(callError.status, 200);
      assert.equal(callError.json?.result?.isError, true);
      assert.equal(typeof callError.json?.result?.content?.[0]?.text, "string");
    }

    // /api/ironclaw auth required
    {
      const noAuthGet = await requestJson(`${base}/api/ironclaw`);
      assert.equal(noAuthGet.status, 401);

      const noAuthPost = await requestJson(`${base}/api/ironclaw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { content: "hello" },
      });
      assert.equal(noAuthPost.status, 401);
    }

    // /api/ironclaw health proxy success/failure
    {
      mockState.health = "healthy";
      const healthOk = await requestJson(`${base}/api/ironclaw`, {
        headers: { "x-api-key": hyperclawApiKey },
      });
      assert.equal(healthOk.status, 200);
      assert.equal(healthOk.json?.configured, true);
      assert.equal(healthOk.json?.ironclaw, "healthy");

      mockState.health = "unhealthy";
      const healthFail = await requestJson(`${base}/api/ironclaw`, {
        headers: { "x-api-key": hyperclawApiKey },
      });
      assert.equal(healthFail.status, 503);
      assert.equal(healthFail.json?.configured, true);
      assert.equal(healthFail.json?.ironclaw, "unhealthy");
      mockState.health = "healthy";
    }

    // /api/ironclaw webhook proxy success/failure
    {
      const success = await requestJson(`${base}/api/ironclaw`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": hyperclawApiKey,
        },
        body: { content: "contract-test-message" },
      });
      assert.equal(success.status, 200);
      assert.equal(success.json?.status, "ok");
      assert.equal(typeof success.json?.message_id, "string");
      assert.equal(mockState.lastWebhookBody?.secret, webhookSecret);
      assert.equal(mockState.lastWebhookBody?.wait_for_response, true);

      const failure = await requestJson(`${base}/api/ironclaw`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": hyperclawApiKey,
        },
        body: { content: "force-fail" },
      });
      assert.equal(failure.status, 502);
      assert.equal(typeof failure.json?.error, "string");
      assert.equal(failure.json.error.includes("mock webhook failure"), true);
    }

    // /api/hclaw state + epoch close auth contracts
    {
      const stateRes = await requestJson(`${base}/api/hclaw/state`);
      assert.equal(stateRes.status, 200);
      assert.equal(typeof stateRes.json?.configured, "boolean");

      const closeNoAuth = await requestJson(`${base}/api/hclaw/epochs/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { activities: [] },
      });
      assert.equal(closeNoAuth.status, 401);

      const closeWrongAuth = await requestJson(`${base}/api/hclaw/epochs/close`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hclaw-close-key": "wrong-key",
        },
        body: { activities: [] },
      });
      assert.equal(closeWrongAuth.status, 401);

      const closeWithAuth = await requestJson(`${base}/api/hclaw/epochs/close`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hclaw-close-key": hclawCloseKey,
        },
        body: { activities: [] },
      });
      assert.equal(closeWithAuth.status, 200);
      assert.equal(closeWithAuth.json?.success, true);
      assert.equal(typeof closeWithAuth.json?.result?.epochId, "string");
    }

    log("All contracts passed.");
  } catch (error) {
    if (appLogs.trim()) {
      console.error("Captured hyperClaw logs (tail):");
      console.error(appLogs.slice(-6000));
    }
    throw error;
  } finally {
    mockServer.close();

    if (!app.killed) {
      app.kill("SIGTERM");
      const exited = Promise.race([
        once(app, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      await exited;
      if (app.exitCode === null) {
        app.kill("SIGKILL");
      }
    }
  }
}

run().catch((error) => {
  console.error("Contract test failed:", error);
  process.exit(1);
});
