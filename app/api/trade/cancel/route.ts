import { NextResponse } from "next/server";
import { cancelOrder, cancelAllOrders, getAssetIndex } from "@/lib/hyperliquid";
import { verifyApiKey, unauthorizedResponse } from "@/lib/auth";

/**
 * POST /api/trade/cancel
 *
 * Cancel specific order or all orders.
 * Requires X-Api-Key or Bearer token when HYPERCLAW_API_KEY is set.
 *
 * Body:
 *   { coin: string, oid: number }  - cancel specific order
 *   { coin?: string, all: true }   - cancel all (optionally filtered by coin)
 */
export async function POST(request: Request) {
  if (!verifyApiKey(request)) return unauthorizedResponse();
  try {
    const body = await request.json();

    if (body.all) {
      const result = await cancelAllOrders(body.coin || undefined);
      return NextResponse.json({
        success: true,
        ...result,
      });
    }

    if (!body.coin || body.oid === undefined) {
      return NextResponse.json(
        { error: "coin and oid required, or set all: true" },
        { status: 400 }
      );
    }

    const assetIndex = await getAssetIndex(body.coin);
    const result = await cancelOrder(assetIndex, body.oid);

    return NextResponse.json({
      success: true,
      cancelled: { coin: body.coin, oid: body.oid },
      result,
    });
  } catch (error) {
    console.error("Cancel order error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Cancel failed" },
      { status: 500 }
    );
  }
}
