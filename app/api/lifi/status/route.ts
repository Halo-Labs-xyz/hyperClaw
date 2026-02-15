/**
 * GET /api/lifi/status
 *
 * Check the status of a LI.FI cross-chain transfer.
 *
 * Query params:
 *   - txHash: source chain transaction hash
 *   - fromChain: source chain ID (143 for Monad mainnet)
 *   - toChain: destination chain ID (999 for Hyperliquid)
 */
import { NextResponse } from "next/server";
import { getLifiStatus } from "@/lib/lifi-bridge";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const txHash = searchParams.get("txHash");
    const fromChain = searchParams.get("fromChain");
    const toChain = searchParams.get("toChain");

    if (!txHash || !fromChain || !toChain) {
      return NextResponse.json(
        { error: "txHash, fromChain, and toChain are required" },
        { status: 400 }
      );
    }

    const status = await getLifiStatus({
      txHash,
      fromChain: parseInt(fromChain, 10),
      toChain: parseInt(toChain, 10),
    });

    if (!status) {
      return NextResponse.json(
        { error: "Could not fetch status", status: "UNKNOWN" },
        { status: 200 }
      );
    }

    return NextResponse.json(status);
  } catch (error) {
    console.error("[Lifi] Status error:", error);
    return NextResponse.json(
      { error: "Failed to fetch status" },
      { status: 500 }
    );
  }
}
