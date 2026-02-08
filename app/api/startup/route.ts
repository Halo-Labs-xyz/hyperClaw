/**
 * GET /api/startup
 * 
 * Initialize the agent lifecycle on server startup.
 * Call this on app load to ensure all active agents are running.
 */

import { NextResponse } from "next/server";
import { initializeAgentLifecycle, getLifecycleSummary } from "@/lib/agent-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Track initialization state
let initPromise: Promise<void> | null = null;

export async function GET() {
  try {
    // Only initialize once
    if (!initPromise) {
      initPromise = initializeAgentLifecycle();
    }
    
    await initPromise;
    
    const summary = await getLifecycleSummary();
    
    return NextResponse.json({
      success: true,
      message: "Agent lifecycle initialized",
      summary,
    });
  } catch (error) {
    console.error("[Startup] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Startup failed" },
      { status: 500 }
    );
  }
}
