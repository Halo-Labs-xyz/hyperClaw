/**
 * GET /api/unibase/health
 * 
 * Health check for AIP integration.
 */

import { NextResponse } from "next/server";
import { checkAIPHealth } from "@/lib/unibase-aip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = await checkAIPHealth();

    return NextResponse.json({
      ...health,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("[AIP Health] Error:", error);
    return NextResponse.json(
      {
        healthy: false,
        error: error instanceof Error ? error.message : "Health check failed",
      },
      { status: 500 }
    );
  }
}
