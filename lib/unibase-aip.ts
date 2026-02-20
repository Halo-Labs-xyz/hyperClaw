/**
 * Unibase AIP Agent SDK Integration
 * 
 * Exposes hyperClaw trading agents via the A2A protocol on the Unibase AIP platform.
 * Supports both DIRECT (public endpoint) and POLLING (private/firewall) modes.
 * 
 * Architecture:
 * - Each hyperClaw agent can be exposed as an AIP agent
 * - Automatic X402 micropayment handling
 * - Membase memory integration for conversation context
 * - ERC-8004 on-chain registration
 */

import { randomBytes } from "crypto";
import type { Agent } from "./types";
import { getAgent, getAllAgents } from "./store";
import { getTradeDecision } from "./ai";
import { getEnrichedMarketData, getAccountState, getHistoricalPrices } from "./hyperliquid";
import { ensureAgentOnchainAttestation } from "./agent-attestation";

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isAttestationRequired(): boolean {
  return parseBool(
    process.env.EVM_AGENT_ATTESTATION_REQUIRED ?? process.env.MONAD_AGENT_ATTESTATION_REQUIRED,
    false
  );
}

const AGENT_EXECUTION_MIN_CONFIDENCE = 0.1;

// ============================================
// Types - AIP SDK Interface
// ============================================

export type DeploymentMode = "DIRECT" | "POLLING";

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
}

export interface CostModel {
  base_call_fee: number; // USD per call
  per_token_fee?: number; // USD per token
}

export interface AgentConfig {
  name: string;
  handle: string; // unique identifier
  description: string;
  capabilities: string[]; // e.g. ["streaming", "batch", "memory"]
  skills: SkillConfig[];
  cost_model: CostModel;
  endpoint_url?: string; // if null/undefined, triggers POLLING mode
  metadata?: Record<string, any>;
}

