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

import { getAgent, updateAgent, appendTradeLog, clearPendingApproval } from "./store";
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

// ============================================
// Runner State
// ============================================

type RunnerGlobals = {
  runnerStates: Map<string, AgentRunnerState>;
  runnerIntervals: Map<string, ReturnType<typeof setInterval>>;
  consecutiveFailures: Map<string, number>;
  inFlightTicks: Map<string, Promise<TradeLog>>;
};

const runnerGlobals = (globalThis as typeof globalThis & {
  __hyperclawRunnerGlobals?: RunnerGlobals;
}).__hyperclawRunnerGlobals ??= {
  runnerStates: new Map<string, AgentRunnerState>(),
  runnerIntervals: new Map<string, ReturnType<typeof setInterval>>(),
  consecutiveFailures: new Map<string, number>(),
  inFlightTicks: new Map<string, Promise<TradeLog>>(),
};

const runnerStates = runnerGlobals.runnerStates;
const runnerIntervals = runnerGlobals.runnerIntervals;
const consecutiveFailures = runnerGlobals.consecutiveFailures;
const inFlightTicks = runnerGlobals.inFlightTicks;

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

  const tickInterval = intervalMs ?? parseInt(process.env.AGENT_TICK_INTERVAL || "60000");

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

  // Stagger first tick by a random 0-5s to avoid all agents hitting API at once
  const stagger = Math.random() * 5000;
  setTimeout(() => {
    executeTick(agentId).catch(() => {});
  }, stagger);

  // Set up interval with jitter to prevent thundering herd
  const interval = setInterval(() => {
    const failures = consecutiveFailures.get(agentId) || 0;
    // Adaptive backoff: if many consecutive failures, skip some ticks
    if (failures >= 3) {
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

    // 4. Ask AI for trade decision (with indicator and strategy if configured)
    const decision = await getTradeDecision({
      markets,
      currentPositions: positions,
      availableBalance,
      riskLevel: agent.riskLevel,
      maxLeverage: agent.maxLeverage,
      allowedMarkets: agent.markets,
      aggressiveness: agent.autonomy?.aggressiveness ?? 50,
      indicator: agent.indicator,
      historicalPrices: Object.keys(historicalPrices).length > 0 ? historicalPrices : undefined,
      // Pass agent identity and custom strategy
      agentName: agent.name,
      agentStrategy: agent.description, // The agent's description IS its strategy
    });

    // 5. Execute full order pipeline
    let executed = false;
    let executionResult: TradeLog["executionResult"] = undefined;

    console.log(`[Agent ${agentId}] Decision: ${decision.action} ${decision.asset} @ ${decision.confidence*100}% confidence`);
    console.log(`[Agent ${agentId}] Available balance: $${availableBalance}, Has exchange client: ${!!ex}`);

    if (decision.action !== "hold" && decision.confidence >= 0.6) {
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
        const capitalToUse = availableBalance * decision.size;
        const price =
          markets.find((m) => m.coin === decision.asset)?.price || 0;
        const orderSize = price > 0 ? capitalToUse / price : 0;
        
        console.log(`[Agent ${agentId}] Order calculation: capital=$${capitalToUse}, price=$${price}, size=${orderSize}`);

        if (!isFinite(orderSize) || isNaN(orderSize) || orderSize <= 0) {
          console.warn(`[Agent ${agentId}] SKIPPING: Invalid order size: ${orderSize} (capital=${capitalToUse}, price=${price})`);
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
            await executeOrder(entryParams, ex);
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
                await executeOrder(slParams, ex);
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
                await executeOrder(tpParams, ex);
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
      state.nextTickAt = Date.now() + (state?.intervalMs ?? 60000);
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
      const orderSize = price > 0 ? capitalToUse / price : 0;

      if (orderSize > 0) {
        const positions = (accountState.assetPositions || [])
          .filter((p) => parseFloat(p.position.szi) !== 0)
          .map((p) => ({ coin: p.position.coin, size: parseFloat(p.position.szi) }));
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
          await executeOrder(entryParams, agentExchange);
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
            await executeOrder(slParams, agentExchange);
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
            await executeOrder(tpParams, agentExchange);
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
  await updateAgent(agentId, {
    totalTrades: agent.totalTrades + (executed ? 1 : 0),
  });
  await clearPendingApproval(agentId);

  return tradeLog;
}
