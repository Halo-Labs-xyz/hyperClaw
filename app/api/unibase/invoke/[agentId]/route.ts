/**
 * POST /api/unibase/invoke/[agentId]
 * 
 * A2A Protocol endpoint for invoking an AIP agent.
 * This is called by the AIP Gateway in DIRECT mode.
 */

import { NextRequest, NextResponse } from "next/server";
import { invokeAIPAgent, type A2AContext } from "@/lib/unibase-aip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InvokeRequest {
  message: string;
  conversation_id?: string;
  user_id: string;
  payment_verified?: boolean;
  memory?: any[];
  metadata?: Record<string, any>;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  try {
    const { agentId } = await params;
    const body: InvokeRequest = await req.json();

    if (!body.message || !body.user_id) {
      return NextResponse.json(
        { error: "message and user_id are required" },
        { status: 400 }
      );
    }

    // Build A2A context
    const context: A2AContext = {
      message: body.message,
      conversation_id: body.conversation_id || `conv_${Date.now()}`,
      user_id: body.user_id,
      agent_id: agentId,
      payment_verified: body.payment_verified || false, // Gateway sets this
      memory: body.memory || [],
    };

    // Invoke agent handler
    const response = await invokeAIPAgent(agentId, context);

    return NextResponse.json({
      success: true,
      agent_id: agentId,
      response: response.content,
      metadata: response.metadata,
      memory_update: response.memory_update,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("[AIP Invoke] Error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Invocation failed",
      },
      { status: 500 }
    );
  }
}
