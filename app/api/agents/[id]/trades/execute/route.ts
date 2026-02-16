import { NextResponse } from "next/server";
import { verifyApiKey, unauthorizedResponse } from "@/lib/auth";
import { getAgent, getTradeLogsForAgent } from "@/lib/store";
import { executeTradeDecisionNow } from "@/lib/agent-runner";

/**
 * POST /api/agents/[id]/trades/execute
 *
 * Execute a skipped trade decision immediately.
 *
 * Body: { tradeId: string }
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  if (!verifyApiKey(request)) return unauthorizedResponse();

  const agentId = params.id;

  try {
    const body = await request.json().catch(() => ({}));
    const tradeId = typeof body?.tradeId === "string" ? body.tradeId.trim() : "";
    if (!tradeId) {
      return NextResponse.json(
        { error: "tradeId is required" },
        { status: 400 }
      );
    }

    const agent = await getAgent(agentId);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const trades = await getTradeLogsForAgent(agentId);
    const skippedTrade = trades.find((t) => t.id === tradeId);
    if (!skippedTrade) {
      return NextResponse.json({ error: "Trade not found" }, { status: 404 });
    }

    if (skippedTrade.executed) {
      return NextResponse.json(
        { error: "Trade is already executed" },
        { status: 409 }
      );
    }

    if (skippedTrade.decision.action === "hold") {
      return NextResponse.json(
        { error: "Hold decisions cannot be executed" },
        { status: 400 }
      );
    }

    const tradeLog = await executeTradeDecisionNow(agentId, skippedTrade.decision, {
      sourceTradeId: skippedTrade.id,
    });

    if (!tradeLog.executed) {
      const reason = tradeLog.executionResult?.reason || tradeLog.decision.reasoning || "Execution failed";
      return NextResponse.json(
        { error: reason, tradeLog },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Trade executed in real time",
      tradeLog,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Trade execution failed" },
      { status: 500 }
    );
  }
}

