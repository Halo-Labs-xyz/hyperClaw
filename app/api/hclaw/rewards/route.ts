import { NextResponse } from "next/server";
import { type Address } from "viem";
import { claimRewards, getClaimableSummary, getRewardStates } from "@/lib/hclaw-rewards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseUser(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  return trimmed as Address;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const user = parseUser(searchParams.get("user"));
    const epochId = searchParams.get("epochId") ?? undefined;

    if (!user) {
      return NextResponse.json({
        configured: false,
        rewards: [],
        claimableRebateUsd: 0,
        claimableIncentiveHclaw: 0,
      });
    }

    const [summary, rewards] = await Promise.all([
      getClaimableSummary(user, epochId),
      getRewardStates(user, epochId),
    ]);

    return NextResponse.json({
      user,
      epochId,
      ...summary,
      rewards,
    });
  } catch (error) {
    console.error("[HCLAW rewards] GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch rewards" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const user = parseUser(body?.userAddress);
    const epochId = typeof body?.epochId === "string" ? body.epochId : null;

    if (!user || !epochId) {
      return NextResponse.json(
        { error: "userAddress and epochId are required" },
        { status: 400 }
      );
    }

    const result = await claimRewards(user, epochId);

    return NextResponse.json({
      success: true,
      claim: result,
    });
  } catch (error) {
    console.error("[HCLAW rewards] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to claim rewards" },
      { status: 500 }
    );
  }
}
