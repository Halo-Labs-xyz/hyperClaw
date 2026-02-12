import { NextResponse } from "next/server";
import { getAgents } from "@/lib/store";

const AGENT_TICK_MIN_FLOOR_MS = 30 * 60 * 1000;
const AGENT_TICK_MAX_CEIL_MS = 60 * 60 * 1000;
const AGENT_TICK_MIN_INTERVAL_ENV = Number.parseInt(
  process.env.AGENT_TICK_MIN_INTERVAL_MS || "",
  10
);
const AGENT_TICK_MAX_INTERVAL_ENV = Number.parseInt(
  process.env.AGENT_TICK_MAX_INTERVAL_MS || "",
  10
);
const AGENT_TICK_MIN_INTERVAL_MS = Number.isFinite(AGENT_TICK_MIN_INTERVAL_ENV)
  ? Math.min(
      AGENT_TICK_MAX_CEIL_MS,
      Math.max(AGENT_TICK_MIN_FLOOR_MS, AGENT_TICK_MIN_INTERVAL_ENV)
    )
  : AGENT_TICK_MIN_FLOOR_MS;
const AGENT_TICK_MAX_INTERVAL_MS = Number.isFinite(AGENT_TICK_MAX_INTERVAL_ENV)
  ? Math.max(
      AGENT_TICK_MIN_INTERVAL_MS,
      Math.min(AGENT_TICK_MAX_CEIL_MS, AGENT_TICK_MAX_INTERVAL_ENV)
    )
  : AGENT_TICK_MAX_CEIL_MS;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/agents/orchestrator
 *
 * Returns active agents with cadence bounds for the EC2 orchestrator.
 * Requires X-Orchestrator-Key header when ORCHESTRATOR_SECRET is set.
 */
function requireOrchestratorAuth(request: Request): boolean {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) return true;
  const key = request.headers.get("x-orchestrator-key");
  return key === secret;
}

export async function GET(request: Request) {
  if (!requireOrchestratorAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const agents = await getAgents();
    const active = agents
      .filter((a) => a.status === "active")
      .map((a) => ({
        id: a.id,
        name: a.name,
        tickIntervalMinMs: AGENT_TICK_MIN_INTERVAL_MS,
        tickIntervalMaxMs: AGENT_TICK_MAX_INTERVAL_MS,
      }));
    return NextResponse.json({
      agents: active,
      schedule: {
        tickIntervalMinMs: AGENT_TICK_MIN_INTERVAL_MS,
        tickIntervalMaxMs: AGENT_TICK_MAX_INTERVAL_MS,
      },
    });
  } catch (error) {
    console.error("Orchestrator agents error:", error);
    return NextResponse.json(
      { error: "Failed to fetch agents" },
      { status: 500 }
    );
  }
}
