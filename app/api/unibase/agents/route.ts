/**
 * GET /api/unibase/agents
 * 
 * List all registered AIP agents.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRegisteredAIPAgents } from "@/lib/unibase-aip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const agents = getRegisteredAIPAgents();

    return NextResponse.json({
      success: true,
      count: agents.length,
      agents: agents.map((a) => ({
        aipAgentId: a.aipAgentId,
        hyperClawAgentId: a.hyperClawAgentId,
        name: a.config.name,
        handle: a.config.handle,
        description: a.config.description,
        mode: a.mode,
        skills: a.config.skills.map((s) => s.name),
        cost_model: a.config.cost_model,
        endpoint_url: a.endpoint_url,
        registered_at: a.registered_at,
        metadata: a.config.metadata,
      })),
    });
  } catch (error) {
    console.error("[AIP Agents List] Error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to list agents",
      },
      { status: 500 }
    );
  }
}
