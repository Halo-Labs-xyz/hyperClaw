/**
 * Agent Runner
 *
 * Autonomous agent execution loop. Replaces manual tick model.
 * Each agent runs on its own interval, fetching data, calling AI,
 * and executing the full order pipeline (entry + SL + TP).
 *
 * Mirrors the automation philosophy of the Hyperliquid CLI but
 * runs server-side with full orchestration.
 */

import {
  getAgent,
  updateAgent,
  appendTradeLog,
  clearPendingApproval,
  getTradeLogsForAgent,
} from "./store";
import { getTradeDecision } from "./ai";
import {
  getEnrichedMarketData,
  getAccountState,
  executeOrder,
  updateLeverage,
  getAssetIndex,
  getExchangeClientForAgent,
  getExchangeClientForPKP,
  getHistoricalPrices,
} from "./hyperliquid";
import { getPrivateKeyForAgent } from "./account-manager";
import type { TradeLog, AgentRunnerState, PlaceOrderParams } from "./types";
import { randomBytes } from "crypto";
import { getAgentTradeMeta, recordAgentExecutedTrade, recordAgentForceAttempt } from "./trade-meta";

// ============================================
// Runner State
// ============================================

type RunnerGlobals = {
  runnerStates: Map<string, AgentRunnerState>;
  runnerIntervals: Map<string, ReturnType<typeof setInterval>>;
  consecutiveFailures: Map<string, number>;
  inFlightTicks: Map<string, Promise<TradeLog>>;
  decisionCadence: Map<string, { lastDecisionAtMs: number; lastThrottleLogAtMs: number }>;
};

const runnerGlobals = (globalThis as typeof globalThis & {
  __hyperclawRunnerGlobals?: RunnerGlobals;
}).__hyperclawRunnerGlobals ??= {
  runnerStates: new Map<string, AgentRunnerState>(),
  runnerIntervals: new Map<string, ReturnType<typeof setInterval>>(),
  consecutiveFailures: new Map<string, number>(),
  inFlightTicks: new Map<string, Promise<TradeLog>>(),
  decisionCadence: new Map<string, { lastDecisionAtMs: number; lastThrottleLogAtMs: number }>(),
};

const runnerStates = runnerGlobals.runnerStates;
const runnerIntervals = runnerGlobals.runnerIntervals;
const consecutiveFailures = runnerGlobals.consecutiveFailures;
const inFlightTicks = runnerGlobals.inFlightTicks;
const decisionCadence = runnerGlobals.decisionCadence;

const HL_HISTORY_FETCH_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.HL_HISTORY_FETCH_CONCURRENCY || "4", 10)
);
const HL_MAX_INDICATOR_MARKETS = Math.max(
  1,
  parseInt(process.env.HL_MAX_INDICATOR_MARKETS || "1", 10)
);
const AGENT_GLOBAL_TICK_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.AGENT_GLOBAL_TICK_CONCURRENCY || "1", 10)
);
// Keep max <= 15m so "must trade every 15m" is schedulable.
const AGENT_TICK_MIN_FLOOR_MS = 60 * 1000;
const AGENT_TICK_MAX_CEIL_MS = 15 * 60 * 1000;
const AGENT_TICK_MIN_INTERVAL_ENV = Number.parseInt(
  process.env.AGENT_TICK_MIN_INTERVAL_MS || "",
  10
);
const AGENT_TICK_MAX_INTERVAL_ENV = Number.parseInt(
  process.env.AGENT_TICK_MAX_INTERVAL_MS || "",
  10
);
export const AGENT_TICK_MIN_INTERVAL_MS = Number.isFinite(AGENT_TICK_MIN_INTERVAL_ENV)
  ? Math.min(
      AGENT_TICK_MAX_CEIL_MS,
      Math.max(AGENT_TICK_MIN_FLOOR_MS, AGENT_TICK_MIN_INTERVAL_ENV)
    )
  : AGENT_TICK_MIN_FLOOR_MS;
export const AGENT_TICK_MAX_INTERVAL_MS = Number.isFinite(AGENT_TICK_MAX_INTERVAL_ENV)
  ? Math.max(
      AGENT_TICK_MIN_INTERVAL_MS,
      Math.min(AGENT_TICK_MAX_CEIL_MS, AGENT_TICK_MAX_INTERVAL_ENV)
    )
  : AGENT_TICK_MAX_CEIL_MS;
const AGENT_AI_THROTTLE_LOG_INTERVAL_MS = Math.max(
  60_000,
  parseInt(process.env.AGENT_AI_THROTTLE_LOG_INTERVAL_MS || "900000", 10)
);
const AGENT_AUTONOMOUS_BACKTEST_LOOKBACK = Math.max(
  10,
  parseInt(process.env.AGENT_AUTONOMOUS_BACKTEST_LOOKBACK || "60", 10)
);
const AGENT_MIN_ORDER_NOTIONAL_USD = Math.max(
  1,
  parseFloat(process.env.AGENT_MIN_ORDER_NOTIONAL_USD || "10")
);
const AGENT_MUST_TRADE_INTERVAL_MS = Math.max(
  60_000,
  parseInt(process.env.AGENT_MUST_TRADE_INTERVAL_MS || "900000", 10)
);
const AGENT_MUST_TRADE_MIN_ORDER_NOTIONAL_USD = Math.max(
  0.01,
  parseFloat(
    process.env.AGENT_MUST_TRADE_MIN_ORDER_NOTIONAL_USD || String(AGENT_MIN_ORDER_NOTIONAL_USD)
  )
);
const AGENT_MUST_TRADE_FORCE_COOLDOWN_MS = Math.max(
  0,
  parseInt(process.env.AGENT_MUST_TRADE_FORCE_COOLDOWN_MS || "60000", 10)
);
const TESTNET_FORCE_CONTINUOUS_EXECUTION =
  process.env.TESTNET_FORCE_CONTINUOUS_EXECUTION !== "false";
const MAINNET_FORCE_CONTINUOUS_EXECUTION =
  process.env.MAINNET_FORCE_CONTINUOUS_EXECUTION !== "false";
const AGENT_EXECUTION_MIN_CONFIDENCE = 0.1;
const TESTNET_MIN_ORDER_NOTIONAL_USD = (() => {
  const parsed = parseFloat(process.env.TESTNET_MIN_ORDER_NOTIONAL_USD || "1");
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, parsed);
})();
/** When true, relaxes notional gate to $0.01. Confidence gate still enforces 10% minimum. */
const AGENT_NEVER_SKIP_TRADES = process.env.AGENT_NEVER_SKIP_TRADES !== "false";

