import type { Agent, TradeLog, VaultChatMessage } from "./types";
import { type Address } from "viem";

const TABLES = {
  agents: "hc_agents",
  trades: "hc_trades",
  vaultMessages: "hc_vault_messages",
  deposits: "hc_deposits",
  cursors: "hc_cursors",
  hclawLocks: "hc_hclaw_locks",
  hclawEpochs: "hc_hclaw_points_epochs",
  hclawBalances: "hc_hclaw_points_balances",
  hclawReferrals: "hc_hclaw_referrals",
  hclawRewards: "hc_hclaw_rewards",
  hclawTreasuryFlows: "hc_hclaw_treasury_flows",
} as const;

interface AgentRow {
  id: string;
  name: string;
  description: string;
  status: Agent["status"];
  created_at: number;
  markets: unknown;
  max_leverage: number;
  risk_level: Agent["riskLevel"];
  stop_loss_percent: number;
  autonomy: unknown;
  indicator: unknown | null;
  telegram: unknown | null;
  vault_social: unknown | null;
  hl_address: string;
  hl_vault_address: string | null;
  total_pnl: number;
  total_pnl_percent: number;
  total_trades: number;
  win_rate: number;
  vault_tvl_usd: number;
  depositor_count: number;
  pending_approval: unknown | null;
  ai_api_key_provider?: string | null;
  ai_api_key_encrypted?: string | null;
  aip_attestation?: unknown | null;
}

interface TradeRow {
  id: string;
  agent_id: string;
  timestamp: number;
  decision: unknown;
  executed: boolean;
  execution_result: unknown | null;
}

interface VaultMessageRow {
  id: string;
  agent_id: string;
  timestamp: number;
  sender: VaultChatMessage["sender"];
  sender_name: string;
  sender_id: string | null;
  type: VaultChatMessage["type"];
  content: string;
  trade_decision: unknown | null;
  telegram_message_id: number | null;
}

export interface DepositRow {
  tx_hash: string;
  block_number: string;
  agent_id: string;
  user_address: string;
  token_address: string;
  amount: string;
  shares: string;
  usd_value: number;
  mon_rate: number;
  relay_fee: number;
  timestamp: number;
  relayed: boolean;
  hl_wallet_address: string | null;
  hl_funded: boolean | null;
  hl_funded_amount: number | null;
}

interface CursorRow {
  key: string;
  value: string;
  updated_at?: string;
}

export interface HclawLockRow {
  lock_id: string;
  user_address: string;
  amount: string;
  start_ts: number;
  end_ts: number;
  multiplier_bps: number;
  status: "active" | "unlocked" | "expired";
}

export interface HclawEpochRow {
  epoch_id: string;
  start_ts: number;
  end_ts: number;
  status: "open" | "closing" | "closed";
  root_hash: string | null;
  settled_ts: number | null;
}

export interface HclawBalanceRow {
  epoch_id: string;
  user_address: string;
  lock_points: number;
  lp_points: number;
  ref_points: number;
  quest_points: number;
  total_points: number;
}

export interface HclawReferralRow {
  referrer: string;
  referee: string;
  qualified_volume_usd: number;
  epoch_id: string;
}

export interface HclawRewardRow {
  user_address: string;
  epoch_id: string;
  rebate_usd: number;
  incentive_hclaw: number;
  claimed: boolean;
}

export interface HclawTreasuryFlowRow {
  ts: number;
  source: string;
  amount_usd: number;
  buyback_usd: number;
  incentive_usd: number;
  reserve_usd: number;
  tx_hash: string | null;
}

function supabaseBaseUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not set");
  return url.replace(/\/$/, "");
}

function supabaseKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return key;
}

