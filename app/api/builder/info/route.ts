import { NextResponse } from "next/server";
import { 
  getBuilderConfig, 
  getMaxBuilderFee, 
  hasBuilderApproval,
  builderPointsToPercent,
  getBuilderStats
} from "@/lib/builder";
import { type Address } from "viem";

/**
 * GET /api/builder/info
 * 
 * Get builder configuration and user's approval status
 * Query params:
 *   - user: User's address to check approval status (optional)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get("user") as Address | null;

    const config = getBuilderConfig();
    
    if (!config) {
      return NextResponse.json(
        { 
          enabled: false,
          message: "Builder codes not configured"
        },
        { status: 200 }
      );
    }

    const response: any = {
      enabled: true,
      builder: {
        address: config.address,
        feePoints: config.feePoints,
        feePercent: builderPointsToPercent(config.feePoints),
      },
    };

    // If user address provided, check their approval status
    if (userAddress) {
      try {
        const [maxFee, hasApproval] = await Promise.all([
          getMaxBuilderFee(userAddress),
          hasBuilderApproval(userAddress),
        ]);

        response.user = {
          address: userAddress,
          maxApprovedFee: maxFee,
          maxApprovedPercent: builderPointsToPercent(maxFee),
          hasApproval,
          needsApproval: !hasApproval,
        };
      } catch (error) {
        console.error("[Builder API] Error fetching user approval:", error);
        response.user = {
          address: userAddress,
          error: "Failed to fetch approval status",
        };
      }
    }

    // Get builder stats (total fees earned)
    try {
      const stats = await getBuilderStats();
      if (stats) {
        response.stats = stats;
      }
    } catch (error) {
      console.error("[Builder API] Error fetching builder stats:", error);
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error("[Builder API] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: 500 }
    );
  }
}
