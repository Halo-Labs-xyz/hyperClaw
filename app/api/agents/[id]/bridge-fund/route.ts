import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error:
        "Deposit bridging is disabled. Use vault deposit flow; relay funds agent HL wallet directly from operator USDC.",
    },
    { status: 410 }
  );
}
