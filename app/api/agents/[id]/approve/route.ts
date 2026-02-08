import { NextResponse } from "next/server";
import { executeApprovedTrade } from "@/lib/agent-runner";
import { getAgent, updateAgent } from "@/lib/store";

/**
 * POST /api/agents/[id]/approve
 *
 * Approve or reject a pending trade for semi-autonomous agents.
 *
 * Body: { approvalId: string, action: "approve" | "reject" }
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const agentId = params.id;

  try {
    const body = await request.json();
    const { approvalId, action } = body;

    if (!approvalId || !action) {
      return NextResponse.json(
        { error: "approvalId and action are required" },
        { status: 400 }
      );
    }

    const agent = await getAgent(agentId);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    if (action === "approve") {
      const tradeLog = await executeApprovedTrade(agentId, approvalId);
      return NextResponse.json({
        success: true,
        message: "Trade approved and executed",
        tradeLog,
      });
    } else if (action === "reject") {
      if (agent.pendingApproval && agent.pendingApproval.id === approvalId) {
        await updateAgent(agentId, {
          pendingApproval: { ...agent.pendingApproval, status: "rejected" },
        });
      }
      return NextResponse.json({
        success: true,
        message: "Trade rejected",
      });
    } else {
      return NextResponse.json(
        { error: "action must be 'approve' or 'reject'" },
        { status: 400 }
      );
    }
  } catch (error) {
    console.error("Approval error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Approval failed" },
      { status: 500 }
    );
  }
}
