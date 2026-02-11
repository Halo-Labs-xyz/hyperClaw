/**
 * GET /api/health
 *
 * Railway-ready health endpoint.
 * Initializes runtime services once and returns liveness data.
 */

import { NextResponse } from "next/server";
import { ensureRuntimeBootstrap } from "@/lib/runtime-bootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const bootstrap = await ensureRuntimeBootstrap("healthcheck");
    return NextResponse.json({
      healthy: true,
      timestamp: Date.now(),
      bootstrap,
    });
  } catch (error) {
    console.error("[Health] Error:", error);
    return NextResponse.json(
      {
        healthy: false,
        error: error instanceof Error ? error.message : "Health check failed",
        timestamp: Date.now(),
      },
      { status: 500 }
    );
  }
}
