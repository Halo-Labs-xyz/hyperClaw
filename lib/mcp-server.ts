/**
 * HyperClaw MCP server implementation.
 *
 * Exposes fund-manager tools to IronClaw: list agents, lifecycle, positions,
 * market summary. Uses JSON-RPC 2.0 (initialize, tools/list, tools/call).
 */

import { getAgents, getAgent, getRecentTrades } from "@/lib/store";
import { getRunnerState } from "@/lib/agent-runner";
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
  getAgentHlState,
} from "@/lib/hyperliquid";
import type { Agent, TradeLog } from "@/lib/types";
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
    name: "hyperclaw_exposure",
    description:
      "Portfolio exposure for one agent or all agents: gross/net notional by coin, long/short split, equity, margin, and leverage proxy. Core workflow for 'What's my exposure?'.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Optional agent id or name. Omit to get exposure across the full portfolio.",
        },
        include_positions: {
          type: "boolean",
          description: "Include raw position rows per agent (default: true).",
        },
      },
    },
  },
  {
    name: "hyperclaw_pause_agent",
    description:
      "Pause one agent by id or name. Stops runner/lifecycle and leaves status as paused. Core workflow for 'Pause agent X'.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent id or name (case-insensitive)." },
        dry_run: { type: "boolean", description: "Validate target and show effect without pausing." },
      },
      required: ["agent"],
    },
  },
  {
    name: "hyperclaw_daily_trade_summary",
    description:
      "Daily trade summary with anomaly detection (reject spikes, leverage breaches, concentration, burst trading). Core workflow for 'Daily trade summary + anomalies'.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Optional agent id or name to scope summary." },
        window_hours: {
          type: "number",
          description: "Summary lookback window in hours (default: 24, min: 1, max: 168).",
        },
        max_trades: {
          type: "number",
          description: "Max recent trades to read before filtering by window (default: 2000, max: 5000).",
        },
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

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = toFiniteNumber(value);
  if (n === 0 && value !== 0 && value !== "0") return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

async function resolveAgentReference(reference: string): Promise<Agent> {
  const normalized = reference.trim().toLowerCase();
  if (!normalized) throw new Error("agent reference is empty");

  const agents = await getAgents();
  if (agents.length === 0) throw new Error("No agents found");

  const idExact = agents.find((a) => a.id === reference.trim());
  if (idExact) return idExact;

  const nameExact = agents.filter((a) => a.name.trim().toLowerCase() === normalized);
  if (nameExact.length === 1) return nameExact[0];
  if (nameExact.length > 1) {
    throw new Error(
      `Ambiguous agent "${reference}". Exact-name matches: ${nameExact
        .slice(0, 5)
        .map((a) => `${a.name} (${a.id})`)
        .join(", ")}`
    );
  }

  const fuzzy = agents.filter(
    (a) => a.id.toLowerCase().startsWith(normalized) || a.name.toLowerCase().includes(normalized)
  );
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(
      `Ambiguous agent "${reference}". Matches: ${fuzzy
        .slice(0, 5)
        .map((a) => `${a.name} (${a.id})`)
        .join(", ")}`
    );
  }

  throw new Error(`Agent "${reference}" not found`);
}

