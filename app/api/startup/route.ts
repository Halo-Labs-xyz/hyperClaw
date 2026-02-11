/**
 * GET /api/startup
 * 
 * Initialize the agent lifecycle on server startup.
 * Call this on app load to ensure all active agents are running.
 */

import { NextResponse } from "next/server";
import { getLifecycleSummary } from "@/lib/agent-lifecycle";
import { ensureRuntimeBootstrap } from "@/lib/runtime-bootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const bootstrap = await ensureRuntimeBootstrap("startup");
    
    const summary = await getLifecycleSummary();
    
    return NextResponse.json({
      success: true,
      message: "Agent lifecycle initialized",
      summary,
      bootstrap,
    });
  } catch (error) {
    console.error("[Startup] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Startup failed" },
      { status: 500 }
    );
  }
}
