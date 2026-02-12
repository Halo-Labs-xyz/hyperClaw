/**
 * Supermemory integration for HyperClaw trading agents
 *
 * Per-agent memory: past decisions, outcomes, preferences, market patterns.
 * Uses profile({ containerTag, q }) for one-call context (profile + search).
 */

import Supermemory from "supermemory";

let client: Supermemory | null = null;

function getClient(): Supermemory {
  if (!client) {
    const key = (process.env.SUPERMEMORY_API_KEY || "").trim();
    if (!key) throw new Error("SUPERMEMORY_API_KEY not set");
    client = new Supermemory({ apiKey: key });
  }
  return client;
}

/**
 * Sanitize agentId for Supermemory containerTag (alphanumeric, hyphens, underscores, max 100 chars)
 */
function toContainerTag(agentId: string): string {
  const sanitized = agentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 90);
  return `agent_${sanitized}`;
}

export interface AgentMemoryContext {
  profileStatic: string[];
  profileDynamic: string[];
  searchMemories: string[];
}

/**
 * Get agent context (profile + search) for trade decision.
 * Option A: One call with profile({ containerTag, q })
 */
export async function getAgentMemoryContext(
  agentId: string,
  query: string
): Promise<AgentMemoryContext> {
  const key = (process.env.SUPERMEMORY_API_KEY || "").trim();
  if (!key) return { profileStatic: [], profileDynamic: [], searchMemories: [] };

  try {
    const c = getClient();
    const res = await c.profile({
      containerTag: toContainerTag(agentId),
      q: query,
    });

    const profile = res.profile;
    const searchResults = res.searchResults?.results ?? [];

    const searchMemories = searchResults
      .map((r: unknown) => {
        const item = r as { memory?: string; chunk?: string };
        return item.memory || item.chunk;
      })
      .filter((s): s is string => typeof s === "string" && s.length > 0);

    return {
      profileStatic: profile.static ?? [],
      profileDynamic: profile.dynamic ?? [],
      searchMemories,
    };
  } catch (err) {
    console.warn(`[Supermemory] getAgentMemoryContext failed for ${agentId}:`, err);
    return { profileStatic: [], profileDynamic: [], searchMemories: [] };
  }
}

/**
 * Add a memory for an agent (trade decision, outcome, etc.)
 */
export async function addAgentMemory(
  agentId: string,
  content: string,
  metadata?: Record<string, string | number | boolean | string[]>
): Promise<void> {
  const key = (process.env.SUPERMEMORY_API_KEY || "").trim();
  if (!key) return;

  try {
    const c = getClient();
    await c.add({
      content,
      containerTag: toContainerTag(agentId),
      metadata,
    });
  } catch (err) {
    console.warn(`[Supermemory] addAgentMemory failed for ${agentId}:`, err);
  }
}

export function hasSupermemoryKey(): boolean {
  return Boolean((process.env.SUPERMEMORY_API_KEY || "").trim());
}