async function buildExposureReport(
  scopeAgents: Agent[],
  includePositions: boolean
): Promise<Record<string, unknown>> {
  type CoinAccumulator = {
    coin: string;
    longNotionalUsd: number;
    shortNotionalUsd: number;
    netNotionalUsd: number;
    grossNotionalUsd: number;
    unrealizedPnlUsd: number;
    marginUsedUsd: number;
    agentIds: Set<string>;
  };

  const coinExposure = new Map<string, CoinAccumulator>();
  const warnings: string[] = [];
  const agentRows: Array<Record<string, unknown>> = [];

  let totalAccountValueUsd = 0;
  let totalAvailableBalanceUsd = 0;
  let totalMarginUsedUsd = 0;
  let totalGrossExposureUsd = 0;
  let totalNetExposureUsd = 0;
  let totalUnrealizedPnlUsd = 0;

  for (const agent of scopeAgents) {
    const state = await getAgentHlState(agent.id);
    if (!state) {
      warnings.push(`Agent ${agent.name} (${agent.id}) has no Hyperliquid wallet configured.`);
      agentRows.push({
        agentId: agent.id,
        agentName: agent.name,
        status: agent.status,
        hasWallet: false,
      });
      continue;
    }

    const accountValueUsd = toFiniteNumber(state.accountValue);
    const availableBalanceUsd = toFiniteNumber(state.availableBalance);
    const marginUsedUsd = toFiniteNumber(state.marginUsed);
    const unrealizedPnlUsd = toFiniteNumber(state.totalUnrealizedPnl);

    let agentGrossExposureUsd = 0;
    let agentNetExposureUsd = 0;

    const positionRows: Array<Record<string, unknown>> = [];
    for (const position of state.positions) {
      const notionalUsd = toFiniteNumber(position.positionValue);
      const signedNotional = position.side === "long" ? notionalUsd : -notionalUsd;

      agentGrossExposureUsd += notionalUsd;
      agentNetExposureUsd += signedNotional;

      const bucket =
        coinExposure.get(position.coin) ??
        (() => {
          const fresh: CoinAccumulator = {
            coin: position.coin,
            longNotionalUsd: 0,
            shortNotionalUsd: 0,
            netNotionalUsd: 0,
            grossNotionalUsd: 0,
            unrealizedPnlUsd: 0,
            marginUsedUsd: 0,
            agentIds: new Set<string>(),
          };
          coinExposure.set(position.coin, fresh);
          return fresh;
        })();

      if (position.side === "long") {
        bucket.longNotionalUsd += notionalUsd;
      } else {
        bucket.shortNotionalUsd += notionalUsd;
      }
      bucket.netNotionalUsd += signedNotional;
      bucket.grossNotionalUsd += notionalUsd;
      bucket.unrealizedPnlUsd += toFiniteNumber(position.unrealizedPnl);
      bucket.marginUsedUsd += toFiniteNumber(position.marginUsed);
      bucket.agentIds.add(agent.id);

      if (includePositions) {
        positionRows.push({
          coin: position.coin,
          side: position.side,
          size: position.size,
          markPrice: position.markPrice,
          notionalUsd,
          unrealizedPnlUsd: toFiniteNumber(position.unrealizedPnl),
          leverage: position.leverage,
          liquidationPrice: position.liquidationPrice,
        });
      }
    }

    totalAccountValueUsd += accountValueUsd;
    totalAvailableBalanceUsd += availableBalanceUsd;
    totalMarginUsedUsd += marginUsedUsd;
    totalGrossExposureUsd += agentGrossExposureUsd;
    totalNetExposureUsd += agentNetExposureUsd;
    totalUnrealizedPnlUsd += unrealizedPnlUsd;

    const row: Record<string, unknown> = {
      agentId: agent.id,
      agentName: agent.name,
      status: agent.status,
      hasWallet: true,
      address: state.address,
      accountValueUsd,
      availableBalanceUsd,
      marginUsedUsd,
      grossExposureUsd: agentGrossExposureUsd,
      netExposureUsd: agentNetExposureUsd,
      unrealizedPnlUsd,
      positionCount: state.positions.length,
    };
    if (includePositions) row.positions = positionRows;
    agentRows.push(row);
  }

  const byCoin = Array.from(coinExposure.values())
    .map((bucket) => ({
      coin: bucket.coin,
      longNotionalUsd: bucket.longNotionalUsd,
      shortNotionalUsd: bucket.shortNotionalUsd,
      netNotionalUsd: bucket.netNotionalUsd,
      grossNotionalUsd: bucket.grossNotionalUsd,
      unrealizedPnlUsd: bucket.unrealizedPnlUsd,
      marginUsedUsd: bucket.marginUsedUsd,
      agentCount: bucket.agentIds.size,
      exposureShare: totalGrossExposureUsd > 0 ? bucket.grossNotionalUsd / totalGrossExposureUsd : 0,
    }))
    .sort((a, b) => b.grossNotionalUsd - a.grossNotionalUsd);

  const topCoin = byCoin[0] ?? null;

  return {
    generatedAt: new Date().toISOString(),
    scope: scopeAgents.length === 1 ? "agent" : "portfolio",
    agentCount: scopeAgents.length,
    totals: {
      accountValueUsd: totalAccountValueUsd,
      availableBalanceUsd: totalAvailableBalanceUsd,
      marginUsedUsd: totalMarginUsedUsd,
      grossExposureUsd: totalGrossExposureUsd,
      netExposureUsd: totalNetExposureUsd,
      netBias: totalNetExposureUsd >= 0 ? "long" : "short",
      exposureToEquity: totalAccountValueUsd > 0 ? totalGrossExposureUsd / totalAccountValueUsd : 0,
      unrealizedPnlUsd: totalUnrealizedPnlUsd,
    },
    topCoin,
    byCoin,
    agents: agentRows,
    warnings,
  };
}

