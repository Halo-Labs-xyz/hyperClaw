import { NextResponse } from "next/server";
import { getHclawState } from "@/lib/hclaw";

export async function GET() {
  try {
    const state = await getHclawState();

    if (!state) {
      return NextResponse.json({
        configured: false,
        message: "$HCLAW token address not configured",
      });
    }

    return NextResponse.json({
      configured: true,
      ...state,
    });
  } catch (error) {
    console.error("Token API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch token state" },
      { status: 500 }
    );
  }
}
