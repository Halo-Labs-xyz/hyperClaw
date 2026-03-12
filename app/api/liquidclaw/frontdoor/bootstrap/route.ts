import { NextResponse } from "next/server";
import { frontdoorGatewayFetch } from "@/lib/liquidclaw-frontdoor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await frontdoorGatewayFetch<Record<string, unknown>>(
      "/api/frontdoor/bootstrap",
      {
        method: "GET",
      }
    );
    return NextResponse.json(payload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Frontdoor bootstrap request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
