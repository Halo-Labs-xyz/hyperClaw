import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error:
        "Direct Unit deposit address flow is disabled. Deposit into the configured EVM vault; backend relay handles operator-funded HL wallet credits.",
    },
    { status: 410 }
  );
}