export interface A2AMessage {
  id: string;
  type: "user_message" | "agent_response" | "system";
  content: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface A2AContext {
  message: string;
  conversation_id?: string;
  user_id: string;
  agent_id: string;
  payment_verified: boolean;
  memory?: any[];
}

export interface A2AResponse {
  content: string;
  metadata?: Record<string, any>;
  memory_update?: any;
}

// ============================================
// Agent Handler Interface
// ============================================

export type AgentHandler = (context: A2AContext) => Promise<A2AResponse>;

// ============================================
// AIP Agent Registry
// ============================================

interface RegisteredAIPAgent {
  hyperClawAgentId: string;
  aipAgentId: string;
  config: AgentConfig;
  mode: DeploymentMode;
  handler: AgentHandler;
  registered_at: number;
  endpoint_url?: string;
}

// Use global to persist across hot reloads in dev mode
declare global {
  // eslint-disable-next-line no-var
  var __aip_registered_agents: Map<string, RegisteredAIPAgent> | undefined;
}

// Initialize or reuse global registry
const registeredAgents: Map<string, RegisteredAIPAgent> = 
  global.__aip_registered_agents || (global.__aip_registered_agents = new Map());

export function getRegisteredAIPAgents(): RegisteredAIPAgent[] {
  return Array.from(registeredAgents.values());
}

export function getAIPAgent(aipAgentId: string): RegisteredAIPAgent | null {
  return registeredAgents.get(aipAgentId) || null;
}

// Also maintain a mapping from hyperClaw agent ID to AIP agent ID for quick lookup
declare global {
  // eslint-disable-next-line no-var
  var __aip_hyperclaw_to_aip: Map<string, string> | undefined;
}

const hyperClawToAIPMap: Map<string, string> = 
  global.__aip_hyperclaw_to_aip || (global.__aip_hyperclaw_to_aip = new Map());

const HL_HISTORY_FETCH_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.HL_HISTORY_FETCH_CONCURRENCY || "4", 10)
);
const HL_MAX_INDICATOR_MARKETS = Math.max(
  1,
  parseInt(process.env.HL_MAX_INDICATOR_MARKETS || "1", 10)
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

function getIndicatorMarkets(markets: string[]): string[] {
  return Array.from(new Set(markets.filter(Boolean))).slice(0, HL_MAX_INDICATOR_MARKETS);
}

export function getAIPAgentByHyperClawId(hyperClawAgentId: string): RegisteredAIPAgent | null {
  const aipAgentId = hyperClawToAIPMap.get(hyperClawAgentId);
  if (!aipAgentId) return null;
  return registeredAgents.get(aipAgentId) || null;
}

// ============================================
// Agent Configuration Builder
// ============================================

export function buildAgentConfig(
  agent: Agent,
  mode: DeploymentMode,
  publicEndpoint?: string
): AgentConfig {
  const skills: SkillConfig[] = [
    {
      id: "trading.analysis",
      name: "Market Analysis",
      description: `Analyze ${agent.markets.join(", ")} markets and provide trading insights`,
      tags: ["trading", "market-analysis", "hyperliquid", ...agent.markets.map(m => m.toLowerCase())],
      examples: [
        `What's your analysis on ${agent.markets[0]}?`,
        "Should I enter a position now?",
        "What are the current market conditions?",
      ],
    },
    {
      id: "trading.decision",
      name: "Trading Decision",
      description: "Generate trade decisions based on current market data",
      tags: ["trading", "decision", "signals"],
      examples: [
        "Give me a trade recommendation",
        `What's your ${agent.markets[0]} trade?`,
        "Should I long or short?",
      ],
    },
    {
      id: "portfolio.status",
      name: "Portfolio Status",
      description: "Report current positions, PnL, and performance metrics",
      tags: ["portfolio", "performance", "pnl"],
      examples: [
        "What's my current position?",
        "Show me the portfolio performance",
        "What's the PnL?",
      ],
    },
  ];

  // Pricing based on agent risk level and autonomy
  const baseFee = agent.autonomy.mode === "full" ? 0.01 : 0.005;
  const riskMultiplier = agent.riskLevel === "aggressive" ? 1.5 : agent.riskLevel === "moderate" ? 1.2 : 1.0;
  
  const costModel: CostModel = {
    base_call_fee: baseFee * riskMultiplier,
    per_token_fee: 0.00001,
  };

  return {
    name: agent.name,
    handle: `hyperclaw_${agent.id.slice(0, 8)}`,
    description: agent.description,
    capabilities: ["streaming", "batch", "memory"],
    skills,
    cost_model: costModel,
    endpoint_url: mode === "DIRECT" ? publicEndpoint : undefined,
    metadata: {
      version: "1.0.0",
      mode: mode.toLowerCase(),
      deployment: mode === "DIRECT" ? "public" : "gateway_polling",
      hyperClawAgentId: agent.id,
      markets: agent.markets,
      riskLevel: agent.riskLevel,
      autonomy: agent.autonomy.mode,
      status: agent.status,
      metadataHash: agent.aipAttestation?.metadataHash,
      attestationTxHash: agent.aipAttestation?.txHash,
      attestationChainId: agent.aipAttestation?.chainId,
      attestationExplorerUrl: agent.aipAttestation?.explorerUrl,
    },
  };
}

// ============================================
// Agent Handler Factory
// ============================================

export function createAgentHandler(hyperClawAgentId: string): AgentHandler {
  return async (context: A2AContext): Promise<A2AResponse> => {
    const { message, payment_verified } = context;

    // Verify payment (X402 protocol)
    if (!payment_verified) {
      return {
        content: "⚠️ Payment verification failed. Please ensure sufficient balance for micropayment.",
        metadata: { error: "payment_required" },
      };
    }

    // Get hyperClaw agent
    const agent = await getAgent(hyperClawAgentId);
    if (!agent) {
      return {
        content: "❌ Agent not found or no longer available.",
        metadata: { error: "agent_not_found" },
      };
    }

    if (agent.status !== "active") {
      return {
        content: `⚠️ Agent is currently ${agent.status}. Activate the agent to receive trading insights.`,
        metadata: { status: agent.status },
      };
    }

    // Parse user intent
    const lowerMessage = message.toLowerCase();
    const isPortfolioQuery = lowerMessage.includes("position") || 
                             lowerMessage.includes("portfolio") || 
                             lowerMessage.includes("pnl") ||
                             lowerMessage.includes("performance");
    const isAnalysisQuery = lowerMessage.includes("analysis") || 
                           lowerMessage.includes("market") ||
                           lowerMessage.includes("conditions");
    
    try {
      // Portfolio status query
      if (isPortfolioQuery) {
        const { getAgentHlState } = await import("./hyperliquid");
        const hlState = await getAgentHlState(hyperClawAgentId);
        const totalPnl = hlState?.totalPnl ?? agent.totalPnl;
        const totalPnlPercent = hlState && parseFloat(hlState.accountValue) > 0
          ? (totalPnl / parseFloat(hlState.accountValue)) * 100
          : agent.totalPnlPercent;
        const positions = (hlState?.positions || []).map((p) => ({
          coin: p.coin,
          size: p.side === "long" ? p.size : -p.size,
          entryPrice: p.entryPrice,
          unrealizedPnl: p.unrealizedPnl,
          leverage: p.leverage,
        }));

        const availableBalance = parseFloat(hlState?.availableBalance || "0");
        const totalEquity = parseFloat(hlState?.accountValue || "0");

        let response = `📊 **${agent.name} Portfolio Status**\n\n`;
        response += `**Account Value:** $${totalEquity.toFixed(2)}\n`;
        response += `**Available Balance:** $${availableBalance.toFixed(2)}\n`;
        response += `**Total PnL:** ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} (${totalPnlPercent.toFixed(2)}%)\n`;
        response += `**Win Rate:** ${agent.winRate.toFixed(1)}%\n`;
        response += `**Total Trades:** ${agent.totalTrades}\n\n`;

        if (positions.length > 0) {
          response += `**Open Positions:**\n`;
          positions.forEach((p) => {
            const side = p.size > 0 ? "LONG" : "SHORT";
            response += `• ${p.coin}: ${side} ${Math.abs(p.size).toFixed(4)} @ $${p.entryPrice.toFixed(2)} (${p.leverage}x) | uPnL: ${p.unrealizedPnl >= 0 ? "+" : ""}$${p.unrealizedPnl.toFixed(2)}\n`;
          });
        } else {
          response += `**Open Positions:** None\n`;
        }

        return {
          content: response,
          metadata: {
            type: "portfolio_status",
            totalEquity,
            availableBalance,
            positions,
          },
        };
      }

      // Market analysis query
      if (isAnalysisQuery) {
        const markets = await getEnrichedMarketData();
        const relevantMarkets = markets.filter((m) => agent.markets.includes(m.coin));

        let response = `📈 **Market Analysis for ${agent.markets.join(", ")}**\n\n`;
        relevantMarkets.forEach((m) => {
          const trend = m.change24h > 2 ? "🟢 Strong Uptrend" : 
                       m.change24h > 0 ? "🟢 Uptrend" :
                       m.change24h > -2 ? "🔴 Downtrend" :
                       "🔴 Strong Downtrend";
          
          const fundingBias = m.fundingRate > 0.01 ? "⚠️ Longs paying shorts (overcrowded long)" :
                             m.fundingRate < -0.01 ? "⚠️ Shorts paying longs (overcrowded short)" :
                             "✅ Balanced";

          response += `**${m.coin}**\n`;
          response += `• Price: $${m.price.toFixed(2)} (${m.change24h >= 0 ? "+" : ""}${m.change24h.toFixed(2)}%)\n`;
          response += `• Trend: ${trend}\n`;
          response += `• Funding: ${(m.fundingRate * 100).toFixed(4)}% ${fundingBias}\n`;
          response += `• 24h Volume: $${(m.volume24h / 1e6).toFixed(2)}M\n`;
          response += `• Open Interest: $${(m.openInterest / 1e6).toFixed(2)}M\n\n`;
        });

        return {
          content: response,
          metadata: {
            type: "market_analysis",
            markets: relevantMarkets,
          },
        };
      }

      // Default: Generate trading decision
      const accountState = await getAccountState(agent.hlAddress);
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
      const markets = await getEnrichedMarketData();

      // Fetch historical prices if indicator is enabled
      const historicalPrices: Record<string, number[]> = {};
      if (agent.indicator?.enabled && agent.markets.length > 0) {
        try {
          const indicatorMarkets = getIndicatorMarkets(agent.markets);

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
            }
          }
        } catch (error) {
          console.error(`[Unibase AIP] Failed to fetch historical prices:`, error);
        }
      }

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
        agentStrategy: agent.description,
      });

      let response = `🤖 **${agent.name} Trading Decision**\n\n`;
      response += `**Action:** ${decision.action.toUpperCase()}\n`;
      response += `**Asset:** ${decision.asset}\n`;
      response += `**Confidence:** ${(decision.confidence * 100).toFixed(1)}%\n`;
      
      if (decision.action !== "hold") {
        response += `**Position Size:** ${(decision.size * 100).toFixed(1)}% of capital\n`;
        response += `**Leverage:** ${decision.leverage}x\n`;
        if (decision.stopLoss) response += `**Stop Loss:** $${decision.stopLoss.toFixed(2)}\n`;
        if (decision.takeProfit) response += `**Take Profit:** $${decision.takeProfit.toFixed(2)}\n`;
      }
      
      response += `\n**Reasoning:** ${decision.reasoning}`;

      if (agent.autonomy.mode === "full" && decision.confidence >= AGENT_EXECUTION_MIN_CONFIDENCE) {
        response += `\n\n✅ *Agent will execute this trade automatically.*`;
      } else if (agent.autonomy.mode === "semi") {
        response += `\n\n⏳ *Trade proposal awaiting approval.*`;
      } else {
        response += `\n\n💡 *This is a recommendation. Execute manually if desired.*`;
      }

      return {
        content: response,
        metadata: {
          type: "trading_decision",
          decision,
          agent_mode: agent.autonomy.mode,
        },
        memory_update: {
          last_decision: decision,
          timestamp: Date.now(),
          user_query: message,
        },
      };
    } catch (error) {
      console.error(`[AIP Agent ${hyperClawAgentId}] Handler error:`, error);
      return {
        content: `❌ Error processing request: ${error instanceof Error ? error.message : "Unknown error"}`,
        metadata: { error: "processing_failed" },
      };
    }
  };
}

