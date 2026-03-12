/**
 * POST /api/unibase/invoke/[agentId]
 * 
 * A2A Protocol endpoint for invoking an AIP agent.
 * This is called by the AIP Gateway in DIRECT mode.
 * Enforces x402 payment verification bound to the configured EVM chain.
 */

import { NextRequest, NextResponse } from "next/server";
import { invokeAIPAgent, type A2AContext } from "@/lib/unibase-aip";
import { verifyX402Payment } from "@/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InvokeRequest {
  message: string;
  conversation_id?: string;
  user_id: string;
  payment_verified?: boolean;
  payment?: Record<string, unknown>;
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

    const x402Verification = verifyX402Payment(req, body);
    if (!x402Verification.ok) {
      const headers = new Headers();
      if (x402Verification.status === 402) {
        headers.set("x-payment-required", "x402");
        headers.set("x-required-network", "evm");
        headers.set("x-required-chain-id", String(x402Verification.expectedChainId));
      }

      return NextResponse.json(
        {
          error: x402Verification.message,
          code: x402Verification.code,
          required: {
            protocol: "x402",
            network: "evm",
            chain_id: x402Verification.expectedChainId,
          },
          observed: {
            chain_id: x402Verification.observedChainId,
            chain: x402Verification.observedChain,
          },
        },
        { status: x402Verification.status, headers }
      );
    }

    // Build A2A context
    const context: A2AContext = {
      message: body.message,
      conversation_id: body.conversation_id || `conv_${Date.now()}`,
      user_id: body.user_id,
      agent_id: agentId,
      payment_verified: true,
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
