import { NextResponse } from "next/server";
import { closeEpoch, getCurrentEpochInfo, type HclawPointsActivityInput } from "@/lib/hclaw-points";
import { verifyHclawEpochCloseAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const epoch = await getCurrentEpochInfo();
    return NextResponse.json({ epoch });
  } catch (error) {
    console.error("[HCLAW epoch close] GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch epoch" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  if (!verifyHclawEpochCloseAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const epochId = typeof body?.epochId === "string" ? body.epochId : undefined;
    const rootHash = typeof body?.rootHash === "string" ? body.rootHash : undefined;

    const activities = Array.isArray(body?.activities)
      ? (body.activities as HclawPointsActivityInput[])
      : [];

    const result = await closeEpoch({
      epochId,
      rootHash,
      activities,
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("[HCLAW epoch close] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to close epoch" },
      { status: 500 }
    );
  }
}
