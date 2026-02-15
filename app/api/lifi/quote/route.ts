/**
 * GET /api/lifi/quote
 *
 * Fetch a LI.FI quote for bridging MON or USDC from Monad to USDC spot on Hyperliquid.
 *
 * Query params:
 *   - fromToken: "MON" | "USDC"
 *   - fromAmount: amount with decimals (e.g. "1000000000000000000" for 1 MON, "1000000" for 1 USDC)
 *   - fromAddress: sender wallet address (required)
 *   - toAddress: optional; defaults to fromAddress. Use agent HL address to deposit to agent.
 *   - useTestnet: "true" | "false" (default: false)
 */
import { NextResponse } from "next/server";
import { getMonadToHlQuote, getUsdcMonadToHlQuote } from "@/lib/lifi-bridge";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const fromToken = searchParams.get("fromToken");
    const fromAmount = searchParams.get("fromAmount");
    const fromAddress = searchParams.get("fromAddress");
    const toAddress = searchParams.get("toAddress") || undefined;
    const useTestnet = searchParams.get("useTestnet") === "true";

    if (!fromToken || !fromAmount || !fromAddress) {
      return NextResponse.json(
        { error: "fromToken, fromAmount, and fromAddress are required" },
        { status: 400 }
      );
    }

    if (fromToken !== "MON" && fromToken !== "USDC") {
      return NextResponse.json(
        { error: "fromToken must be MON or USDC" },
        { status: 400 }
      );
    }

    const quote =
      fromToken === "MON"
        ? await getMonadToHlQuote(fromAmount, fromAddress, toAddress, useTestnet)
        : await getUsdcMonadToHlQuote(fromAmount, fromAddress, toAddress, useTestnet);

    if (!quote) {
      return NextResponse.json(
        {
          error: "No route found",
          detail: "LI.FI could not find a route for this transfer. Try a different amount or token.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({ quote });
  } catch (error) {
    console.error("[Lifi] Quote error:", error);
    return NextResponse.json(
      { error: "Failed to fetch quote" },
      { status: 500 }
    );
  }
}
