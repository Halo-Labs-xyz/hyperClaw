/**
 * GET /api/lifecycle
 * POST /api/lifecycle
 * 
 * Agent lifecycle management endpoint.
 * 
 * GET: Returns lifecycle summary (all agents' status)
 * POST: Perform lifecycle actions
 *   - { action: "init" } - Initialize all active agents
 *   - { action: "activate", agentId } - Activate specific agent
 *   - { action: "deactivate", agentId } - Deactivate specific agent
 *   - { action: "health" } - Run health check
 *   - { action: "heal" } - Auto-heal unhealthy agents
 *   - { action: "stop-all" } - Stop all agents (for maintenance)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  initializeAgentLifecycle,
  activateAgent,
  deactivateAgent,
  getLifecycleSummary,
  checkAllHealth,
  autoHealAgents,
  stopAllAgents,
} from "@/lib/agent-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = await getLifecycleSummary();
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[Lifecycle API] GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get lifecycle summary" },
      { status: 500 }
    );
  }
}

interface LifecycleAction {
  action: "init" | "activate" | "deactivate" | "health" | "heal" | "stop-all";
  agentId?: string;
  tickIntervalMs?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body: LifecycleAction = await req.json();
    const { action, agentId, tickIntervalMs } = body;

    switch (action) {
      case "init": {
        await initializeAgentLifecycle();
        const summary = await getLifecycleSummary();
        return NextResponse.json({
          success: true,
          message: "Lifecycle initialized",
          summary,
        });
      }

      case "activate": {
        if (!agentId) {
          return NextResponse.json(
            { error: "agentId required for activate action" },
            { status: 400 }
          );
        }
        const state = await activateAgent(agentId, { tickIntervalMs });
        return NextResponse.json({
          success: true,
          message: `Agent ${agentId} activated`,
          state,
        });
      }

      case "deactivate": {
        if (!agentId) {
          return NextResponse.json(
            { error: "agentId required for deactivate action" },
            { status: 400 }
          );
        }
        await deactivateAgent(agentId);
        return NextResponse.json({
          success: true,
          message: `Agent ${agentId} deactivated`,
        });
      }

      case "health": {
        const healthMap = await checkAllHealth();
        const results: Record<string, any> = {};
        healthMap.forEach((state, id) => {
          results[id] = state;
        });
        return NextResponse.json({
          success: true,
          health: results,
        });
      }

      case "heal": {
        const { healed, failed } = await autoHealAgents();
        return NextResponse.json({
          success: true,
          healed,
          failed,
        });
      }

      case "stop-all": {
        await stopAllAgents();
        return NextResponse.json({
          success: true,
          message: "All agents stopped",
        });
      }

      default:
        return NextResponse.json(
          { error: "Unknown action. Use: init, activate, deactivate, health, heal, stop-all" },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error("[Lifecycle API] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Lifecycle action failed" },
      { status: 500 }
    );
  }
}
