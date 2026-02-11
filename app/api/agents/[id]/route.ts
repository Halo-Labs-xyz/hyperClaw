import { NextResponse } from "next/server";
import { getAgent, updateAgent, deleteAgent, getTradeLogsForAgent } from "@/lib/store";
import { getAccountForAgent } from "@/lib/account-manager";
import { stopAgent } from "@/lib/agent-runner";
import { handleStatusChange, getLifecycleState } from "@/lib/agent-lifecycle";

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const agent = await getAgent(params.id);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Resolve hlAddress from account-manager (source of truth for HL wallet)
    const account = await getAccountForAgent(params.id);
    const resolvedAgent = { ...agent, hlAddress: account?.address ?? agent.hlAddress };

    const trades = await getTradeLogsForAgent(params.id);
    const lifecycle = getLifecycleState(params.id);

    return NextResponse.json({ agent: resolvedAgent, trades, lifecycle });
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
    // Get current agent to check for status change
    const currentAgent = await getAgent(params.id);
    if (!currentAgent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const body = await request.json();
    const agent = await updateAgent(params.id, body);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // If status changed, trigger lifecycle management
    if (body.status && body.status !== currentAgent.status) {
      console.log(`[Agent ${params.id}] Status changed: ${currentAgent.status} -> ${body.status}`);
      try {
        await handleStatusChange(params.id, body.status);
      } catch (lifecycleError) {
        console.error(`[Agent ${params.id}] Lifecycle change failed:`, lifecycleError);
        // Don't fail the update if lifecycle fails
      }
    }

    const lifecycle = getLifecycleState(params.id);
    return NextResponse.json({ agent, lifecycle });
  } catch (error) {
    console.error("Update agent error:", error);
    return NextResponse.json(
      { error: "Failed to update agent" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    // Stop the agent runner if it's running
    try {
      await stopAgent(params.id);
    } catch {
      // Agent runner might not be running, that's OK
    }

    const deleted = await deleteAgent(params.id);
    if (!deleted) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, message: "Agent deleted" });
  } catch (error) {
    console.error("Delete agent error:", error);
    return NextResponse.json(
      { error: "Failed to delete agent" },
      { status: 500 }
    );
  }
}