export function isSupabaseStoreEnabled(): boolean {
  return !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function buildQuery(query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function supabaseRequest<T>(params: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  table: string;
  query?: Record<string, string>;
  body?: unknown;
  prefer?: string;
}): Promise<T> {
  const url = `${supabaseBaseUrl()}/rest/v1/${params.table}${buildQuery(params.query)}`;
  const key = supabaseKey();

  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  };

  if (params.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (params.prefer) {
    headers.Prefer = params.prefer;
  }

  const res = await fetch(url, {
    method: params.method,
    headers,
    body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${params.table} ${params.method} failed (${res.status}): ${text}`);
  }

  if (res.status === 204) {
    return [] as unknown as T;
  }

  const text = await res.text();
  if (!text.trim()) {
    // Supabase can return 200/201 with an empty body when using return=minimal.
    return [] as unknown as T;
  }

  return JSON.parse(text) as T;
}

function isMissingSupabaseTableError(error: unknown, table: string): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const qualified = `public.${table}`.toLowerCase();
  return (
    (message.includes("could not find the table") &&
      (message.includes(qualified) || message.includes(table.toLowerCase()))) ||
    (message.includes("relation") &&
      message.includes(table.toLowerCase()) &&
      message.includes("does not exist"))
  );
}

let missingCursorTableWarningLogged = false;

function warnMissingCursorTable(): void {
  if (missingCursorTableWarningLogged) return;
  missingCursorTableWarningLogged = true;
  console.warn(
    "[SupabaseStore] Missing table public.hc_cursors. Cursor persistence is disabled until migrations are applied."
  );
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    markets: Array.isArray(row.markets) ? (row.markets as string[]) : [],
    maxLeverage: row.max_leverage,
    riskLevel: row.risk_level,
    stopLossPercent: row.stop_loss_percent,
    autonomy: row.autonomy as Agent["autonomy"],
    indicator: (row.indicator ?? undefined) as Agent["indicator"],
    telegram: (row.telegram ?? undefined) as Agent["telegram"],
    vaultSocial: (row.vault_social ?? undefined) as Agent["vaultSocial"],
    hlAddress: row.hl_address as `0x${string}`,
    hlVaultAddress: (row.hl_vault_address ?? undefined) as `0x${string}` | undefined,
    totalPnl: row.total_pnl,
    totalPnlPercent: row.total_pnl_percent,
    totalTrades: row.total_trades,
    winRate: row.win_rate,
    vaultTvlUsd: row.vault_tvl_usd,
    depositorCount: row.depositor_count,
    pendingApproval: (row.pending_approval ?? undefined) as Agent["pendingApproval"],
    aiApiKey:
      row.ai_api_key_provider && row.ai_api_key_encrypted
        ? {
            provider: row.ai_api_key_provider as "anthropic" | "openai",
            encryptedKey: row.ai_api_key_encrypted,
          }
        : undefined,
    aipAttestation: (row.aip_attestation ?? undefined) as Agent["aipAttestation"],
  };
}

function toAgentRow(agent: Agent): AgentRow {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    status: agent.status,
    created_at: agent.createdAt,
    markets: agent.markets,
    max_leverage: agent.maxLeverage,
    risk_level: agent.riskLevel,
    stop_loss_percent: agent.stopLossPercent,
    autonomy: agent.autonomy,
    indicator: agent.indicator ?? null,
    telegram: agent.telegram ?? null,
    vault_social: agent.vaultSocial ?? null,
    hl_address: agent.hlAddress,
    hl_vault_address: agent.hlVaultAddress ?? null,
    total_pnl: agent.totalPnl,
    total_pnl_percent: agent.totalPnlPercent,
    total_trades: agent.totalTrades,
    win_rate: agent.winRate,
    vault_tvl_usd: agent.vaultTvlUsd,
    depositor_count: agent.depositorCount,
    pending_approval: agent.pendingApproval ?? null,
    ...(agent.aiApiKey
      ? {
          ai_api_key_provider: agent.aiApiKey.provider,
          ai_api_key_encrypted: agent.aiApiKey.encryptedKey,
        }
      : {}),
    ...(agent.aipAttestation ? { aip_attestation: agent.aipAttestation } : {}),
  };
}

function toTrade(row: TradeRow): TradeLog {
  return {
    id: row.id,
    agentId: row.agent_id,
    timestamp: row.timestamp,
    decision: row.decision as TradeLog["decision"],
    executed: row.executed,
    executionResult: (row.execution_result ?? undefined) as TradeLog["executionResult"],
  };
}

function toTradeRow(log: TradeLog): TradeRow {
  return {
    id: log.id,
    agent_id: log.agentId,
    timestamp: log.timestamp,
    decision: log.decision,
    executed: log.executed,
    execution_result: log.executionResult ?? null,
  };
}

function toVaultMessage(row: VaultMessageRow): VaultChatMessage {
  return {
    id: row.id,
    agentId: row.agent_id,
    timestamp: row.timestamp,
    sender: row.sender,
    senderName: row.sender_name,
    senderId: row.sender_id ?? undefined,
    type: row.type,
    content: row.content,
    tradeDecision: (row.trade_decision ?? undefined) as VaultChatMessage["tradeDecision"],
    telegramMessageId: row.telegram_message_id ?? undefined,
  };
}

function toVaultMessageRow(message: VaultChatMessage): VaultMessageRow {
  return {
    id: message.id,
    agent_id: message.agentId,
    timestamp: message.timestamp,
    sender: message.sender,
    sender_name: message.senderName,
    sender_id: message.senderId ?? null,
    type: message.type,
    content: message.content,
    trade_decision: message.tradeDecision ?? null,
    telegram_message_id: message.telegramMessageId ?? null,
  };
}

export async function sbGetAgents(): Promise<Agent[]> {
  const rows = await supabaseRequest<AgentRow[]>({
    method: "GET",
    table: TABLES.agents,
    query: {
      select: "*",
      order: "created_at.asc",
    },
  });
  return rows.map(toAgent);
}

export async function sbGetAgent(id: string): Promise<Agent | null> {
  const rows = await supabaseRequest<AgentRow[]>({
    method: "GET",
    table: TABLES.agents,
    query: {
      select: "*",
      id: `eq.${id}`,
      limit: "1",
    },
  });
  return rows[0] ? toAgent(rows[0]) : null;
}

export async function sbInsertAgent(agent: Agent): Promise<void> {
  await supabaseRequest<AgentRow[]>({
    method: "POST",
    table: TABLES.agents,
    body: [toAgentRow(agent)],
    prefer: "return=minimal",
  });
}

export async function sbUpdateAgent(id: string, updates: Partial<Agent>): Promise<Agent | null> {
  const patch: Partial<AgentRow> = {};

  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.status !== undefined) patch.status = updates.status;
  if (updates.createdAt !== undefined) patch.created_at = updates.createdAt;
  if (updates.markets !== undefined) patch.markets = updates.markets;
  if (updates.maxLeverage !== undefined) patch.max_leverage = updates.maxLeverage;
  if (updates.riskLevel !== undefined) patch.risk_level = updates.riskLevel;
  if (updates.stopLossPercent !== undefined) patch.stop_loss_percent = updates.stopLossPercent;
  if (updates.autonomy !== undefined) patch.autonomy = updates.autonomy;
  if (updates.indicator !== undefined) patch.indicator = updates.indicator ?? null;
  if (updates.telegram !== undefined) patch.telegram = updates.telegram ?? null;
  if (updates.vaultSocial !== undefined) patch.vault_social = updates.vaultSocial ?? null;
  if (updates.hlAddress !== undefined) patch.hl_address = updates.hlAddress;
  if (updates.hlVaultAddress !== undefined) patch.hl_vault_address = updates.hlVaultAddress ?? null;
  if (updates.totalPnl !== undefined) patch.total_pnl = updates.totalPnl;
  if (updates.totalPnlPercent !== undefined) patch.total_pnl_percent = updates.totalPnlPercent;
  if (updates.totalTrades !== undefined) patch.total_trades = updates.totalTrades;
  if (updates.winRate !== undefined) patch.win_rate = updates.winRate;
  if (updates.vaultTvlUsd !== undefined) patch.vault_tvl_usd = updates.vaultTvlUsd;
  if (updates.depositorCount !== undefined) patch.depositor_count = updates.depositorCount;
  if (Object.prototype.hasOwnProperty.call(updates, "pendingApproval")) {
    patch.pending_approval = updates.pendingApproval ?? null;
  }
  if (updates.aiApiKey !== undefined) {
    patch.ai_api_key_provider = updates.aiApiKey?.provider ?? null;
    patch.ai_api_key_encrypted = updates.aiApiKey?.encryptedKey ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "aipAttestation")) {
    patch.aip_attestation = updates.aipAttestation ?? null;
  }

  const rows = await supabaseRequest<AgentRow[]>({
    method: "PATCH",
    table: TABLES.agents,
    query: {
      id: `eq.${id}`,
      select: "*",
    },
    body: patch,
    prefer: "return=representation",
  });

  return rows[0] ? toAgent(rows[0]) : null;
}

export async function sbDeleteAgent(id: string): Promise<boolean> {
  await supabaseRequest<unknown[]>({
    method: "DELETE",
    table: TABLES.trades,
    query: { agent_id: `eq.${id}` },
    prefer: "return=minimal",
  });

  const rows = await supabaseRequest<AgentRow[]>({
    method: "DELETE",
    table: TABLES.agents,
    query: {
      id: `eq.${id}`,
      select: "id",
    },
    prefer: "return=representation",
  });

  return rows.length > 0;
}

export async function sbGetTradesForAgent(agentId: string): Promise<TradeLog[]> {
  const rows = await supabaseRequest<TradeRow[]>({
    method: "GET",
    table: TABLES.trades,
    query: {
      select: "*",
      agent_id: `eq.${agentId}`,
      order: "timestamp.asc",
    },
  });
  return rows.map(toTrade);
}

export async function sbAppendTrade(log: TradeLog): Promise<void> {
  await supabaseRequest<TradeRow[]>({
    method: "POST",
    table: TABLES.trades,
    body: [toTradeRow(log)],
    prefer: "return=minimal",
  });
}

export async function sbGetRecentTrades(limit: number): Promise<TradeLog[]> {
  const rows = await supabaseRequest<TradeRow[]>({
    method: "GET",
    table: TABLES.trades,
    query: {
      select: "*",
      order: "timestamp.desc",
      limit: String(limit),
    },
  });
  return rows.map(toTrade);
}

export async function sbGetVaultMessages(agentId: string, limit: number): Promise<VaultChatMessage[]> {
  const rows = await supabaseRequest<VaultMessageRow[]>({
    method: "GET",
    table: TABLES.vaultMessages,
    query: {
      select: "*",
      agent_id: `eq.${agentId}`,
      order: "timestamp.asc",
      limit: String(limit),
    },
  });
  return rows.map(toVaultMessage);
}

export async function sbAppendVaultMessage(message: VaultChatMessage): Promise<void> {
  await supabaseRequest<VaultMessageRow[]>({
    method: "POST",
    table: TABLES.vaultMessages,
    body: [toVaultMessageRow(message)],
    prefer: "return=minimal",
  });
}

export async function sbGetDepositByTxHash(txHash: string): Promise<DepositRow | null> {
  const rows = await supabaseRequest<DepositRow[]>({
    method: "GET",
    table: TABLES.deposits,
    query: {
      select: "*",
      tx_hash: `eq.${txHash}`,
      limit: "1",
    },
  });
  return rows[0] ?? null;
}

export async function sbInsertDeposit(row: DepositRow): Promise<void> {
  await supabaseRequest<DepositRow[]>({
    method: "POST",
    table: TABLES.deposits,
    body: [row],
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

export async function sbGetDepositsForAgent(agentId: string): Promise<DepositRow[]> {
  return supabaseRequest<DepositRow[]>({
    method: "GET",
    table: TABLES.deposits,
    query: {
      select: "*",
      agent_id: `eq.${agentId}`,
      order: "timestamp.desc",
    },
  });
}

export async function sbGetDepositsForUser(user: Address): Promise<DepositRow[]> {
  return supabaseRequest<DepositRow[]>({
    method: "GET",
    table: TABLES.deposits,
    query: {
      select: "*",
      user_address: `eq.${user.toLowerCase()}`,
      order: "timestamp.desc",
    },
  });
}

export async function sbGetCursor(key: string): Promise<string | null> {
  try {
    const rows = await supabaseRequest<CursorRow[]>({
      method: "GET",
      table: TABLES.cursors,
      query: {
        select: "*",
        key: `eq.${key}`,
        limit: "1",
      },
    });
    return rows[0]?.value ?? null;
  } catch (error) {
    if (isMissingSupabaseTableError(error, TABLES.cursors)) {
      warnMissingCursorTable();
      return null;
    }
    throw error;
  }
}

export async function sbSetCursor(key: string, value: string): Promise<void> {
  try {
    await supabaseRequest<CursorRow[]>({
      method: "POST",
      table: TABLES.cursors,
      body: [{ key, value }],
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  } catch (error) {
    if (isMissingSupabaseTableError(error, TABLES.cursors)) {
      warnMissingCursorTable();
      return;
    }
    throw error;
  }
}

export async function sbUpsertHclawLock(row: HclawLockRow): Promise<void> {
  await supabaseRequest<HclawLockRow[]>({
    method: "POST",
    table: TABLES.hclawLocks,
    body: [row],
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

export async function sbListHclawLocksForUser(userAddress: string): Promise<HclawLockRow[]> {
  return supabaseRequest<HclawLockRow[]>({
    method: "GET",
    table: TABLES.hclawLocks,
    query: {
      select: "*",
      user_address: `eq.${userAddress.toLowerCase()}`,
      order: "end_ts.desc",
    },
  });
}

export async function sbCreateHclawEpoch(row: HclawEpochRow): Promise<void> {
  await supabaseRequest<HclawEpochRow[]>({
    method: "POST",
    table: TABLES.hclawEpochs,
    body: [row],
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

export async function sbGetHclawEpoch(epochId: string): Promise<HclawEpochRow | null> {
  const rows = await supabaseRequest<HclawEpochRow[]>({
    method: "GET",
    table: TABLES.hclawEpochs,
    query: {
      select: "*",
      epoch_id: `eq.${epochId}`,
      limit: "1",
    },
  });
  return rows[0] ?? null;
}

export async function sbGetLatestHclawEpoch(): Promise<HclawEpochRow | null> {
  const rows = await supabaseRequest<HclawEpochRow[]>({
    method: "GET",
    table: TABLES.hclawEpochs,
    query: {
      select: "*",
      order: "start_ts.desc",
      limit: "1",
    },
  });
  return rows[0] ?? null;
}

export async function sbListHclawEpochs(limit = 20): Promise<HclawEpochRow[]> {
  return supabaseRequest<HclawEpochRow[]>({
    method: "GET",
    table: TABLES.hclawEpochs,
    query: {
      select: "*",
      order: "start_ts.desc",
      limit: String(limit),
    },
  });
}

export async function sbUpsertHclawPointsBalance(row: HclawBalanceRow): Promise<void> {
  await supabaseRequest<HclawBalanceRow[]>({
    method: "POST",
    table: TABLES.hclawBalances,
    body: [row],
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

export async function sbListHclawEpochBalances(
  epochId: string,
  userAddress?: string
): Promise<HclawBalanceRow[]> {
  const query: Record<string, string> = {
    select: "*",
    epoch_id: `eq.${epochId}`,
    order: "total_points.desc",
  };
  if (userAddress) {
    query.user_address = `eq.${userAddress.toLowerCase()}`;
  }
  return supabaseRequest<HclawBalanceRow[]>({
    method: "GET",
    table: TABLES.hclawBalances,
    query,
  });
}

export async function sbUpsertHclawReferral(row: HclawReferralRow): Promise<void> {
  await supabaseRequest<HclawReferralRow[]>({
    method: "POST",
    table: TABLES.hclawReferrals,
    body: [row],
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

export async function sbUpsertHclawReward(row: HclawRewardRow): Promise<void> {
  await supabaseRequest<HclawRewardRow[]>({
    method: "POST",
    table: TABLES.hclawRewards,
    body: [row],
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

export async function sbListHclawRewardsForUser(
  userAddress: string,
  epochId?: string
): Promise<HclawRewardRow[]> {
  const query: Record<string, string> = {
    select: "*",
    user_address: `eq.${userAddress.toLowerCase()}`,
    order: "epoch_id.desc",
  };
  if (epochId) query.epoch_id = `eq.${epochId}`;

  return supabaseRequest<HclawRewardRow[]>({
    method: "GET",
    table: TABLES.hclawRewards,
    query,
  });
}

export async function sbMarkHclawRewardClaimed(
  userAddress: string,
  epochId: string
): Promise<HclawRewardRow | null> {
  const rows = await supabaseRequest<HclawRewardRow[]>({
    method: "PATCH",
    table: TABLES.hclawRewards,
    query: {
      user_address: `eq.${userAddress.toLowerCase()}`,
      epoch_id: `eq.${epochId}`,
      select: "*",
    },
    body: { claimed: true },
    prefer: "return=representation",
  });
  return rows[0] ?? null;
}

export async function sbInsertHclawTreasuryFlow(row: HclawTreasuryFlowRow): Promise<void> {
  await supabaseRequest<HclawTreasuryFlowRow[]>({
    method: "POST",
    table: TABLES.hclawTreasuryFlows,
    body: [row],
    prefer: "return=minimal",
  });
}

export async function sbListHclawTreasuryFlows(limit = 200): Promise<HclawTreasuryFlowRow[]> {
  return supabaseRequest<HclawTreasuryFlowRow[]>({
    method: "GET",
    table: TABLES.hclawTreasuryFlows,
    query: {
      select: "ts,source,amount_usd,buyback_usd,incentive_usd,reserve_usd,tx_hash",
      order: "ts.desc",
      limit: String(limit),
    },
  });
}