async function buildDailyTradeSummary(
  scopeAgent: Agent | null,
  windowHours: number,
  maxTradesRead: number
): Promise<Record<string, unknown>> {
  type AgentStats = {
    agentId: string;
    agentName: string;
    status: Agent["status"] | "unknown";
    decisions: number;
    attempted: number;
    executed: number;
    holds: number;
    rejected: number;
    partial: number;
    filled: number;
    executedNotionalUsd: number;
    confidenceSamples: number[];
    maxLeverageUsed: number;
    assetCounts: Map<string, number>;
  };

  const now = Date.now();
  const periodStart = now - windowHours * 60 * 60 * 1000;

  const [agents, recentTrades] = await Promise.all([getAgents(), getRecentTrades(maxTradesRead)]);
  const agentById = new Map<string, Agent>(agents.map((a) => [a.id, a]));

  const trades = recentTrades
    .filter(
      (t) =>
        t.timestamp >= periodStart &&
        (!scopeAgent || t.agentId === scopeAgent.id)
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  const attemptActions = new Set<TradeLog["decision"]["action"]>(["long", "short", "close"]);
  const byAgent = new Map<string, AgentStats>();
  const assetCounts = new Map<string, number>();
  const attemptAssetCounts = new Map<string, number>();
  const confidenceValues: number[] = [];
  const lowConfidenceExecutions: TradeLog[] = [];
  const leverageBreaches: Array<{
    tradeId: string;
    agentId: string;
    agentName: string;
    requested: number;
    maxAllowed: number;
  }> = [];
  const oversizedSignals: Array<{
    tradeId: string;
    agentId: string;
    agentName: string;
    sizePct: number;
  }> = [];

  let attempted = 0;
  let executed = 0;
  let holds = 0;
  let rejected = 0;
  let partial = 0;
  let filled = 0;
  let executedNotionalUsd = 0;

  const ensureAgentStats = (agentId: string): AgentStats => {
    const existing = byAgent.get(agentId);
    if (existing) return existing;
    const agent = agentById.get(agentId);
    const created: AgentStats = {
      agentId,
      agentName: agent?.name || agentId,
      status: agent?.status || "unknown",
      decisions: 0,
      attempted: 0,
      executed: 0,
      holds: 0,
      rejected: 0,
      partial: 0,
      filled: 0,
      executedNotionalUsd: 0,
      confidenceSamples: [],
      maxLeverageUsed: 0,
      assetCounts: new Map<string, number>(),
    };
    byAgent.set(agentId, created);
    return created;
  };

  for (const trade of trades) {
    const stats = ensureAgentStats(trade.agentId);
    const action = trade.decision.action;
    const isAttempt = attemptActions.has(action);
    const asset = trade.decision.asset?.toUpperCase() || "UNKNOWN";
    const confidence = toFiniteNumber(trade.decision.confidence);
    const leverage = toFiniteNumber(trade.decision.leverage);

    stats.decisions += 1;
    stats.maxLeverageUsed = Math.max(stats.maxLeverageUsed, leverage);

    stats.assetCounts.set(asset, (stats.assetCounts.get(asset) || 0) + 1);
    assetCounts.set(asset, (assetCounts.get(asset) || 0) + 1);

    if (isAttempt) {
      attempted += 1;
      stats.attempted += 1;
      confidenceValues.push(confidence);
      stats.confidenceSamples.push(confidence);
      attemptAssetCounts.set(asset, (attemptAssetCounts.get(asset) || 0) + 1);
    } else {
      holds += 1;
      stats.holds += 1;
    }

    if (trade.executed) {
      executed += 1;
      stats.executed += 1;

      if (confidence < 0.55) lowConfidenceExecutions.push(trade);
    }

    const fillStatus = trade.executionResult?.status;
    if (fillStatus === "rejected") {
      rejected += 1;
      stats.rejected += 1;
    } else if (fillStatus === "partial") {
      partial += 1;
      stats.partial += 1;
    } else if (fillStatus === "filled") {
      filled += 1;
      stats.filled += 1;
    }

    const fillPrice = toFiniteNumber(trade.executionResult?.fillPrice);
    const fillSize = toFiniteNumber(trade.executionResult?.fillSize);
    if (fillPrice > 0 && fillSize > 0) {
      const tradeNotional = fillPrice * fillSize;
      executedNotionalUsd += tradeNotional;
      stats.executedNotionalUsd += tradeNotional;
    }

    if (isAttempt && toFiniteNumber(trade.decision.size) > 75) {
      oversizedSignals.push({
        tradeId: trade.id,
        agentId: trade.agentId,
        agentName: stats.agentName,
        sizePct: toFiniteNumber(trade.decision.size),
      });
    }

    const agent = agentById.get(trade.agentId);
    if (isAttempt && agent && leverage > agent.maxLeverage) {
      leverageBreaches.push({
        tradeId: trade.id,
        agentId: trade.agentId,
        agentName: agent.name,
        requested: leverage,
        maxAllowed: agent.maxLeverage,
      });
    }
  }

  const topAssets = Array.from(attemptAssetCounts.entries())
    .map(([asset, count]) => ({
      asset,
      count,
      share: attempted > 0 ? count / attempted : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const byAgentSummary = Array.from(byAgent.values())
    .map((stats) => {
      const topAsset = Array.from(stats.assetCounts.entries())
        .sort((a, b) => b[1] - a[1])[0];
      return {
        agentId: stats.agentId,
        agentName: stats.agentName,
        status: stats.status,
        decisions: stats.decisions,
        attempted: stats.attempted,
        executed: stats.executed,
        holds: stats.holds,
        rejected: stats.rejected,
        partial: stats.partial,
        filled: stats.filled,
        executedNotionalUsd: stats.executedNotionalUsd,
        avgConfidence: average(stats.confidenceSamples),
        maxLeverageUsed: stats.maxLeverageUsed,
        topAsset: topAsset ? topAsset[0] : null,
      };
    })
    .sort((a, b) => b.executed - a.executed);

  const anomalies: Array<Record<string, unknown>> = [];

  if (attempted > 0) {
    const rejectionRate = rejected / attempted;
    if (rejected >= 2 && rejectionRate >= 0.25) {
      anomalies.push({
        code: "rejection_spike",
        severity: rejectionRate >= 0.5 ? "critical" : "warning",
        message: `${rejected} of ${attempted} trade attempts were rejected.`,
        rejectionRate,
      });
    }
  }

  const topAsset = topAssets[0];
  if (topAsset && attempted >= 5 && topAsset.share >= 0.65) {
    anomalies.push({
      code: "asset_concentration",
      severity: "warning",
      message: `${topAsset.asset} accounts for ${(topAsset.share * 100).toFixed(1)}% of trade attempts.`,
      asset: topAsset.asset,
      share: topAsset.share,
    });
  }

  if (lowConfidenceExecutions.length >= 2) {
    anomalies.push({
      code: "low_confidence_execution",
      severity: "warning",
      message: `${lowConfidenceExecutions.length} trades executed with confidence below 0.55.`,
      count: lowConfidenceExecutions.length,
    });
  }

  if (leverageBreaches.length > 0) {
    anomalies.push({
      code: "leverage_breach",
      severity: "critical",
      message: `${leverageBreaches.length} decisions requested leverage above agent limits.`,
      samples: leverageBreaches.slice(0, 5),
    });
  }

  if (oversizedSignals.length >= 2) {
    anomalies.push({
      code: "oversized_position_signal",
      severity: "warning",
      message: `${oversizedSignals.length} signals requested position size above 75% of capital.`,
      samples: oversizedSignals.slice(0, 5),
    });
  }

  const burstAgents = byAgentSummary
    .map((stats) => {
      const agent = agentById.get(stats.agentId);
      const maxTradesPerDay = agent?.autonomy?.maxTradesPerDay;
      if (!maxTradesPerDay || maxTradesPerDay <= 0) return null;
      if (stats.executed > maxTradesPerDay) {
        return {
          agentId: stats.agentId,
          agentName: stats.agentName,
          executed: stats.executed,
          maxTradesPerDay,
        };
      }
      return null;
    })
    .filter((a): a is NonNullable<typeof a> => !!a);

  if (burstAgents.length > 0) {
    anomalies.push({
      code: "burst_trading",
      severity: "warning",
      message: `${burstAgents.length} agent(s) exceeded configured maxTradesPerDay.`,
      agents: burstAgents,
    });
  }

  if (trades.length === 0) {
    anomalies.push({
      code: "no_trades",
      severity: "info",
      message: "No trades found in the selected window.",
    });
  }

  return {
    generatedAt: new Date(now).toISOString(),
    windowHours,
    periodStart: new Date(periodStart).toISOString(),
    periodEnd: new Date(now).toISOString(),
    scope: scopeAgent
      ? { type: "agent", agentId: scopeAgent.id, agentName: scopeAgent.name }
      : { type: "portfolio" },
    tradeCount: trades.length,
    totals: {
      decisions: trades.length,
      attempted,
      executed,
      holds,
      rejected,
      partial,
      filled,
      executedNotionalUsd,
      avgConfidence: average(confidenceValues),
      rejectionRate: attempted > 0 ? rejected / attempted : 0,
    },
    topAssets,
    byAgent: byAgentSummary,
    anomalies,
  };
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
          isError: false,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [textContent(message)],
          isError: true,
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

    case "hyperclaw_exposure": {
      const agentReference = typeof args.agent === "string" ? args.agent.trim() : "";
      const includePositions = args.include_positions !== false;
      const scope = agentReference
        ? [await resolveAgentReference(agentReference)]
        : await getAgents();
      return buildExposureReport(scope, includePositions);
    }

    case "hyperclaw_pause_agent": {
      const reference = typeof args.agent === "string" ? args.agent : "";
      if (!reference.trim()) throw new Error("agent is required");

      const dryRun = args.dry_run === true;
      const target = await resolveAgentReference(reference);
      const beforeRunner = getRunnerState(target.id);
      const beforeLifecycle = getLifecycleState(target.id);

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          target: {
            agentId: target.id,
            agentName: target.name,
            status: target.status,
          },
          wouldPause: target.status === "active" || beforeRunner?.isRunning === true,
        };
      }

      const needsPause = target.status === "active" || beforeRunner?.isRunning === true;
      if (needsPause) {
        await deactivateAgent(target.id);
      }

      const updated = await getAgent(target.id);
      const afterRunner = getRunnerState(target.id);
      const afterLifecycle = getLifecycleState(target.id);

      return {
        success: true,
        changed: needsPause,
        message: needsPause
          ? `Paused ${target.name} (${target.id})`
          : `${target.name} (${target.id}) already paused/stopped`,
        agent: {
          agentId: target.id,
          agentName: updated?.name || target.name,
          status: updated?.status || target.status,
        },
        runner: {
          before: beforeRunner
            ? { isRunning: beforeRunner.isRunning, tickCount: beforeRunner.tickCount }
            : null,
          after: afterRunner
            ? { isRunning: afterRunner.isRunning, tickCount: afterRunner.tickCount }
            : null,
        },
        lifecycle: {
          before: beforeLifecycle
            ? {
                healthStatus: beforeLifecycle.healthStatus,
                aipRegistered: beforeLifecycle.aipRegistered,
              }
            : null,
          after: afterLifecycle
            ? {
                healthStatus: afterLifecycle.healthStatus,
                aipRegistered: afterLifecycle.aipRegistered,
              }
            : null,
        },
      };
    }

    case "hyperclaw_daily_trade_summary": {
      const windowHours = clampNumber(args.window_hours, 24, 1, 168);
      const maxTradesRead = clampNumber(args.max_trades, 2000, 50, 5000);
      const agentReference = typeof args.agent === "string" ? args.agent.trim() : "";
      const scopedAgent = agentReference ? await resolveAgentReference(agentReference) : null;
      return buildDailyTradeSummary(scopedAgent, windowHours, maxTradesRead);
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
