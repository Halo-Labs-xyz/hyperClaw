import { NextResponse } from "next/server";
import {
  getCurrentEpochInfo,
  getRecentEpochs,
  getUserPointsSummary,
  scoreEpochActivities,
  type HclawPointsActivityInput,
} from "@/lib/hclaw-points";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseUser(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(trimmed)) return null;
  return trimmed;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const user = parseUser(searchParams.get("user"));

    const [epoch, epochs] = await Promise.all([getCurrentEpochInfo(), getRecentEpochs(8)]);

    if (!user) {
      return NextResponse.json({
        epoch,
        recentEpochs: epochs,
      });
    }

    const summary = await getUserPointsSummary(user);
    return NextResponse.json({
      user,
      epoch,
      recentEpochs: epochs,
      summary,
    });
  } catch (error) {
    console.error("[HCLAW points] GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch points" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const activities = Array.isArray(body?.activities)
      ? (body.activities as HclawPointsActivityInput[])
      : null;

    if (!activities) {
      return NextResponse.json({ error: "activities array is required" }, { status: 400 });
    }

    const scored = scoreEpochActivities(activities);
    return NextResponse.json({
      scored,
      totals: {
        users: scored.length,
        totalPoints: scored.reduce((sum, row) => sum + row.breakdown.totalPoints, 0),
        excluded: scored.filter((row) => !row.eligible).length,
      },
    });
  } catch (error) {
    console.error("[HCLAW points] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to score points" },
      { status: 500 }
    );
  }
}
