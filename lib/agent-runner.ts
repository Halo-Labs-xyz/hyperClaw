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
} from "./hyperliquid";
import { getPrivateKeyForAgent } from "./account-manager";
import type { TradeLog, AgentRunnerState, PlaceOrderParams } from "./types";
import { randomBytes } from "crypto";

// ============================================
// Runner State
// ============================================

const runnerStates = new Map<string, AgentRunnerState>();
const runnerIntervals = new Map<string, ReturnType<typeof setInterval>>();

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

  // Run first tick immediately
  executeTick(agentId).catch(() => {});

  // Set up interval
  const interval = setInterval(() => {
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
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const state = runnerStates.get(agentId);

  // Resolve agent's exchange client so trades use the agent's HL wallet
  const agentPk = await getPrivateKeyForAgent(agentId);
  const agentExchange = agentPk ? getExchangeClientForAgent(agentPk) : null;

  // Resolve the canonical HL address from account-manager (may differ from stale agent.hlAddress)
  const { getAccountForAgent } = await import("./account-manager");
  const agentAccount = await getAccountForAgent(agentId);
  const hlAddress = agentAccount?.address ?? agent.hlAddress;

  // Sync agent.hlAddress if it drifted
  if (agentAccount && agent.hlAddress !== agentAccount.address) {
    console.log(`[Agent ${agentId}] Syncing hlAddress ${agent.hlAddress} -> ${agentAccount.address}`);
    await updateAgent(agentId, { hlAddress: agentAccount.address });
  }

  const ex = agentExchange ?? undefined;
  if (!ex) {
    console.warn(`[Agent ${agentId}] No HL key found; tick will analyze but not execute orders`);
  }

  try {
    // 1. Fetch enriched market data (includes funding, OI, volume)
    const markets = await getEnrichedMarketData();

    // 2. Fetch current positions (agent's actual funded wallet)
    const accountState = await getAccountState(hlAddress);
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

    // 3. Ask AI for trade decision
    const decision = await getTradeDecision({
      markets,
      currentPositions: positions,
      availableBalance,
      riskLevel: agent.riskLevel,
      maxLeverage: agent.maxLeverage,
      allowedMarkets: agent.markets,
    });

    // 4. Execute full order pipeline
    let executed = false;
    let executionResult: TradeLog["executionResult"] = undefined;

    if (decision.action !== "hold" && decision.confidence >= 0.6) {
      try {
        const assetIndex = await getAssetIndex(decision.asset);

        // Set leverage first
        await updateLeverage(assetIndex, decision.leverage, true);

        // Calculate order size with safety checks
        const capitalToUse = availableBalance * decision.size;
        const price =
          markets.find((m) => m.coin === decision.asset)?.price || 0;
        const orderSize = price > 0 ? capitalToUse / price : 0;

        if (!isFinite(orderSize) || isNaN(orderSize) || orderSize <= 0) {
          console.warn(`[Agent ${agentId}] Invalid order size: ${orderSize} (capital=${capitalToUse}, price=${price})`);
        } else if (orderSize > 0) {
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

          if (ex) await executeOrder(entryParams, ex);

          executed = true;
          executionResult = {
            orderId: "market",
            fillPrice: price,
            fillSize: orderSize,
            status: "filled",
          };

          // Place stop-loss if specified and not closing
          if (ex && decision.stopLoss && decision.action !== "close") {
            try {
              const slSide = decision.action === "long" ? "sell" : "buy";
              await executeOrder({
                coin: decision.asset,
                side: slSide,
                size: orderSize,
                orderType: "stop-loss",
                price: decision.stopLoss,
                triggerPrice: decision.stopLoss,
                isTpsl: true,
                reduceOnly: true,
              }, ex);
            } catch (slError) {
              console.error(`[Agent ${agentId}] Stop-loss placement failed:`, slError);
            }
          }

          // Place take-profit if specified and not closing
          if (ex && decision.takeProfit && decision.action !== "close") {
            try {
              const tpSide = decision.action === "long" ? "sell" : "buy";
              await executeOrder({
                coin: decision.asset,
                side: tpSide,
                size: orderSize,
                orderType: "take-profit",
                price: decision.takeProfit,
                triggerPrice: decision.takeProfit,
                isTpsl: true,
                reduceOnly: true,
              }, ex);
            } catch (tpError) {
              console.error(`[Agent ${agentId}] Take-profit placement failed:`, tpError);
            }
          }
        }
      } catch (execError) {
        console.error(`[Agent ${agentId}] Trade execution error:`, execError);
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

    return tradeLog;
  } catch (error) {
    console.error(`[Agent ${agentId}] Tick failed:`, error);

    if (state) {
      state.errors.push({
        timestamp: Date.now(),
        message: error instanceof Error ? error.message : "Tick failed",
      });
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

  const agentPk = await getPrivateKeyForAgent(agentId);
  const agentExchange = agentPk ? getExchangeClientForAgent(agentPk) : null;
  const { getAccountForAgent } = await import("./account-manager");
  const agentAccount = await getAccountForAgent(agentId);
  const hlAddress = agentAccount?.address ?? agent.hlAddress;

  if (!agentExchange) {
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
      await updateLeverage(assetIndex, decision.leverage, true);

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

        await executeOrder(entryParams, agentExchange);
        executed = true;
        executionResult = {
          orderId: "market",
          fillPrice: price,
          fillSize: orderSize,
          status: "filled",
        };

        if (decision.stopLoss && decision.action !== "close") {
          const slSide = decision.action === "long" ? "sell" : "buy";
          await executeOrder({
            coin: decision.asset,
            side: slSide,
            size: orderSize,
            orderType: "stop-loss",
            price: decision.stopLoss,
            triggerPrice: decision.stopLoss,
            isTpsl: true,
            reduceOnly: true,
          }, agentExchange);
        }
        if (decision.takeProfit && decision.action !== "close") {
          const tpSide = decision.action === "long" ? "sell" : "buy";
          await executeOrder({
            coin: decision.asset,
            side: tpSide,
            size: orderSize,
            orderType: "take-profit",
            price: decision.takeProfit,
            triggerPrice: decision.takeProfit,
            isTpsl: true,
            reduceOnly: true,
          }, agentExchange);
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
