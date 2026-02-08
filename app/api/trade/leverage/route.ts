import { NextResponse } from "next/server";
import { updateLeverage, getAssetIndex } from "@/lib/hyperliquid";

/**
 * POST /api/trade/leverage
 *
 * Set leverage for a coin. Mirrors `hl trade set-leverage`.
 *
 * Body: { coin: string, leverage: number, mode?: "cross" | "isolated" }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.coin || !body.leverage) {
      return NextResponse.json(
        { error: "coin and leverage are required" },
        { status: 400 }
      );
    }

    const assetIndex = await getAssetIndex(body.coin);
    const isCross = body.mode !== "isolated";

    const result = await updateLeverage(assetIndex, body.leverage, isCross);

    return NextResponse.json({
      success: true,
      coin: body.coin,
      leverage: body.leverage,
      mode: isCross ? "cross" : "isolated",
      result,
    });
  } catch (error) {
    console.error("Set leverage error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to set leverage" },
      { status: 500 }
    );
  }
}