// ============================================
// Agent Registration
// ============================================

export async function registerAIPAgent(
  hyperClawAgentId: string,
  mode: DeploymentMode,
  publicEndpoint?: string
): Promise<{ aipAgentId: string; config: AgentConfig }> {
  let agent = await getAgent(hyperClawAgentId);
  if (!agent) {
    throw new Error(`HyperClaw agent ${hyperClawAgentId} not found`);
  }

  if (mode === "DIRECT" && !publicEndpoint) {
    throw new Error("DIRECT mode requires publicEndpoint parameter");
  }

  try {
    const attestationResult = await ensureAgentOnchainAttestation(hyperClawAgentId, {
      reason: "aip_register",
    });
    agent = attestationResult.agent;
  } catch (error) {
    if (isAttestationRequired()) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[AIP] Continuing registration without on-chain attestation for ${hyperClawAgentId}: ${message}`
    );
  }

  const config = buildAgentConfig(agent, mode, publicEndpoint);
  const handler = createAgentHandler(hyperClawAgentId);
  
  // Generate AIP agent ID (in real implementation, this would be returned from AIP platform)
  const aipAgentId = `aip_agent_${randomBytes(8).toString("hex")}`;

  const registered: RegisteredAIPAgent = {
    hyperClawAgentId,
    aipAgentId,
    config,
    mode,
    handler,
    registered_at: Date.now(),
    endpoint_url: publicEndpoint,
  };

  registeredAgents.set(aipAgentId, registered);
  hyperClawToAIPMap.set(hyperClawAgentId, aipAgentId);

  console.log(`[AIP] Registered agent: ${config.name} (${aipAgentId}) in ${mode} mode`);

  return { aipAgentId, config };
}

// ============================================
// Agent Invocation (A2A Protocol)
// ============================================

export async function invokeAIPAgent(
  aipAgentId: string,
  context: A2AContext
): Promise<A2AResponse> {
  const registered = registeredAgents.get(aipAgentId);
  if (!registered) {
    throw new Error(`AIP agent ${aipAgentId} not registered`);
  }

  return await registered.handler(context);
}

// ============================================
// Bulk Agent Registration
// ============================================

export async function registerAllActiveAgents(
  mode: DeploymentMode,
  baseEndpoint?: string // e.g. "https://your-domain.com/api/unibase"
): Promise<Array<{ aipAgentId: string; hyperClawAgentId: string; config: AgentConfig }>> {
  const agents = await getAllAgents();
  const activeAgents = agents.filter((a) => a.status === "active");

  const results = [];

  for (const agent of activeAgents) {
    try {
      const publicEndpoint = mode === "DIRECT" && baseEndpoint
        ? `${baseEndpoint}/invoke/${agent.id}`
        : undefined;

      const { aipAgentId, config } = await registerAIPAgent(
        agent.id,
        mode,
        publicEndpoint
      );

      results.push({ aipAgentId, hyperClawAgentId: agent.id, config });
    } catch (error) {
      console.error(`[AIP] Failed to register agent ${agent.id}:`, error);
    }
  }

  return results;
}

// ============================================
// Health Check
// ============================================

export async function checkAIPHealth(): Promise<{
  healthy: boolean;
  registered_agents: number;
  endpoint: string;
}> {
  const endpoint = process.env.AIP_ENDPOINT || "http://api.aip.unibase.com";
  
  // In production, this would actually ping the AIP platform
  // For now, return local state
  return {
    healthy: true,
    registered_agents: registeredAgents.size,
    endpoint,
  };
}

// ============================================
// Gateway Polling (for POLLING mode)
// ============================================

export interface GatewayTask {
  task_id: string;
  agent_id: string;
  context: A2AContext;
  created_at: number;
}

// Simulated task queue for polling mode
const taskQueue: GatewayTask[] = [];

export function enqueueGatewayTask(task: GatewayTask): void {
  taskQueue.push(task);
}

export async function pollGatewayTasks(
  aipAgentId: string
): Promise<GatewayTask[]> {
  // Filter tasks for this agent
  const agentTasks = taskQueue.filter((t) => t.agent_id === aipAgentId);
  
  // Remove from queue
  agentTasks.forEach((task) => {
    const index = taskQueue.indexOf(task);
    if (index > -1) taskQueue.splice(index, 1);
  });

  return agentTasks;
}

export async function submitTaskResult(
  taskId: string,
  _response: A2AResponse
): Promise<void> {
  // In production, submit result back to Gateway
  console.log(`[AIP] Task ${taskId} completed`);
}
