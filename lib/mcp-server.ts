/**
 * HyperClaw MCP server implementation.
 *
 * Exposes fund-manager tools to IronClaw: list agents, lifecycle, positions,
 * market summary. Uses JSON-RPC 2.0 (initialize, tools/list, tools/call).
 */

import { getAgents, getAgent } from "@/lib/store";
import { getRunnerState, getAllRunnerStates } from "@/lib/agent-runner";
import {
  getLifecycleSummary,
  activateAgent,
  deactivateAgent,
  getLifecycleState,
  initializeAgentLifecycle,
  checkAllHealth,
  autoHealAgents,
  stopAllAgents,
  type LifecycleSummary,
} from "@/lib/agent-lifecycle";
import { fetchPositionsSnapshot } from "@/lib/watchers";
import {
  getEnrichedMarketData,
  getAllMids,
  getL2Book,
  getFundingHistory,
} from "@/lib/hyperliquid";
import type { Address } from "viem";

const PROTOCOL_VERSION = "2024-11-05";

export type McpRequest = {
  jsonrpc: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

export type McpResponse = {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type McpTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
};

const TOOLS: McpTool[] = [
  {
    name: "hyperclaw_list_agents",
    description:
      "List all HyperClaw trading agents with id, name, status, markets, and HL address. Use this to see which agents exist before querying status or positions.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "hyperclaw_agent_status",
    description:
      "Get detailed status for one agent: runner state (running, last tick, errors), lifecycle health, and config. Requires agent_id.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "HyperClaw agent ID" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "hyperclaw_lifecycle_summary",
    description:
      "Get lifecycle summary for all agents: total/active/running counts, health (healthy/degraded/unhealthy/stopped), and per-agent runner and AIP status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "hyperclaw_lifecycle_action",
    description:
      "Run a lifecycle action: activate or deactivate an agent, or init/health/heal/stop-all. Use activate to start trading runner; deactivate to stop.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Lifecycle action",
          enum: ["activate", "deactivate", "init", "health", "heal", "stop-all"],
        },
        agent_id: { type: "string", description: "Required for activate/deactivate" },
        tick_interval_ms: { type: "number", description: "Optional; tick interval in ms for activate" },
      },
      required: ["action"],
    },
  },
  {
    name: "hyperclaw_positions",
    description:
      "Get current Hyperliquid positions for one agent (by agent_id) or for all agents. Returns coin, size, entry price, unrealized PnL, leverage.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "If omitted, returns positions for all agents" },
      },
    },
  },
  {
    name: "hyperclaw_market_summary",
    description:
      "Get market summary: mid prices (mids), enriched market data (funding, OI), or L2 book / funding for a single coin. Use for strategy context.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "What to fetch",
          enum: ["mids", "markets-enriched", "book", "funding"],
        },
        coin: { type: "string", description: "Required for book and funding (e.g. BTC, ETH)" },
      },
      required: ["action"],
    },
  },
];

