import { NextResponse } from "next/server";
import { getExchangeClient } from "@/lib/hyperliquid";
import { getApproveBuilderFeeTypedData } from "@/lib/builder";
import { type Address } from "viem";

/**
 * POST /api/builder/approve
 * 
 * Submit a signed builder fee approval to Hyperliquid
 * 
 * Body:
 *   - signature: { r, s, v } - EIP-712 signature
 *   - nonce: number - Timestamp used in signing
 *   - chainId: number - Chain ID used in signing
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { signature, nonce, chainId } = body;

    if (!signature || !nonce || !chainId) {
      return NextResponse.json(
        { error: "signature, nonce, and chainId are required" },
        { status: 400 }
      );
    }

    // Get the typed data to reconstruct the action
    const typedData = getApproveBuilderFeeTypedData(chainId, nonce);
    
    // Submit to Hyperliquid
    const exchange = getExchangeClient();
    const result = await exchange.custom({
      action: typedData.message,
      nonce,
      signature,
    });

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error) {
    console.error("[Builder Approve API] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Approval failed" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/builder/approve/typed-data
 * 
 * Get the EIP-712 typed data for builder fee approval (for client-side signing)
 * 
 * Query params:
 *   - chainId: Chain ID for signature
 *   - nonce: Optional nonce (defaults to current timestamp)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const chainId = parseInt(searchParams.get("chainId") || "421614", 10);
    const nonce = parseInt(
      searchParams.get("nonce") || Date.now().toString(),
      10
    );

    const typedData = getApproveBuilderFeeTypedData(chainId, nonce);

    return NextResponse.json({
      typedData,
      nonce,
    });
  } catch (error) {
    console.error("[Builder Approve API] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate typed data" },
      { status: 500 }
    );
  }
}
