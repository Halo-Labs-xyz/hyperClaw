import { NextResponse } from "next/server";
import { executeOrder, getExchangeClientForAgent } from "@/lib/hyperliquid";
import { getPrivateKeyForAgent } from "@/lib/account-manager";
import type { PlaceOrderParams } from "@/lib/types";

/**
 * POST /api/trade
 *
 * Unified trading endpoint. Accepts all order types.
 * Mirrors CLI's `hl trade order` command structure.
 *
 * Body: PlaceOrderParams & { agentId?: string }
 *   If agentId is provided, the trade is placed from the agent's HL wallet.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as PlaceOrderParams & { agentId?: string };

    // Validate required fields
    if (!body.coin || !body.side || !body.size || !body.orderType) {
      return NextResponse.json(
        { error: "coin, side, size, and orderType are required" },
        { status: 400 }
      );
    }

    if (body.orderType === "limit" && !body.price) {
      return NextResponse.json(
        { error: "price is required for limit orders" },
        { status: 400 }
      );
    }

    if (
      (body.orderType === "stop-loss" || body.orderType === "take-profit") &&
      (!body.price || !body.triggerPrice)
    ) {
      return NextResponse.json(
        {
          error: "price and triggerPrice are required for stop-loss/take-profit",
        },
        { status: 400 }
      );
    }

    // Resolve exchange client: agent wallet or operator
    let exchange = undefined;
    if (body.agentId) {
      const pk = await getPrivateKeyForAgent(body.agentId);
      if (!pk) {
        return NextResponse.json(
          { error: `No HL key found for agent ${body.agentId}` },
          { status: 400 }
        );
      }
      exchange = getExchangeClientForAgent(pk);
    }

    const result = await executeOrder(body, exchange);

    return NextResponse.json({
      success: true,
      order: body,
      result,
    });
  } catch (error) {
    console.error("Trade API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Trade failed" },
      { status: 500 }
    );
  }
}
