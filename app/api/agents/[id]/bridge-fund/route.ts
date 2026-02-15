import { NextResponse } from "next/server";

/**
 * Emergency bridge fund (Hyperunit/deBridge) — removed.
 * Use LI.FI in the Deposit tab to bridge directly.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "Emergency bridge fund removed. Use Bridge via LI.FI in the Deposit tab.",
    },
    { status: 410 }
  );
}
