import { NextResponse } from "next/server";
import { getNetworkState, setNetworkState } from "@/lib/network";

/**
 * GET /api/network
 *
 * Returns the current network state.
 */
export async function GET() {
  return NextResponse.json(getNetworkState());
}

/**
 * POST /api/network
 *
 * Switch network at runtime.
 *
 * Body: { monadTestnet?: boolean, hlTestnet?: boolean }
 *
 * Both fields are optional — only the provided ones are updated.
 * All cached SDK clients are invalidated on change.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const update: Record<string, boolean> = {};

    if (typeof body.monadTestnet === "boolean") {
      update.monadTestnet = body.monadTestnet;
    }
    if (typeof body.hlTestnet === "boolean") {
      update.hlTestnet = body.hlTestnet;
    }

    // Also support a single "testnet" flag that sets both
    if (typeof body.testnet === "boolean") {
      update.monadTestnet = body.testnet;
      update.hlTestnet = body.testnet;
    }

    const newState = setNetworkState(update);

    return NextResponse.json({
      success: true,
      ...newState,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to switch network" },
      { status: 500 }
    );
  }
}
