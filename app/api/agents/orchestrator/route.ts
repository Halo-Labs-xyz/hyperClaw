import { NextResponse } from "next/server";
import { getAgents } from "@/lib/store";

/**
 * GET /api/agents/orchestrator
 *
 * Returns active agent IDs for the EC2 orchestrator.
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
      .map((a) => ({ id: a.id, name: a.name }));
    return NextResponse.json({ agents: active });
  } catch (error) {
    console.error("Orchestrator agents error:", error);
    return NextResponse.json(
      { error: "Failed to fetch agents" },
      { status: 500 }
    );
  }
}