function findMarketPriceUsd(markets: Array<{ coin: string; price: number }>, coin: string): number {
  const m = markets.find((x) => x.coin.toUpperCase() === coin.toUpperCase());
  const p = Number(m?.price ?? 0);
  return Number.isFinite(p) ? p : 0;
}

function pickBestAllowedMarketWithPrice(
  markets: Array<{ coin: string; price: number }>,
  allowed: string[]
): string | null {
  const allowedUpper = new Set(allowed.map((m) => m.toUpperCase()));
  for (const m of markets) {
    if (!allowedUpper.has(m.coin.toUpperCase())) continue;
    if (Number(m.price) > 0) return m.coin.toUpperCase();
  }
  return allowed[0] ? allowed[0].toUpperCase() : null;
}

function pickLargestOpenPositionAsset(
  positions: Array<{ coin: string; size: number; entryPrice: number }>,
  markets: Array<{ coin: string; price: number }>
): string | null {
  let best: { coin: string; notional: number } | null = null;
  for (const p of positions) {
    const size = Math.abs(Number(p.size) || 0);
    if (!(size > 0)) continue;
    const px = findMarketPriceUsd(markets, p.coin) || Number(p.entryPrice) || 0;
    const notional = size * px;
    if (!best || notional > best.notional) best = { coin: p.coin.toUpperCase(), notional };
  }
  return best?.coin ?? null;
}

function inferDirectionFromHistory(
  asset: string,
  historicalPrices?: Record<string, number[]>
): "long" | "short" {
  const series = historicalPrices?.[asset] || historicalPrices?.[asset.toUpperCase()] || [];
  const a = Number(series.at(-2) ?? 0);
  const b = Number(series.at(-1) ?? 0);
  if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) return b >= a ? "long" : "short";
  return "long";
}