function textContent(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

export async function handleMcpRequest(req: McpRequest): Promise<McpResponse> {
  const { id, method, params = {} } = req;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "hyperclaw-mcp",
          version: "0.1.0",
        },
        instructions:
          "HyperClaw fund manager: agents, lifecycle, positions, market. Use with IronClaw for holistic agent strategy and monitoring.",
      },
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    };
  }

  if (method === "tools/call") {
    const name = params.name as string | undefined;
    const args = (params.arguments as Record<string, unknown>) ?? {};
    if (!name) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "tools/call requires name" },
      };
    }

    try {
      const out = await callTool(name, args);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [textContent(typeof out === "string" ? out : JSON.stringify(out, null, 2))],
          is_error: false,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [textContent(message)],
          is_error: true,
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<string | Record<string, unknown>> {
  switch (name) {
    case "hyperclaw_list_agents": {
      const agents = await getAgents();
      return {
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          markets: a.markets,
          hlAddress: a.hlAddress,
          riskLevel: a.riskLevel,
          autonomy: a.autonomy?.mode,
        })),
      };
    }

    case "hyperclaw_agent_status": {
      const agentId = args.agent_id as string;
      if (!agentId) throw new Error("agent_id required");
      const agent = await getAgent(agentId);
      if (!agent) throw new Error(`Agent ${agentId} not found`);
      const runner = getRunnerState(agentId);
      const lifecycle = getLifecycleState(agentId);
      return {
        agent: {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          markets: agent.markets,
          hlAddress: agent.hlAddress,
          riskLevel: agent.riskLevel,
          autonomy: agent.autonomy,
        },
        runner: runner
          ? {
              isRunning: runner.isRunning,
              lastTickAt: runner.lastTickAt,
              nextTickAt: runner.nextTickAt,
              tickCount: runner.tickCount,
              intervalMs: runner.intervalMs,
              errors: runner.errors.slice(-5),
            }
          : null,
        lifecycle: lifecycle
          ? { healthStatus: lifecycle.healthStatus, aipRegistered: lifecycle.aipRegistered }
          : null,
      };
    }

    case "hyperclaw_lifecycle_summary": {
      const summary = await getLifecycleSummary();
      return serializeLifecycleSummary(summary);
    }

    case "hyperclaw_lifecycle_action": {
      const action = args.action as string;
      const agentId = args.agent_id as string | undefined;
      const tickIntervalMs = args.tick_interval_ms as number | undefined;

      switch (action) {
        case "activate":
          if (!agentId) throw new Error("agent_id required for activate");
          const actState = await activateAgent(agentId, { tickIntervalMs });
          return { success: true, message: `Activated ${agentId}`, state: actState };
        case "deactivate":
          if (!agentId) throw new Error("agent_id required for deactivate");
          await deactivateAgent(agentId);
          return { success: true, message: `Deactivated ${agentId}` };
        case "init": {
          await initializeAgentLifecycle();
          const initSummary = await getLifecycleSummary();
          return { success: true, summary: serializeLifecycleSummary(initSummary) };
        }
        case "health": {
          const healthMap = await checkAllHealth();
          const health: Record<string, unknown> = {};
          healthMap.forEach((s, id) => {
            health[id] = s;
          });
          return { success: true, health };
        }
        case "heal": {
          const { healed, failed } = await autoHealAgents();
          return { success: true, healed, failed };
        }
        case "stop-all":
          await stopAllAgents();
          return { success: true, message: "All agents stopped" };
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }

    case "hyperclaw_positions": {
      const agentId = args.agent_id as string | undefined;
      const agents = await getAgents();
      const single = agentId ? await getAgent(agentId) : null;
      const toFetch = single ? [single] : agentId ? [] : agents;
      const results: Record<string, unknown> = {};
      for (const a of toFetch) {
        if (!a?.hlAddress) continue;
        try {
          const positions = await fetchPositionsSnapshot(a.hlAddress as Address);
          results[a.id] = {
            agentName: a.name,
            hlAddress: a.hlAddress,
            positions: positions.map((p) => ({
              coin: p.coin,
              size: p.size,
              entryPrice: p.entryPrice,
              positionValue: p.positionValue,
              unrealizedPnl: p.unrealizedPnl,
              unrealizedPnlPercent: p.unrealizedPnlPercent,
              leverage: p.leverage,
              side: p.side,
            })),
          };
        } catch (e) {
          results[a.id] = {
            agentName: a.name,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }
      return results;
    }

    case "hyperclaw_market_summary": {
      const action = args.action as string;
      const coin = args.coin as string | undefined;
      if ((action === "book" || action === "funding") && !coin)
        throw new Error("coin required for book and funding");
      switch (action) {
        case "mids": {
          const mids = await getAllMids();
          return { mids };
        }
        case "markets-enriched": {
          const markets = await getEnrichedMarketData();
          return { markets };
        }
        case "book": {
          const book = await getL2Book(coin!);
          return { coin, book };
        }
        case "funding": {
          const startTime = Date.now() - 24 * 60 * 60 * 1000;
          const funding = await getFundingHistory(coin!, startTime);
          return { coin, funding };
        }
        default:
          throw new Error(`Unknown action: ${action}. Use: mids, markets-enriched, book, funding`);
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function serializeLifecycleSummary(s: LifecycleSummary): Record<string, unknown> {
  return {
    totalAgents: s.totalAgents,
    activeAgents: s.activeAgents,
    runningRunners: s.runningRunners,
    registeredWithAIP: s.registeredWithAIP,
    healthy: s.healthy,
    degraded: s.degraded,
    unhealthy: s.unhealthy,
    stopped: s.stopped,
    agents: s.agents,
  };
}
