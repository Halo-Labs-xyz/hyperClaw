import { readJSON, writeJSON } from "./store-backend";

export type AgentTradeMeta = {
  // Last successfully executed (non-hold) trade timestamp.
  lastExecutedAt: number;
  // Last time we applied a "must-trade" override (even if execution later failed).
  lastForceAttemptAt: number;
};

const DEFAULT_META: AgentTradeMeta = {
  lastExecutedAt: 0,
  lastForceAttemptAt: 0,
};

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { meta: AgentTradeMeta; loadedAt: number }>();

function keyForAgent(agentId: string): string {
  return `trade-meta/${agentId}.json`;
}

function normalize(raw: unknown): AgentTradeMeta {
  const obj = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const lastExecutedAt = Number(obj.lastExecutedAt);
  const lastForceAttemptAt = Number(obj.lastForceAttemptAt);
  return {
    lastExecutedAt: Number.isFinite(lastExecutedAt) && lastExecutedAt > 0 ? lastExecutedAt : 0,
    lastForceAttemptAt:
      Number.isFinite(lastForceAttemptAt) && lastForceAttemptAt > 0 ? lastForceAttemptAt : 0,
  };
}

export async function getAgentTradeMeta(agentId: string): Promise<AgentTradeMeta> {
  const cached = cache.get(agentId);
  const now = Date.now();
  if (cached && now - cached.loadedAt <= CACHE_TTL_MS) return cached.meta;

  const meta = normalize(await readJSON<AgentTradeMeta>(keyForAgent(agentId), DEFAULT_META));
  cache.set(agentId, { meta, loadedAt: now });
  return meta;
}

async function writeAgentTradeMeta(agentId: string, meta: AgentTradeMeta): Promise<void> {
  const normalized = normalize(meta);
  cache.set(agentId, { meta: normalized, loadedAt: Date.now() });
  await writeJSON(keyForAgent(agentId), normalized);
}

export async function recordAgentExecutedTrade(agentId: string, timestampMs: number): Promise<void> {
  const meta = await getAgentTradeMeta(agentId);
  await writeAgentTradeMeta(agentId, { ...meta, lastExecutedAt: timestampMs });
}

export async function recordAgentForceAttempt(agentId: string, timestampMs: number): Promise<void> {
  const meta = await getAgentTradeMeta(agentId);
  await writeAgentTradeMeta(agentId, { ...meta, lastForceAttemptAt: timestampMs });
}

