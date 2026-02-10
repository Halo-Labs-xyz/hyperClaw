import { NextResponse } from "next/server";
import { getExchangeClient } from "@/lib/hyperliquid";
import { getBuilderConfig } from "@/lib/builder";

/**
 * POST /api/builder/claim
 * 
 * Claim accumulated builder fees
 * This uses the standard referral claim mechanism
 * 
 * Requires the builder wallet's private key to be set as HYPERLIQUID_PRIVATE_KEY
 */
export async function POST(request: Request) {
  try {
    const config = getBuilderConfig();
    
    if (!config) {
      return NextResponse.json(
        { error: "Builder codes not configured" },
        { status: 400 }
      );
    }

    // Check if the operator key matches the builder address
    const exchange = getExchangeClient();
    // Note: The exchange client is already initialized with HYPERLIQUID_PRIVATE_KEY
    
    // Claim builder fees using the referral claim action
    const result = await exchange.custom({
      action: {
        type: "usdClassTransfer",
        hyperliquidChain: process.env.NEXT_PUBLIC_HYPERLIQUID_TESTNET === "true" 
          ? "Testnet" 
          : "Mainnet",
        signatureChainId: "0x66eee", // Arbitrum Sepolia or adjust based on network
        amount: "0", // Amount of 0 triggers claim of all available referral rewards
        toPerp: true, // Transfer to perp account
        nonce: Date.now(),
      },
      nonce: Date.now(),
    });

    return NextResponse.json({
      success: true,
      message: "Builder fees claimed successfully",
      result,
    });
  } catch (error) {
    console.error("[Builder Claim API] Error:", error);
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Failed to claim fees",
        details: "Make sure HYPERLIQUID_PRIVATE_KEY matches NEXT_PUBLIC_BUILDER_ADDRESS"
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/builder/claim
 * 
 * Get claimable builder fees without claiming
 */
export async function GET(request: Request) {
  try {
    const config = getBuilderConfig();
    
    if (!config) {
      return NextResponse.json(
        { error: "Builder codes not configured" },
        { status: 400 }
      );
    }

    // Import getBuilderStats dynamically
    const { getBuilderStats } = await import("@/lib/builder");
    const stats = await getBuilderStats();

    return NextResponse.json({
      claimable: stats?.claimableFees || "0",
      total: stats?.totalFees || "0",
      builderAddress: config.address,
    });
  } catch (error) {
    console.error("[Builder Claim API] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch claimable fees" },
      { status: 500 }
    );
  }
}
