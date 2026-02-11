import { NextResponse } from "next/server";
import { getAgenticVaultStatus, getTreasurySummary, recordTreasuryFlow } from "@/lib/agentic-vault";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Number.parseInt(searchParams.get("limit") || "200", 10);

    const [summary, agenticVault] = await Promise.all([
      getTreasurySummary(Number.isFinite(limit) ? limit : 200),
      getAgenticVaultStatus(),
    ]);

    return NextResponse.json({
      ...summary,
      agenticVault,
    });
  } catch (error) {
    console.error("[HCLAW treasury] GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch treasury summary" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();

    const ts = Number(body?.ts ?? Date.now());
    const source = typeof body?.source === "string" ? body.source : "manual";
    const amountUsd = Number(body?.amountUsd ?? 0);
    const buybackUsd = Number(body?.buybackUsd ?? 0);
    const incentiveUsd = Number(body?.incentiveUsd ?? 0);
    const reserveUsd = Number(body?.reserveUsd ?? 0);
    const txHash = typeof body?.txHash === "string" ? body.txHash : null;

    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return NextResponse.json({ error: "amountUsd must be > 0" }, { status: 400 });
    }

    await recordTreasuryFlow({
      ts: Number.isFinite(ts) ? ts : Date.now(),
      source,
      amountUsd,
      buybackUsd,
      incentiveUsd,
      reserveUsd,
      txHash,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[HCLAW treasury] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to record treasury flow" },
      { status: 500 }
    );
  }
}