function clampSizeFraction(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function clampTickIntervalMs(intervalMs: number): number {
  return Math.max(
    AGENT_TICK_MIN_INTERVAL_MS,
    Math.min(AGENT_TICK_MAX_INTERVAL_MS, Math.round(intervalMs))
  );
}

function getRandomTickIntervalMs(): number {
  const span = AGENT_TICK_MAX_INTERVAL_MS - AGENT_TICK_MIN_INTERVAL_MS;
  if (span <= 0) return AGENT_TICK_MIN_INTERVAL_MS;
  return AGENT_TICK_MIN_INTERVAL_MS + Math.floor(Math.random() * (span + 1));
}

function resolveTickIntervalMs(intervalMs?: number): number {
  if (typeof intervalMs === "number" && Number.isFinite(intervalMs) && intervalMs > 0) {
    return clampTickIntervalMs(intervalMs);
  }

  const legacy = parsePositiveInt(process.env.AGENT_TICK_INTERVAL);
  if (legacy !== null) {
    return clampTickIntervalMs(legacy);
  }

  return getRandomTickIntervalMs();
}

function getAgentDeploymentNetwork(agent: {
  autonomy?: { deploymentNetwork?: string };
}): "testnet" | "mainnet" {
  return agent.autonomy?.deploymentNetwork === "mainnet" ? "mainnet" : "testnet";
}

function isTestnetAgent(agent: { autonomy?: { deploymentNetwork?: string } }): boolean {
  return getAgentDeploymentNetwork(agent) === "testnet";
}

function shouldForceContinuousExecution(agent: {
  autonomy?: { deploymentNetwork?: string };
}): boolean {
  return isTestnetAgent(agent)
    ? TESTNET_FORCE_CONTINUOUS_EXECUTION
    : MAINNET_FORCE_CONTINUOUS_EXECUTION;
}

function getRiskMaxSizeFraction(riskLevel: "conservative" | "moderate" | "aggressive"): number {
  switch (riskLevel) {
    case "conservative":
      return 0.2;
    case "aggressive":
      return 0.75;
    case "moderate":
    default:
      return 0.5;
  }
}

function getDecisionCadence(agentId: string): { lastDecisionAtMs: number; lastThrottleLogAtMs: number } {
  const existing = decisionCadence.get(agentId);
  if (existing) return existing;
  const created = { lastDecisionAtMs: 0, lastThrottleLogAtMs: 0 };
  decisionCadence.set(agentId, created);
  return created;
}

function evaluateDecisionCadence(
  agentId: string,
  nowMs: number,
  intervalMs: number
): {
  shouldThrottle: boolean;
  reason: string;
  nextEligibleAtMs: number;
  shouldPersistThrottleLog: boolean;
} {
  const cadence = getDecisionCadence(agentId);
  const boundedInterval = clampTickIntervalMs(intervalMs);

  if (cadence.lastDecisionAtMs <= 0 || nowMs - cadence.lastDecisionAtMs >= boundedInterval) {
    cadence.lastDecisionAtMs = nowMs;
    return {
      shouldThrottle: false,
      reason: "",
      nextEligibleAtMs: nowMs,
      shouldPersistThrottleLog: false,
    };
  }

  const nextEligibleAtMs = cadence.lastDecisionAtMs + boundedInterval;
  const shouldPersistThrottleLog =
    nowMs - cadence.lastThrottleLogAtMs >= AGENT_AI_THROTTLE_LOG_INTERVAL_MS;
  if (shouldPersistThrottleLog) {
    cadence.lastThrottleLogAtMs = nowMs;
  }

  const intervalMinutes = Math.round(boundedInterval / 60000);
  return {
    shouldThrottle: true,
    reason: `Decision cadence active (${intervalMinutes}m minimum). Next AI evaluation at ${new Date(nextEligibleAtMs).toISOString()}.`,
    nextEligibleAtMs,
    shouldPersistThrottleLog,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

let globalTickInFlight = 0;
const globalTickWaiters: Array<() => void> = [];

async function acquireGlobalTickSlot(): Promise<void> {
  if (globalTickInFlight < AGENT_GLOBAL_TICK_CONCURRENCY) {
    globalTickInFlight++;
    return;
  }
  await new Promise<void>((resolve) => {
    globalTickWaiters.push(() => {
      globalTickInFlight++;
      resolve();
    });
  });
}

function releaseGlobalTickSlot(): void {
  globalTickInFlight = Math.max(0, globalTickInFlight - 1);
  const next = globalTickWaiters.shift();
  if (next) next();
}

async function runWithGlobalTickGate<T>(fn: () => Promise<T>): Promise<T> {
  await acquireGlobalTickSlot();
  try {
    return await fn();
  } finally {
    releaseGlobalTickSlot();
  }
}

function getIndicatorMarkets(markets: string[]): string[] {
  return Array.from(new Set(markets.filter(Boolean))).slice(0, HL_MAX_INDICATOR_MARKETS);
}

function buildAutonomousStrategyEvaluation(
  trades: TradeLog[],
  markets: Array<{ coin: string; price: number }>
): string {
  const recentDirectionalTrades = trades
    .filter(
      (trade) =>
        trade.executed &&
        (trade.decision.action === "long" || trade.decision.action === "short")
    )
    .slice(-AGENT_AUTONOMOUS_BACKTEST_LOOKBACK);

  if (recentDirectionalTrades.length === 0) {
    return "No directional trade history yet.";
  }

  const priceByCoin = new Map(
    markets.map((market) => [market.coin.toUpperCase(), market.price] as const)
  );
  const perAsset = new Map<string, { count: number; wins: number; sumEdgePct: number }>();

  let evaluated = 0;
  let wins = 0;
  let sumEdgePct = 0;

  for (const trade of recentDirectionalTrades) {
    const asset = trade.decision.asset.toUpperCase();
    const fillPrice = Number(trade.executionResult?.fillPrice || 0);
    const currentPrice = Number(priceByCoin.get(asset) || 0);
    if (!(fillPrice > 0) || !(currentPrice > 0)) continue;

    const edgePct =
      trade.decision.action === "long"
        ? ((currentPrice - fillPrice) / fillPrice) * 100
        : ((fillPrice - currentPrice) / fillPrice) * 100;

    evaluated++;
    sumEdgePct += edgePct;
    if (edgePct > 0) wins++;

    const assetStats = perAsset.get(asset) || { count: 0, wins: 0, sumEdgePct: 0 };
    assetStats.count++;
    assetStats.sumEdgePct += edgePct;
    if (edgePct > 0) assetStats.wins++;
    perAsset.set(asset, assetStats);
  }

  if (evaluated === 0) {
    return `Directional history found (${recentDirectionalTrades.length} trades) but not enough price data for evaluation.`;
  }

  let bestAsset = "N/A";
  let worstAsset = "N/A";
  let bestAvg = -Infinity;
  let worstAvg = Infinity;
  for (const [asset, stats] of Array.from(perAsset.entries())) {
    const avg = stats.sumEdgePct / Math.max(1, stats.count);
    if (avg > bestAvg) {
      bestAvg = avg;
      bestAsset = `${asset} (${avg.toFixed(2)}%)`;
    }
    if (avg < worstAvg) {
      worstAvg = avg;
      worstAsset = `${asset} (${avg.toFixed(2)}%)`;
    }
  }

  const winRatePct = (wins / evaluated) * 100;
  const avgEdgePct = sumEdgePct / evaluated;
  return `Recent strategy evaluation (${evaluated} directional trades): win rate ${winRatePct.toFixed(1)}%, avg edge ${avgEdgePct.toFixed(2)}%, best ${bestAsset}, weakest ${worstAsset}.`;
}

export function getRunnerState(agentId: string): AgentRunnerState | null {
  return runnerStates.get(agentId) || null;
}

export function getAllRunnerStates(): AgentRunnerState[] {
  return Array.from(runnerStates.values());
}

// ============================================
// Start / Stop Agent
// ============================================

export async function startAgent(
  agentId: string,
  intervalMs?: number
): Promise<AgentRunnerState> {
  // Stop if already running
  if (runnerIntervals.has(agentId)) {
    await stopAgent(agentId);
  }

  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  const skipAdaptiveBackoff = shouldForceContinuousExecution(agent);

  const tickInterval = resolveTickIntervalMs(intervalMs);

  const state: AgentRunnerState = {
    agentId,
    isRunning: true,
    lastTickAt: null,
    nextTickAt: Date.now() + tickInterval,
    tickCount: 0,
    intervalMs: tickInterval,
    errors: [],
  };

  runnerStates.set(agentId, state);
  consecutiveFailures.set(agentId, 0);
  decisionCadence.set(agentId, { lastDecisionAtMs: 0, lastThrottleLogAtMs: 0 });

  // Agent execution cadence is bounded to 1-15 minutes.
  const interval = setInterval(() => {
    const failures = consecutiveFailures.get(agentId) || 0;
    // Adaptive backoff: if many consecutive failures, skip some ticks
    if (!skipAdaptiveBackoff && failures >= 3) {
      const skipChance = Math.min(0.8, failures * 0.15);
      if (Math.random() < skipChance) {
        console.log(`[Agent ${agentId}] Skipping tick due to ${failures} consecutive failures (backoff)`);
        return;
      }
    }
    executeTick(agentId).catch(() => {});
  }, tickInterval);

  runnerIntervals.set(agentId, interval);

  return state;
}

export async function stopAgent(agentId: string): Promise<void> {
  const interval = runnerIntervals.get(agentId);
  if (interval) {
    clearInterval(interval);
    runnerIntervals.delete(agentId);
  }

  const state = runnerStates.get(agentId);
  if (state) {
    state.isRunning = false;
    state.nextTickAt = null;
  }
}

// ============================================
// Execute Single Tick
// ============================================

export async function executeTick(agentId: string): Promise<TradeLog> {
  const existing = inFlightTicks.get(agentId);
  if (existing) {
    console.log(`[Agent ${agentId}] Tick already in progress; reusing in-flight tick`);
    return existing;
  }

  const tickPromise = runWithGlobalTickGate(() => executeTickInternal(agentId)).finally(() => {
    inFlightTicks.delete(agentId);
  });
  inFlightTicks.set(agentId, tickPromise);
  return tickPromise;
}

async function executeTickInternal(agentId: string): Promise<TradeLog> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  const forceContinuousExecution = shouldForceContinuousExecution(agent);

  const state = runnerStates.get(agentId);

  // Detect signing method: PKP or traditional
  const { getAccountForAgent, isPKPAccount } = await import("./account-manager");
  const agentAccount = await getAccountForAgent(agentId);
  const hlAddress = agentAccount?.address ?? agent.hlAddress;
  
  const isPKP = agentAccount ? await isPKPAccount(agentId) : false;

  // For traditional accounts, get exchange client
  let agentExchange: ReturnType<typeof getExchangeClientForAgent> | null = null;
  if (!isPKP) {
    const agentPk = await getPrivateKeyForAgent(agentId);
    agentExchange = agentPk ? getExchangeClientForAgent(agentPk) : null;
  }

  // Sync agent.hlAddress if it drifted
  if (agentAccount && agent.hlAddress !== agentAccount.address) {
    console.log(`[Agent ${agentId}] Syncing hlAddress ${agent.hlAddress} -> ${agentAccount.address}`);
    await updateAgent(agentId, { hlAddress: agentAccount.address });
  }

  // Check if agent can execute trades
  const canExecute = isPKP || agentExchange;
  if (!canExecute && !agentAccount) {
    console.warn(`[Agent ${agentId}] No wallet found; tick will analyze but not execute orders`);
  } else if (isPKP) {
    console.log(`[Agent ${agentId}] Using PKP signing for trade execution`);
  }

  const ex = agentExchange ?? undefined;
  const cadenceIntervalMs = state?.intervalMs ?? AGENT_TICK_MIN_INTERVAL_MS;
  const cadence = evaluateDecisionCadence(agentId, Date.now(), cadenceIntervalMs);
  if (!forceContinuousExecution && cadence.shouldThrottle) {
    const holdLog: TradeLog = {
      id: randomBytes(8).toString("hex"),
      agentId,
      timestamp: Date.now(),
      decision: {
        action: "hold",
        asset: agent.markets[0] || "BTC",
        size: 0,
        leverage: 1,
        confidence: 0,
        reasoning: cadence.reason,
      },
      executed: false,
    };

    if (state) {
      state.lastTickAt = holdLog.timestamp;
      state.nextTickAt = cadence.nextEligibleAtMs;
      state.tickCount++;
    }

    consecutiveFailures.set(agentId, 0);

    if (cadence.shouldPersistThrottleLog) {
      console.log(`[Agent ${agentId}] ${cadence.reason}`);
      try {
        await appendTradeLog(holdLog);
      } catch (logError) {
        console.warn(`[Agent ${agentId}] Failed to persist throttled hold log:`, logError);
      }
    }

    return holdLog;
  }

  try {
    // 1. Fetch enriched market data (includes funding, OI, volume)
    let markets;
    try {
      markets = await getEnrichedMarketData();
    } catch (marketError) {
      const msg = marketError instanceof Error ? marketError.message : String(marketError);
      console.warn(`[Agent ${agentId}] Market data fetch failed: ${msg.slice(0, 100)}`);
      // Can't make decisions without market data — record and bail gracefully
      const failCount = (consecutiveFailures.get(agentId) || 0) + 1;
      consecutiveFailures.set(agentId, failCount);
      if (state) {
        state.errors.push({ timestamp: Date.now(), message: `Market data: ${msg.slice(0, 100)}` });
        if (state.errors.length > 50) state.errors = state.errors.slice(-50);
        state.lastTickAt = Date.now();
        state.nextTickAt = Date.now() + state.intervalMs;
      }
      // Return a "hold" log instead of throwing
      const holdLog: TradeLog = {
        id: randomBytes(8).toString("hex"),
        agentId,
        timestamp: Date.now(),
        decision: { action: "hold", asset: "-", size: 0, leverage: 1, confidence: 0, reasoning: `Market data unavailable: ${msg.slice(0, 80)}` },
        executed: false,
      };
      await appendTradeLog(holdLog);
      return holdLog;
    }

    // 1.5 Reconcile spot→perp so direct HL deposits show up for trading
    try {
      const { reconcileSpotToPerp } = await import("./hyperliquid");
      await reconcileSpotToPerp(agentId);
    } catch (reconcileErr) {
      const msg = reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr);
      console.warn(`[Agent ${agentId}] reconcileSpotToPerp failed: ${msg.slice(0, 80)}`);
    }

    // 2. Fetch current positions (agent's actual funded wallet)
    let accountState;
    try {
      accountState = await getAccountState(hlAddress);
    } catch (accError) {
      const msg = accError instanceof Error ? accError.message : String(accError);
      console.warn(`[Agent ${agentId}] Account state fetch failed: ${msg.slice(0, 100)}`);
      const failCount = (consecutiveFailures.get(agentId) || 0) + 1;
      consecutiveFailures.set(agentId, failCount);
      if (state) {
        state.errors.push({ timestamp: Date.now(), message: `Account state: ${msg.slice(0, 100)}` });
        if (state.errors.length > 50) state.errors = state.errors.slice(-50);
        state.lastTickAt = Date.now();
        state.nextTickAt = Date.now() + state.intervalMs;
      }
      const holdLog: TradeLog = {
        id: randomBytes(8).toString("hex"),
        agentId,
        timestamp: Date.now(),
        decision: { action: "hold", asset: "-", size: 0, leverage: 1, confidence: 0, reasoning: `Account data unavailable: ${msg.slice(0, 80)}` },
        executed: false,
      };
      await appendTradeLog(holdLog);
      return holdLog;
    }

    const positions = (accountState.assetPositions || [])
      .filter((p) => parseFloat(p.position.szi) !== 0)
      .map((p) => ({
        coin: p.position.coin,
        size: parseFloat(p.position.szi),
        entryPrice: parseFloat(p.position.entryPx || "0"),
        unrealizedPnl: parseFloat(p.position.unrealizedPnl),
        leverage: parseFloat(String(p.position.leverage?.value ?? "1")),
      }));

    const availableBalance = parseFloat(accountState.withdrawable || "0");

    // Must-trade liveness: ensure at least one executed trade every 15 minutes.
    // Trigger when overdue OR when the next tick would miss the deadline.
    // If the autonomous runner is not active (no in-memory state), assume the next tick could be as late as the
    // configured max interval.
    let mustTrade = false;
    let mustTradeDeadlineMs = 0;
    let mustTradeReason = "";
    let tradeMeta = { lastExecutedAt: 0, lastForceAttemptAt: 0 };
    try {
      tradeMeta = await getAgentTradeMeta(agentId);
      const refMs = (tradeMeta.lastExecutedAt > 0 ? tradeMeta.lastExecutedAt : agent.createdAt) || 0;
      const nowMs = Date.now();
      mustTradeDeadlineMs = refMs + AGENT_MUST_TRADE_INTERVAL_MS;
      const overdue = nowMs >= mustTradeDeadlineMs;
      const horizonMs = state?.intervalMs ?? AGENT_TICK_MAX_INTERVAL_MS;
      const wouldMiss = nowMs + horizonMs >= mustTradeDeadlineMs;
      const cooldownOk = nowMs - (tradeMeta.lastForceAttemptAt || 0) >= AGENT_MUST_TRADE_FORCE_COOLDOWN_MS;
      mustTrade = Boolean(canExecute && cooldownOk && (overdue || wouldMiss));
      if (mustTrade) {
        const minsLeft = Math.max(0, Math.round((mustTradeDeadlineMs - nowMs) / 60000));
        mustTradeReason = overdue
          ? `Overdue: last executed trade older than ${Math.round(AGENT_MUST_TRADE_INTERVAL_MS / 60000)}m.`
          : `Deadline approaching: next tick could miss ${Math.round(AGENT_MUST_TRADE_INTERVAL_MS / 60000)}m trade window (${minsLeft}m left).`;
        // Record the force attempt immediately to prevent thundering-herd overrides.
        try {
          await recordAgentForceAttempt(agentId, nowMs);
        } catch (metaErr) {
          console.warn(`[Agent ${agentId}] Failed to persist must-trade attempt:`, metaErr);
        }
      }
    } catch (metaErr) {
      console.warn(`[Agent ${agentId}] Failed to load trade meta:`, metaErr);
    }

    // 3. Fetch historical prices if indicator is enabled
    const historicalPrices: Record<string, number[]> = {};
    if (agent.indicator?.enabled && agent.markets.length > 0) {
      console.log(`[Agent ${agentId}] Fetching historical prices for indicator analysis...`);
      try {
        const indicatorMarkets = getIndicatorMarkets(agent.markets);

        if (indicatorMarkets.length < agent.markets.length) {
          console.log(
            `[Agent ${agentId}] Indicator candles capped at ${indicatorMarkets.length}/${agent.markets.length} markets`
          );
        }

        const results = await mapWithConcurrency(
          indicatorMarkets,
          HL_HISTORY_FETCH_CONCURRENCY,
          async (coin) => {
            const data = await getHistoricalPrices(coin, "15m", 50);
            return { coin, prices: data.prices };
          }
        );

        for (const { coin, prices } of results) {
          if (prices.length > 0) {
            historicalPrices[coin] = prices;
            console.log(`[Agent ${agentId}] Fetched ${prices.length} candles for ${coin}`);
          }
        }
      } catch (error) {
        console.error(`[Agent ${agentId}] Failed to fetch historical prices:`, error);
        // Continue without historical prices - indicators will use fallback logic
      }
    }

    // 4. Optional per-agent API key override
    const hasAgentOwnKey = Boolean(agent.aiApiKey?.encryptedKey && agent.aiApiKey?.provider);
    let agentApiKeys: { anthropic?: string; openai?: string } | undefined;
    if (hasAgentOwnKey) {
      try {
        const { decrypt } = await import("./account-manager");
        const key = decrypt(agent.aiApiKey!.encryptedKey);
        if (agent.aiApiKey!.provider === "anthropic") agentApiKeys = { anthropic: key };
        else agentApiKeys = { openai: key };
      } catch (_e) {
        console.warn(`[Agent ${agentId}] Failed to decrypt API key, using platform model credentials`);
      }
    }

    // 5. Strategy self-evaluation from recent trade history (autonomous backtest loop)
    let autonomousEvaluation = "No recent strategy evaluation available.";
    try {
      const allTrades = await getTradeLogsForAgent(agentId);
      autonomousEvaluation = buildAutonomousStrategyEvaluation(allTrades, markets);
    } catch (evaluationError) {
      console.warn(`[Agent ${agentId}] Strategy evaluation failed:`, evaluationError);
    }

    // 6. Ask AI for trade decision (with indicator, strategy, Supermemory, and evaluation context)
    let decision = await getTradeDecision({
      markets,
      currentPositions: positions,
      availableBalance,
      riskLevel: agent.riskLevel,
      maxLeverage: agent.maxLeverage,
      allowedMarkets: agent.markets,
      aggressiveness: agent.autonomy?.aggressiveness ?? 50,
      indicator: agent.indicator,
      historicalPrices: Object.keys(historicalPrices).length > 0 ? historicalPrices : undefined,
      agentName: agent.name,
      agentStrategy: agent.description,
      agentId,
      autonomousEvaluation,
      agentApiKeys,
      mustTrade: mustTrade
        ? {
            enabled: true,
            deadlineMs: mustTradeDeadlineMs || Date.now() + AGENT_MUST_TRADE_INTERVAL_MS,
            reason: mustTradeReason || "Trade liveness requirement active.",
          }
        : undefined,
    });

    const minConfidence = AGENT_EXECUTION_MIN_CONFIDENCE;
    const allowedMarkets = new Set(agent.markets.map((m) => m.toUpperCase()));
    const maxSizeByRisk = getRiskMaxSizeFraction(agent.riskLevel);
    const hasPositionForAsset = (asset: string) =>
      positions.some((p) => p.coin.toUpperCase() === asset.toUpperCase() && Math.abs(p.size) > 0);
    const forceTradeAttempt = forceContinuousExecution && canExecute && AGENT_NEVER_SKIP_TRADES;

    decision.asset = String(decision.asset || "").toUpperCase();
    decision.size = Math.max(0, Math.min(decision.size || 0, maxSizeByRisk));
    decision.confidence = Math.max(0, Math.min(1, decision.confidence || 0));
    decision.leverage = Math.max(1, Math.min(agent.maxLeverage, Math.round(decision.leverage || 1)));

    // Must-trade override: if we're at risk of missing the 15m trade window, do not allow "hold".
    // Also ensure the size is large enough to clear typical exchange minimum notional.
    if (mustTrade) {
      const forcedAsset =
        pickBestAllowedMarketWithPrice(markets, agent.markets) || decision.asset || agent.markets[0] || "BTC";

      if (decision.action === "hold") {
        const hasOpen = positions.some((p) => Math.abs(p.size) > 0);
        const canOpenNew = Number.isFinite(availableBalance) && availableBalance >= AGENT_MUST_TRADE_MIN_ORDER_NOTIONAL_USD;
        const closeAsset = hasOpen ? pickLargestOpenPositionAsset(positions, markets) : null;

        if (hasOpen && (!canOpenNew || !forcedAsset)) {
          decision = {
            action: "close",
            asset: (closeAsset || forcedAsset || agent.markets[0] || "BTC").toUpperCase(),
            size: 0,
            leverage: 1,
            confidence: Math.max(decision.confidence, 0.01),
            reasoning: `Must-trade override: closing position to satisfy 15m trade liveness. ${mustTradeReason}`,
          };
        } else if (forcedAsset) {
          const action = inferDirectionFromHistory(forcedAsset, Object.keys(historicalPrices).length ? historicalPrices : undefined);
          const minFrac =
            availableBalance > 0
              ? AGENT_MUST_TRADE_MIN_ORDER_NOTIONAL_USD / availableBalance
              : 1;
          decision = {
            action,
            asset: forcedAsset.toUpperCase(),
            size: clampSizeFraction(Math.min(maxSizeByRisk, Math.max(0.01, minFrac))),
            leverage: 1,
            confidence: Math.max(decision.confidence, 0.01),
            reasoning: `Must-trade override: forced ${action} to satisfy 15m trade liveness. ${mustTradeReason}`,
          };
        }
      } else if (decision.action === "long" || decision.action === "short") {
        const minFrac =
          availableBalance > 0 ? AGENT_MUST_TRADE_MIN_ORDER_NOTIONAL_USD / availableBalance : 1;
        decision.size = Math.max(decision.size, clampSizeFraction(Math.min(maxSizeByRisk, minFrac)));
        decision.leverage = Math.max(1, Math.min(decision.leverage, 2));
        if (!decision.asset) decision.asset = forcedAsset.toUpperCase();
      }
    }

    if (decision.action !== "hold" && !allowedMarkets.has(decision.asset)) {
      if (forceTradeAttempt) {
        const fallbackAsset = pickBestAllowedMarketWithPrice(markets, agent.markets) || agent.markets[0] || "BTC";
        decision.asset = fallbackAsset.toUpperCase();
        decision.reasoning = `${decision.reasoning || ""} Forced market remap to allowed asset ${decision.asset}.`.trim();
      } else {
        decision = {
          action: "hold",
          asset: agent.markets[0] || "BTC",
          size: 0,
          leverage: 1,
          confidence: 0,
          reasoning: `Blocked trade on disallowed market ${decision.asset}.`,
        };
      }
    }

    if (decision.action === "close" && !hasPositionForAsset(decision.asset)) {
      if (forceTradeAttempt) {
        const fallbackAsset =
          pickBestAllowedMarketWithPrice(markets, agent.markets) || decision.asset || agent.markets[0] || "BTC";
        const action = inferDirectionFromHistory(
          fallbackAsset,
          Object.keys(historicalPrices).length > 0 ? historicalPrices : undefined
        );
        const minFrac =
          availableBalance > 0 ? AGENT_MUST_TRADE_MIN_ORDER_NOTIONAL_USD / availableBalance : maxSizeByRisk;
        decision = {
          action,
          asset: fallbackAsset.toUpperCase(),
          size: clampSizeFraction(Math.min(maxSizeByRisk, Math.max(0.01, minFrac))),
          leverage: Math.max(1, Math.min(decision.leverage, 2)),
          confidence: Math.max(minConfidence, decision.confidence || 0),
          reasoning: `Close remapped to forced ${action} due no open position on ${decision.asset}.`,
        };
      } else {
        decision = {
          action: "hold",
          asset: decision.asset || agent.markets[0] || "BTC",
          size: 0,
          leverage: 1,
          confidence: 0,
          reasoning: `Close requested with no open position on ${decision.asset}.`,
        };
      }
    }

    if (decision.action !== "hold" && decision.confidence < minConfidence) {
      if (forceTradeAttempt) {
        decision.confidence = minConfidence;
        decision.reasoning = `${decision.reasoning || ""} Confidence floor override applied (${minConfidence.toFixed(2)}).`.trim();
      } else {
        decision = {
          action: "hold",
          asset: decision.asset || agent.markets[0] || "BTC",
          size: 0,
          leverage: 1,
          confidence: decision.confidence,
          reasoning: `Confidence ${decision.confidence.toFixed(2)} below min ${minConfidence.toFixed(2)}.`,
        };
      }
    }

    if (forceTradeAttempt && decision.action === "hold") {
      const forcedAsset =
        pickLargestOpenPositionAsset(positions, markets) ||
        pickBestAllowedMarketWithPrice(markets, agent.markets) ||
        agent.markets[0] ||
        "BTC";
      const hasOpen = positions.some((p) => Math.abs(p.size) > 0);
      const shouldClose = hasOpen && availableBalance < AGENT_MUST_TRADE_MIN_ORDER_NOTIONAL_USD;
      const forcedAction = shouldClose
        ? "close"
        : inferDirectionFromHistory(
            forcedAsset,
            Object.keys(historicalPrices).length > 0 ? historicalPrices : undefined
          );
      const minFrac =
        availableBalance > 0 ? AGENT_MUST_TRADE_MIN_ORDER_NOTIONAL_USD / availableBalance : maxSizeByRisk;

      decision = {
        action: forcedAction,
        asset: forcedAsset.toUpperCase(),
        size: forcedAction === "close"
          ? 0
          : clampSizeFraction(Math.min(maxSizeByRisk, Math.max(0.01, minFrac))),
        leverage: 1,
        confidence: Math.max(minConfidence, decision.confidence || 0),
        reasoning: `Continuous execution override: forcing ${forcedAction} on ${forcedAsset}.`,
      };
    }

    // 7. Execute full order pipeline
    let executed = false;
    let executionResult: TradeLog["executionResult"] = undefined;

    console.log(`[Agent ${agentId}] Decision: ${decision.action} ${decision.asset} @ ${decision.confidence*100}% confidence`);
    console.log(`[Agent ${agentId}] Available balance: $${availableBalance}, Has exchange client: ${!!ex}`);

    if (decision.action !== "hold") {
      console.log(`[Agent ${agentId}] Attempting to execute trade...`);
      try {
        const assetIndex = await getAssetIndex(decision.asset);
        console.log(`[Agent ${agentId}] Asset index for ${decision.asset}: ${assetIndex}`);

        // Set leverage first
        if (isPKP) {
          try {
            const pkpExchange = await getExchangeClientForPKP(agentId);
            await updateLeverage(assetIndex, decision.leverage, true, pkpExchange);
            console.log(`[Agent ${agentId}] PKP leverage set to ${decision.leverage}x`);
          } catch (levErr) {
            console.warn(`[Agent ${agentId}] PKP leverage update failed, continuing:`, levErr);
          }
        } else if (ex) {
          await updateLeverage(assetIndex, decision.leverage, true, ex);
          console.log(`[Agent ${agentId}] Leverage set to ${decision.leverage}x`);
        } else {
          console.warn(`[Agent ${agentId}] Cannot set leverage - no exchange client`);
        }

        // Calculate order size with safety checks
        const matchingPosition = positions.find((p) => p.coin === decision.asset);
        const price =
          markets.find((m) => m.coin === decision.asset)?.price || 0;
        const closeNotionalUsd = Math.abs(matchingPosition?.size ?? 0) * price;
        let targetNotionalUsd = decision.action === "close"
          ? closeNotionalUsd
          : availableBalance * decision.size;
        const minOrderNotionalUsd = AGENT_NEVER_SKIP_TRADES
          ? 0.01
          : forceContinuousExecution && isTestnetAgent(agent)
            ? TESTNET_MIN_ORDER_NOTIONAL_USD
            : AGENT_MIN_ORDER_NOTIONAL_USD;

        if (forceTradeAttempt && decision.action !== "close" && targetNotionalUsd < minOrderNotionalUsd) {
          targetNotionalUsd = minOrderNotionalUsd;
        }

        const orderSize = decision.action === "close"
          ? Math.abs(matchingPosition?.size ?? 0)
          : (price > 0 ? targetNotionalUsd / price : 0);

        console.log(`[Agent ${agentId}] Order calculation: notional=$${targetNotionalUsd}, price=$${price}, size=${orderSize}`);

        if (!isFinite(orderSize) || isNaN(orderSize) || orderSize <= 0) {
          console.warn(`[Agent ${agentId}] SKIPPING: Invalid order size: ${orderSize} (notional=${targetNotionalUsd}, price=${price})`);
        } else if (!forceTradeAttempt && decision.action !== "close" && targetNotionalUsd < minOrderNotionalUsd) {
          console.warn(
            `[Agent ${agentId}] SKIPPING: Notional $${targetNotionalUsd.toFixed(2)} below minimum $${minOrderNotionalUsd.toFixed(2)}`
          );
        } else {
          console.log(`[Agent ${agentId}] Order size valid: ${orderSize}`);
          const isBuy =
            decision.action === "long" ||
            (decision.action === "close" &&
              (positions.find((p) => p.coin === decision.asset)?.size ?? 0) <
                0);

          const side = isBuy ? "buy" : "sell";

          // Place main entry/exit order as market order for guaranteed fill
          const entryParams: PlaceOrderParams = {
            coin: decision.asset,
            side: decision.action === "close" ? side : (decision.action === "long" ? "buy" : "sell"),
            size: orderSize,
            orderType: "market",
            reduceOnly: decision.action === "close",
            slippagePercent: 1,
          };

          // Execute order based on signing method
          if (isPKP) {
            console.log(`[Agent ${agentId}] Executing PKP-signed order:`, JSON.stringify(entryParams));
            const { executeOrderWithPKP } = await import("./lit-signing");
            await executeOrderWithPKP(agentId, entryParams);
            console.log(`[Agent ${agentId}] PKP order executed successfully!`);
          } else if (ex) {
            console.log(`[Agent ${agentId}] Executing order:`, JSON.stringify(entryParams));
            await executeOrder(entryParams, ex, { skipBuilder: true });
            console.log(`[Agent ${agentId}] Order executed successfully!`);
          } else {
            console.warn(`[Agent ${agentId}] No exchange client - skipping order execution`);
          }

          executed = true;
          executionResult = {
            orderId: "market",
            fillPrice: price,
            fillSize: orderSize,
            status: "filled",
          };

          // Place stop-loss if specified and not closing
          if ((isPKP || ex) && decision.stopLoss && decision.action !== "close") {
            try {
              const slSide = decision.action === "long" ? "sell" : "buy";
              const slParams: PlaceOrderParams = {
                coin: decision.asset,
                side: slSide,
                size: orderSize,
                orderType: "stop-loss",
                price: decision.stopLoss,
                triggerPrice: decision.stopLoss,
                isTpsl: true,
                reduceOnly: true,
              };
              
              if (isPKP) {
                const { executeOrderWithPKP } = await import("./lit-signing");
                await executeOrderWithPKP(agentId, slParams);
              } else {
                await executeOrder(slParams, ex, { skipBuilder: true });
              }
            } catch (slError) {
              console.error(`[Agent ${agentId}] Stop-loss placement failed:`, slError);
            }
          }

          // Place take-profit if specified and not closing
          if ((isPKP || ex) && decision.takeProfit && decision.action !== "close") {
            try {
              const tpSide = decision.action === "long" ? "sell" : "buy";
              const tpParams: PlaceOrderParams = {
                coin: decision.asset,
                side: tpSide,
                size: orderSize,
                orderType: "take-profit",
                price: decision.takeProfit,
                triggerPrice: decision.takeProfit,
                isTpsl: true,
                reduceOnly: true,
              };
              
              if (isPKP) {
                const { executeOrderWithPKP } = await import("./lit-signing");
                await executeOrderWithPKP(agentId, tpParams);
              } else {
                await executeOrder(tpParams, ex, { skipBuilder: true });
              }
            } catch (tpError) {
              console.error(`[Agent ${agentId}] Take-profit placement failed:`, tpError);
            }
          }
        }
      } catch (execError) {
        console.error(`[Agent ${agentId}] EXCEPTION in trade execution:`, execError);
        console.error(`[Agent ${agentId}] Full error:`, JSON.stringify(execError, Object.getOwnPropertyNames(execError)));
        if (state) {
          state.errors.push({
            timestamp: Date.now(),
            message: execError instanceof Error ? execError.message : "Execution failed",
          });
          // Keep last 50 errors
          if (state.errors.length > 50) state.errors = state.errors.slice(-50);
        }
      }
    }

    // 5. Log the trade
    const tradeLog: TradeLog = {
      id: randomBytes(8).toString("hex"),
      agentId,
      timestamp: Date.now(),
      decision,
      executed,
      executionResult,
    };

    await appendTradeLog(tradeLog);

    if (executed) {
      try {
        await recordAgentExecutedTrade(agentId, tradeLog.timestamp);
      } catch (metaErr) {
        console.warn(`[Agent ${agentId}] Failed to persist last executed trade timestamp:`, metaErr);
      }
    }

    // 5b. Store in Supermemory for future context
    try {
      const { addAgentMemory, hasSupermemoryKey } = await import("./supermemory");
      if (hasSupermemoryKey()) {
        const outcome = executed && executionResult
          ? `executed: ${decision.action} ${decision.asset} size=${executionResult.fillSize} price=$${executionResult.fillPrice}`
          : `skipped: ${decision.reasoning?.slice(0, 100)}`;
        const marketSummary = markets.filter((m) => agent.markets.includes(m.coin)).map((m) => `${m.coin}=$${m.price}`).join(", ") || "N/A";
        await addAgentMemory(
          agentId,
          `Market: ${marketSummary}. Strategy eval: ${autonomousEvaluation}. Decision: ${decision.action} ${decision.asset} @ ${(decision.confidence ?? 0) * 100}% confidence. Reasoning: ${decision.reasoning ?? ""}. Outcome: ${outcome}`,
          { type: "trade_decision", executed: String(executed), timestamp: String(Date.now()) }
        );
      }
    } catch (smErr) {
      console.warn(`[Agent ${agentId}] Supermemory add failed:`, smErr);
    }

    // 6. Update agent stats
    await updateAgent(agentId, {
      totalTrades: agent.totalTrades + (executed ? 1 : 0),
    });

    // 7. Update runner state
    if (state) {
      state.lastTickAt = Date.now();
      state.nextTickAt = Date.now() + state.intervalMs;
      state.tickCount++;
    }

    // Reset consecutive failures on success
    consecutiveFailures.set(agentId, 0);

    return tradeLog;
  } catch (error) {
    // Log concisely — avoid dumping massive stack traces
    const msg = error instanceof Error ? error.message : String(error);
    const isTimeout = msg.toLowerCase().includes("timeout");
    if (isTimeout) {
      console.warn(`[Agent ${agentId}] Tick failed (timeout): ${msg.slice(0, 120)}`);
    } else {
      console.error(`[Agent ${agentId}] Tick failed: ${msg.slice(0, 200)}`);
    }

    const failCount = (consecutiveFailures.get(agentId) || 0) + 1;
    consecutiveFailures.set(agentId, failCount);

    if (state) {
      state.errors.push({
        timestamp: Date.now(),
        message: msg.slice(0, 200),
      });
      if (state.errors.length > 50) state.errors = state.errors.slice(-50);
      state.lastTickAt = Date.now();
      state.nextTickAt = Date.now() + (state?.intervalMs ?? AGENT_TICK_MIN_INTERVAL_MS);
    }

    throw error;
  }
}

// ============================================
// Execute Approved Trade (Semi-Autonomous)
// ============================================

/**
 * Execute a previously proposed trade after user/Telegram approval.
 * Used by /api/agents/[id]/approve and Telegram webhook.
 */
export async function executeApprovedTrade(
  agentId: string,
  approvalId: string
): Promise<TradeLog> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const pending = agent.pendingApproval;
  if (!pending || pending.id !== approvalId || pending.status !== "pending") {
    throw new Error("No matching pending approval");
  }

  const { getAccountForAgent, isPKPAccount } = await import("./account-manager");
  const agentAccount = await getAccountForAgent(agentId);
  const hlAddress = agentAccount?.address ?? agent.hlAddress;
  const isPKP = agentAccount ? await isPKPAccount(agentId) : false;
  let agentExchange: ReturnType<typeof getExchangeClientForAgent> | null = null;
  let pkpExchange: Awaited<ReturnType<typeof getExchangeClientForPKP>> | null = null;

  if (!isPKP) {
    const agentPk = await getPrivateKeyForAgent(agentId);
    agentExchange = agentPk ? getExchangeClientForAgent(agentPk) : null;
  } else {
    pkpExchange = await getExchangeClientForPKP(agentId);
  }

  if (!isPKP && !agentExchange) {
    throw new Error("No HL key found for agent");
  }

  const decision = pending.decision;
  if (
    decision.action !== "hold" &&
    !agent.markets.some((m) => m.toUpperCase() === decision.asset.toUpperCase())
  ) {
    throw new Error(`Approved trade asset ${decision.asset} is not in agent allowed markets`);
  }
  let executed = false;
  let executionResult: TradeLog["executionResult"] = undefined;

  if (decision.action !== "hold") {
    try {
      const markets = await getEnrichedMarketData();
      const accountState = await getAccountState(hlAddress);
      const availableBalance = parseFloat(accountState.withdrawable || "0");
      const assetIndex = await getAssetIndex(decision.asset);
      if (isPKP && pkpExchange) {
        await updateLeverage(assetIndex, decision.leverage, true, pkpExchange);
      } else if (agentExchange) {
        await updateLeverage(assetIndex, decision.leverage, true, agentExchange);
      }

      const capitalToUse = availableBalance * decision.size;
      const price =
        markets.find((m) => m.coin === decision.asset)?.price || 0;
      const positions = (accountState.assetPositions || [])
        .filter((p) => parseFloat(p.position.szi) !== 0)
        .map((p) => ({ coin: p.position.coin, size: parseFloat(p.position.szi) }));
      const matchingPosition = positions.find((p) => p.coin === decision.asset);
      const orderSize = decision.action === "close"
        ? Math.abs(matchingPosition?.size ?? 0)
        : (price > 0 ? capitalToUse / price : 0);

      if (orderSize > 0) {
        const isBuy =
          decision.action === "long" ||
          (decision.action === "close" &&
            (positions.find((p) => p.coin === decision.asset)?.size ?? 0) < 0);
        const side = isBuy ? "buy" : "sell";

        const entryParams: PlaceOrderParams = {
          coin: decision.asset,
          side: decision.action === "close" ? side : (decision.action === "long" ? "buy" : "sell"),
          size: orderSize,
          orderType: "market",
          reduceOnly: decision.action === "close",
          slippagePercent: 1,
        };

        if (isPKP) {
          const { executeOrderWithPKP } = await import("./lit-signing");
          await executeOrderWithPKP(agentId, entryParams);
        } else if (agentExchange) {
          await executeOrder(entryParams, agentExchange, { skipBuilder: true });
        }
        executed = true;
        executionResult = {
          orderId: "market",
          fillPrice: price,
          fillSize: orderSize,
          status: "filled",
        };

        if (decision.stopLoss && decision.action !== "close") {
          const slSide = decision.action === "long" ? "sell" : "buy";
          const slParams: PlaceOrderParams = {
            coin: decision.asset,
            side: slSide,
            size: orderSize,
            orderType: "stop-loss",
            price: decision.stopLoss,
            triggerPrice: decision.stopLoss,
            isTpsl: true,
            reduceOnly: true,
          };
          if (isPKP) {
            const { executeOrderWithPKP } = await import("./lit-signing");
            await executeOrderWithPKP(agentId, slParams);
          } else if (agentExchange) {
            await executeOrder(slParams, agentExchange, { skipBuilder: true });
          }
        }
        if (decision.takeProfit && decision.action !== "close") {
          const tpSide = decision.action === "long" ? "sell" : "buy";
          const tpParams: PlaceOrderParams = {
            coin: decision.asset,
            side: tpSide,
            size: orderSize,
            orderType: "take-profit",
            price: decision.takeProfit,
            triggerPrice: decision.takeProfit,
            isTpsl: true,
            reduceOnly: true,
          };
          if (isPKP) {
            const { executeOrderWithPKP } = await import("./lit-signing");
            await executeOrderWithPKP(agentId, tpParams);
          } else if (agentExchange) {
            await executeOrder(tpParams, agentExchange, { skipBuilder: true });
          }
        }
      }
    } catch (err) {
      console.error(`[Agent ${agentId}] Approved trade execution failed:`, err);
      throw err;
    }
  }

  const tradeLog: TradeLog = {
    id: randomBytes(8).toString("hex"),
    agentId,
    timestamp: Date.now(),
    decision,
    executed,
    executionResult,
  };

  await appendTradeLog(tradeLog);
  if (executed) {
    try {
      await recordAgentExecutedTrade(agentId, tradeLog.timestamp);
    } catch (metaErr) {
      console.warn(`[Agent ${agentId}] Failed to persist last executed trade timestamp:`, metaErr);
    }
  }
  await updateAgent(agentId, {
    totalTrades: agent.totalTrades + (executed ? 1 : 0),
  });
  await clearPendingApproval(agentId);

  return tradeLog;
}
