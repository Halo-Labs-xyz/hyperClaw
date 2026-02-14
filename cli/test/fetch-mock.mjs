import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

function loadState(path) {
  if (!path) throw new Error("HC_MOCK_STATE_PATH required");
  if (!existsSync(path)) {
    const initial = {
      agents: [
        {
          id: "a1b2c3d4e5f60000000000000000000000000000000000000000000000000000",
          name: "Alpha",
          description: "mock agent",
          status: "active",
          markets: ["BTC", "ETH"],
          riskLevel: "moderate",
          maxLeverage: 5,
          autonomy: { mode: "semi", aggressiveness: 50, maxTradesPerDay: 10, approvalTimeoutMs: 300000 },
          stopLossPercent: 5,
          hlAddress: "0x0000000000000000000000000000000000000001",
          vaultTvlUsd: 1000,
        },
      ],
      chat: {}, // agentId -> messages[]
      runner: {}, // agentId -> runner state
    };
    writeFileSync(path, JSON.stringify(initial, null, 2));
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveState(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function notFound() {
  return jsonResponse(404, { error: "not_found" });
}

globalThis.fetch = async (input, init = {}) => {
  const statePath = process.env.HC_MOCK_STATE_PATH;
  const state = loadState(statePath);

  const urlStr = typeof input === "string" ? input : input?.url;
  const url = new URL(urlStr);
  const path = url.pathname;
  const method = String(init.method || "GET").toUpperCase();

  let body = null;
  if (init.body) {
    try {
      body = JSON.parse(String(init.body));
    } catch {
      body = null;
    }
  }

  // Basic endpoints used by CLI
  if (method === "GET" && path === "/api/health") {
    return jsonResponse(200, { healthy: true, timestamp: Date.now(), bootstrap: { mock: true } });
  }

  if (method === "GET" && path === "/api/market") {
    if (url.searchParams.get("action") === "all-markets") {
      return jsonResponse(200, {
        perps: [
          { name: "BTC", isDelisted: false },
          { name: "ETH", isDelisted: false },
          { name: "SOL", isDelisted: false },
        ],
      });
    }
    return jsonResponse(400, { error: "bad_request" });
  }

  if (method === "GET" && path === "/api/agents") {
    const view = url.searchParams.get("view") || "full";
    const scope = url.searchParams.get("scope") || "all";
    let agents = state.agents.slice();
    if (view === "explore") {
      agents = agents.filter((a) => a.status === "active");
      if (scope === "owned") agents = [];
      return jsonResponse(200, {
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          status: a.status,
          markets: a.markets,
          riskLevel: a.riskLevel,
          vaultTvlUsd: a.vaultTvlUsd,
        })),
      });
    }
    return jsonResponse(200, { agents });
  }

  if (method === "POST" && path === "/api/agents") {
    if (!body?.name || !Array.isArray(body?.markets) || body.markets.length === 0) {
      return jsonResponse(400, { error: "name and markets are required" });
    }
    const id = randomBytes(32).toString("hex");
    const agent = {
      id,
      name: String(body.name),
      description: String(body.description || ""),
      status: "paused",
      markets: body.markets,
      riskLevel: body.riskLevel || "moderate",
      maxLeverage: body.maxLeverage || 5,
      autonomy: body.autonomy || { mode: "semi", aggressiveness: 50, maxTradesPerDay: 10, approvalTimeoutMs: 300000 },
      stopLossPercent: body.stopLossPercent || 5,
      hlAddress: "0x0000000000000000000000000000000000000002",
      vaultTvlUsd: 0,
    };
    state.agents.push(agent);
    saveState(statePath, state);
    return jsonResponse(201, { agent, attestation: null });
  }

  if (method === "GET" && path === "/api/agents/orchestrator") {
    const active = state.agents.filter((a) => a.status === "active").map((a) => ({
      id: a.id,
      name: a.name,
      tickIntervalMinMs: 1800000,
      tickIntervalMaxMs: 3600000,
    }));
    return jsonResponse(200, { agents: active, schedule: { tickIntervalMinMs: 1800000, tickIntervalMaxMs: 3600000 } });
  }

  const m = path.match(/^\/api\/agents\/([^/]+)(?:\/(.*))?$/);
  if (m) {
    const agentId = m[1];
    const suffix = m[2] || "";
    const agent = state.agents.find((a) => a.id === agentId);

    if (suffix === "" && method === "GET") {
      if (!agent) return jsonResponse(404, { error: "Agent not found" });
      return jsonResponse(200, { agent, trades: [], lifecycle: { isRunning: false, lastTickAt: null } });
    }

    if (suffix === "tick" && method === "POST") {
      if (!agent) return jsonResponse(404, { error: "Agent not found" });
      const action = body?.action || "tick";
      if (action === "tick") {
        const decision = { action: "hold", asset: "BTC", size: 0, leverage: 1, confidence: 0.5, reasoning: "mock" };
        const tradeLog = { id: randomBytes(8).toString("hex"), agentId, timestamp: Date.now(), decision, executed: false };
        return jsonResponse(200, { decision, executed: false, executionResult: null, tradeLog });
      }
      if (action === "status") {
        const s = state.runner[agentId] || { isRunning: false, intervalMs: 1800000, lastTickAt: null, nextTickAt: null, tickCount: 0, errors: [] };
        return jsonResponse(200, { running: Boolean(s.isRunning), state: s });
      }
      if (action === "start") {
        const intervalMs = Number.isFinite(body?.intervalMs) ? body.intervalMs : 1800000;
        const now = Date.now();
        const s = { isRunning: true, intervalMs, lastTickAt: now, nextTickAt: now + intervalMs, tickCount: 1, errors: [] };
        state.runner[agentId] = s;
        saveState(statePath, state);
        return jsonResponse(200, { success: true, message: "started", state: s });
      }
      if (action === "stop") {
        const prev = state.runner[agentId] || { isRunning: false };
        state.runner[agentId] = { ...prev, isRunning: false, nextTickAt: null };
        saveState(statePath, state);
        return jsonResponse(200, { success: true, message: "stopped" });
      }
      return jsonResponse(400, { error: "Unknown action" });
    }

    if (suffix === "approve" && method === "POST") {
      if (!agent) return jsonResponse(404, { error: "Agent not found" });
      if (!body?.approvalId || !body?.action) return jsonResponse(400, { error: "approvalId and action are required" });
      return jsonResponse(200, { success: true, message: `Trade ${body.action}d` });
    }

    if (suffix === "chat" && method === "GET") {
      if (!agent) return jsonResponse(404, { error: "Agent not found" });
      const limit = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
      const msgs = state.chat[agentId] || [];
      return jsonResponse(200, { messages: msgs.slice(-limit) });
    }

    if (suffix === "chat" && method === "POST") {
      if (!agent) return jsonResponse(404, { error: "Agent not found" });
      const content = String(body?.content || "").trim();
      if (!content) return jsonResponse(400, { error: "Message content is required" });
      const msg = {
        id: randomBytes(8).toString("hex"),
        agentId,
        timestamp: Date.now(),
        sender: "investor",
        senderName: body?.senderName || "CLI",
        type: body?.type || "discussion",
        content,
      };
      state.chat[agentId] = state.chat[agentId] || [];
      state.chat[agentId].push(msg);
      saveState(statePath, state);
      const aiResponse = content.endsWith("?") ? "mock answer" : undefined;
      return jsonResponse(200, { success: true, message: msg, aiResponse });
    }
  }

  if (method === "POST" && path === "/api/fund") {
    const action = body?.action;
    if (action === "status") {
      return jsonResponse(200, { network: "mainnet", configured: true, vaultAddress: "0x00000000000000000000000000000000000000aa" });
    }
    if (action === "agent-balance") {
      return jsonResponse(200, {
        hasWallet: true,
        accountValue: "$1000.00",
        availableBalance: "$900.00",
        marginUsed: "$100.00",
        totalPnl: 12.34,
        openPositions: 1,
      });
    }
    if (action === "agent-state") {
      return jsonResponse(200, { positions: [{ coin: "BTC", side: "long", szi: 0.1, entryPx: 50000 }] });
    }
    if (action === "provision") {
      return jsonResponse(200, {
        hlAddress: "0x00000000000000000000000000000000000000bb",
        fundedAmount: body?.amount ?? 100,
        network: "mainnet",
        lifecycle: { isRunning: true },
      });
    }
    if (action === "activate") {
      return jsonResponse(200, { lifecycle: { isRunning: true } });
    }
    return jsonResponse(400, { error: "unknown_fund_action" });
  }

  if (method === "GET" && path === "/api/deposit") {
    return jsonResponse(200, { tvlUsd: 1234, deposits: [] });
  }

  if (method === "POST" && path === "/api/deposit") {
    return jsonResponse(200, {
      eventType: "deposit",
      deposit: {
        agentId: state.agents[0]?.id,
        amount: "1.0",
        token: "MON",
        usdValue: 10,
        hlFunded: true,
        txHash: body?.txHash,
      },
    });
  }

  if (method === "GET" && path === "/api/ironclaw") {
    return jsonResponse(200, { configured: true, ironclaw: "ok" });
  }

  if (method === "POST" && path === "/api/ironclaw") {
    return jsonResponse(200, { response: `echo: ${String(body?.content || "")}` });
  }

  return notFound();
};
