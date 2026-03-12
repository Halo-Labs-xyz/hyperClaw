import { NextResponse } from "next/server";
import { getNetworkState, setNetworkState } from "@/lib/network";
import { verifyApiKey, unauthorizedResponse } from "@/lib/auth";

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
 * Body: { evmTestnet?: boolean, monadTestnet?: boolean, hlTestnet?: boolean }
 *
 * Both fields are optional — only the provided ones are updated.
 * All cached SDK clients are invalidated on change.
 */
export async function POST(request: Request) {
  const sameOriginRequest = (() => {
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");
    if (!origin || !host) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  })();

  const runtimeSwitchEnabled =
    process.env.ALLOW_RUNTIME_NETWORK_SWITCH === "true" ||
    process.env.NODE_ENV !== "production" ||
    sameOriginRequest;

  if (!runtimeSwitchEnabled) {
    return NextResponse.json(
      {
        error:
          "Runtime network switching is disabled. Set ALLOW_RUNTIME_NETWORK_SWITCH=true to enable.",
      },
      { status: 403 }
    );
  }

  if (!sameOriginRequest && !verifyApiKey(request)) return unauthorizedResponse();

  try {
    const body = await request.json();
    const update: Record<string, boolean> = {};

    if (typeof body.evmTestnet === "boolean") {
      update.evmTestnet = body.evmTestnet;
    }
    if (typeof body.monadTestnet === "boolean") {
      update.evmTestnet = body.monadTestnet;
    }
    if (typeof body.hlTestnet === "boolean") {
      update.hlTestnet = body.hlTestnet;
    }

    // Also support a single "testnet" flag that sets both
    if (typeof body.testnet === "boolean") {
      update.evmTestnet = body.testnet;
      update.hlTestnet = body.testnet;
    }

    const current = getNetworkState();
    const targetHlTestnet = update.hlTestnet ?? current.hlTestnet;

    if (!targetHlTestnet) {
      const { getBuilderConfig } = await import("@/lib/builder");
      const builderConfig = getBuilderConfig({ logIfMissing: false });
      if (!builderConfig) {
        return NextResponse.json(
          {
            error:
              "Cannot switch Hyperliquid to mainnet without builder config. Set BUILDER_ADDRESS/BUILDER_FEE (or NEXT_PUBLIC_BUILDER_ADDRESS/NEXT_PUBLIC_BUILDER_FEE) first.",
          },
          { status: 400 }
        );
      }
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
