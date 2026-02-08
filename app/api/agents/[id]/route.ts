import { NextResponse } from "next/server";
import { getAgent, updateAgent, getTradeLogsForAgent } from "@/lib/store";

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const agent = await getAgent(params.id);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const trades = await getTradeLogsForAgent(params.id);

    return NextResponse.json({ agent, trades });
  } catch (error) {
    console.error("Get agent error:", error);
    return NextResponse.json(
      { error: "Failed to fetch agent" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const agent = await updateAgent(params.id, body);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    return NextResponse.json({ agent });
  } catch (error) {
    console.error("Update agent error:", error);
    return NextResponse.json(
      { error: "Failed to update agent" },
      { status: 500 }
    );
  }
}
