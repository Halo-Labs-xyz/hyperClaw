/**
 * POST /api/unibase/register
 * 
 * Register a hyperClaw agent with the Unibase AIP platform.
 * Supports both DIRECT (public) and POLLING (private) deployment modes.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  registerAIPAgent,
  registerAllActiveAgents,
  type DeploymentMode,
} from "@/lib/unibase-aip";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RegisterRequest {
  hyperClawAgentId?: string; // if provided, register single agent
  registerAll?: boolean; // if true, register all active agents
  mode: DeploymentMode;
  publicEndpoint?: string; // required for DIRECT mode
}

export async function POST(req: NextRequest) {
  try {
    // Auth check
    const authError = requireAuth(req);
    if (authError) return authError;

    const body: RegisterRequest = await req.json();
    const { hyperClawAgentId, registerAll, mode, publicEndpoint } = body;

    // Validate mode
    if (mode !== "DIRECT" && mode !== "POLLING") {
      return NextResponse.json(
        { error: "Invalid mode. Must be 'DIRECT' or 'POLLING'" },
        { status: 400 }
      );
    }

    // DIRECT mode requires public endpoint
    if (mode === "DIRECT" && !publicEndpoint && !registerAll) {
      return NextResponse.json(
        { error: "DIRECT mode requires publicEndpoint parameter" },
        { status: 400 }
      );
    }

    // Register all active agents
    if (registerAll) {
      const baseEndpoint = publicEndpoint || process.env.AGENT_PUBLIC_URL;
      const results = await registerAllActiveAgents(mode, baseEndpoint);

      return NextResponse.json({
        success: true,
        mode,
        registered: results.length,
        agents: results,
      });
    }

    // Register single agent
    if (!hyperClawAgentId) {
      return NextResponse.json(
        { error: "hyperClawAgentId or registerAll required" },
        { status: 400 }
      );
    }

    const { aipAgentId, config } = await registerAIPAgent(
      hyperClawAgentId,
      mode,
      publicEndpoint
    );

    return NextResponse.json({
      success: true,
      aipAgentId,
      hyperClawAgentId,
      config,
      mode,
      message: `Agent registered successfully in ${mode} mode`,
    });
  } catch (error) {
    console.error("[AIP Register] Error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Registration failed",
      },
      { status: 500 }
    );
  }
}
