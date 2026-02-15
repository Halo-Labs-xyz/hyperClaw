import { NextResponse } from "next/server";

/**
 * Direct Unit deposit address (Hyperunit) — removed.
 * Use LI.FI in the Deposit tab to bridge directly.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "Direct Unit deposit removed. Use Bridge via LI.FI in the Deposit tab.",
    },
    { status: 410 }
  );
}
