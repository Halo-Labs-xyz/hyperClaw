import { NextResponse } from "next/server";
import { cancelOrder, cancelAllOrders, getAssetIndex } from "@/lib/hyperliquid";

/**
 * POST /api/trade/cancel
 *
 * Cancel specific order or all orders.
 * Mirrors CLI's `hl trade cancel` and `hl trade cancel-all`.
 *
 * Body:
 *   { coin: string, oid: number }  - cancel specific order
 *   { coin?: string, all: true }   - cancel all (optionally filtered by coin)
 */
export async function POST(request: Request) {
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
