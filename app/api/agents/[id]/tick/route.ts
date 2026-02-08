import { NextResponse } from "next/server";
import {
  executeTick,
  startAgent,
  stopAgent,
  getRunnerState,
} from "@/lib/agent-runner";

/**
 * POST /api/agents/[id]/tick
 *
 * Trigger a single AI trading tick for an agent, or manage the autonomous runner.
 *
 * When ORCHESTRATOR_SECRET is set, requests must include header:
 *   X-Orchestrator-Key: <ORCHESTRATOR_SECRET>
 * (Used by EC2 agent-orchestrator to trigger ticks 24/7)
 *
 * Body (optional):
 *   { action: "tick" }      - Execute a single tick (default)
 *   { action: "start", intervalMs?: number }  - Start autonomous runner
 *   { action: "stop" }      - Stop autonomous runner
 *   { action: "status" }    - Get runner status
 */
function requireOrchestratorAuth(request: Request): boolean {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) return true; // No secret = no auth required (dev)
  const key = request.headers.get("x-orchestrator-key");
  return key === secret;
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const agentId = params.id;

  if (!requireOrchestratorAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let body: { action?: string; intervalMs?: number } = {};
    try {
      body = await request.json();
    } catch {
      // Empty body = single tick
    }

    const action = body.action || "tick";

    switch (action) {
      case "tick": {
        const tradeLog = await executeTick(agentId);
        return NextResponse.json({
          decision: tradeLog.decision,
          executed: tradeLog.executed,
          executionResult: tradeLog.executionResult,
          tradeLog,
        });
      }

      case "start": {
        const state = await startAgent(agentId, body.intervalMs);
        return NextResponse.json({
          success: true,
          message: `Agent ${agentId} runner started`,
          state,
        });
      }

      case "stop": {
        await stopAgent(agentId);
        return NextResponse.json({
          success: true,
          message: `Agent ${agentId} runner stopped`,
        });
      }

      case "status": {
        const state = getRunnerState(agentId);
        return NextResponse.json({
          running: state?.isRunning ?? false,
          state,
        });
      }

      default:
        return NextResponse.json(
          { error: "Unknown action. Use: tick, start, stop, status" },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error("Agent tick error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent tick failed" },
      { status: 500 }
    );
  }
}
