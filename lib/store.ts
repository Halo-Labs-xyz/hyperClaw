import {
  type Agent,
  type TradeLog,
  type AgentConfig,
  type VaultChatMessage,
  type PendingTradeApproval,
} from "./types";
import { randomBytes } from "crypto";
import { readJSON, writeJSON } from "./store-backend";

// ============================================
// Agent CRUD
// ============================================

export async function getAgents(): Promise<Agent[]> {
  return readJSON<Agent[]>("agents.json", []);
}

export async function getAllAgents(): Promise<Agent[]> {
  return getAgents();
}

export async function getAgent(id: string): Promise<Agent | null> {
  const agents = await getAgents();
  return agents.find((a) => a.id === id) || null;
}

export async function createAgent(
  config: AgentConfig,
  hlAddress: `0x${string}`
): Promise<Agent> {
  const agents = await getAgents();
  const id = randomBytes(8).toString("hex");

  // Compute min confidence from aggressiveness
  const aggressiveness = config.autonomy?.aggressiveness ?? 50;
  const minConfidence = 1 - (aggressiveness / 100) * 0.5;

  const agent: Agent = {
    id,
    name: config.name,
    description: config.description,
    status: "active",
    createdAt: Date.now(),
    markets: config.markets,
    maxLeverage: config.maxLeverage,
    riskLevel: config.riskLevel,
    stopLossPercent: config.stopLossPercent,
    autonomy: {
      mode: config.autonomy?.mode ?? "semi",
      aggressiveness,
      minConfidence,
      maxTradesPerDay: config.autonomy?.maxTradesPerDay ?? 10,
      approvalTimeoutMs: config.autonomy?.approvalTimeoutMs ?? 300000, // 5 min default
    },
    telegram: config.telegramChatId
      ? {
          enabled: true,
          chatId: config.telegramChatId,
          notifyOnTrade: true,
          notifyOnPnl: true,
          notifyOnTierUnlock: true,
        }
      : undefined,
    vaultSocial: config.isOpenVault
      ? {
          isOpenVault: true,
          agentPostsTrades: true,
          allowDiscussion: true,
          agentRespondsToQuestions: true,
        }
      : undefined,
    hlAddress,
    totalPnl: 0,
    totalPnlPercent: 0,
    totalTrades: 0,
    winRate: 0,
    vaultTvlUsd: 0,
    depositorCount: 0,
  };

  agents.push(agent);
  await writeJSON("agents.json", agents);
  return agent;
}

export async function updateAgent(
  id: string,
  updates: Partial<Agent>
): Promise<Agent | null> {
  const agents = await getAgents();
  const index = agents.findIndex((a) => a.id === id);
  if (index === -1) return null;

  agents[index] = { ...agents[index], ...updates };
  await writeJSON("agents.json", agents);
  return agents[index];
}

// ============================================
// Trade Logs
// ============================================

export async function getTradeLogsForAgent(
  agentId: string
): Promise<TradeLog[]> {
  const all = await readJSON<TradeLog[]>("trades.json", []);
  return all.filter((t) => t.agentId === agentId);
}

export async function appendTradeLog(log: TradeLog): Promise<void> {
  const all = await readJSON<TradeLog[]>("trades.json", []);
  all.push(log);
  // Keep last 1000 trades per agent
  const trimmed = all.slice(-5000);
  await writeJSON("trades.json", trimmed);
}

export async function getRecentTrades(limit: number = 20): Promise<TradeLog[]> {
  const all = await readJSON<TradeLog[]>("trades.json", []);
  return all.slice(-limit).reverse();
}

// ============================================
// Pending Approvals (Semi-Autonomous)
// ============================================

export async function setPendingApproval(
  agentId: string,
  approval: PendingTradeApproval
): Promise<void> {
  await updateAgent(agentId, { pendingApproval: approval });
}

export async function clearPendingApproval(agentId: string): Promise<void> {
  const agent = await getAgent(agentId);
  if (agent) {
    const updated = { ...agent };
    delete updated.pendingApproval;
    await updateAgent(agentId, updated);
  }
}

export async function getPendingApproval(
  agentId: string
): Promise<PendingTradeApproval | null> {
  const agent = await getAgent(agentId);
  return agent?.pendingApproval ?? null;
}

// ============================================
// Vault Chat Messages
// ============================================

export async function getVaultMessages(
  agentId: string,
  limit: number = 50
): Promise<VaultChatMessage[]> {
  const all = await readJSON<VaultChatMessage[]>(`chat_${agentId}.json`, []);
  return all.slice(-limit);
}

export async function appendVaultMessage(
  message: VaultChatMessage
): Promise<void> {
  const all = await readJSON<VaultChatMessage[]>(
    `chat_${message.agentId}.json`,
    []
  );
  all.push(message);
  // Keep last 500 messages per vault
  const trimmed = all.slice(-500);
  await writeJSON(`chat_${message.agentId}.json`, trimmed);
}

// ============================================
// Daily Trade Count (for maxTradesPerDay)
// ============================================

export async function getTodayTradeCount(agentId: string): Promise<number> {
  const trades = await getTradeLogsForAgent(agentId);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  return trades.filter(
    (t) => t.agentId === agentId && t.executed && t.timestamp >= dayStart.getTime()
  ).length;
}
