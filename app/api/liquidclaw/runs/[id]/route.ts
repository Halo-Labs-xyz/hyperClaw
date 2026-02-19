import { NextRequest, NextResponse } from "next/server";
import { verifyApiKey, unauthorizedResponse } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BridgeRun = {
  intent?: unknown;
  execution?: unknown;
  verification?: unknown;
  updated_at: string;
};

type BridgeState = {
  runs: Map<string, BridgeRun>;
  receipt_to_intent: Map<string, string>;
  verification_to_intent: Map<string, string>;
};

type LookupResolution = {
  intentId: string;
  lookupKind: "intent_id" | "receipt_id" | "verification_id";
};

function getBridgeState(): BridgeState {
  const globals = globalThis as typeof globalThis & {
    __liquidclaw_bridge_state__?: BridgeState;
  };

  if (!globals.__liquidclaw_bridge_state__) {
    globals.__liquidclaw_bridge_state__ = {
      runs: new Map<string, BridgeRun>(),
      receipt_to_intent: new Map<string, string>(),
      verification_to_intent: new Map<string, string>(),
    };
  }

  return globals.__liquidclaw_bridge_state__;
}

function resolveIntentId(id: string, state: BridgeState): LookupResolution | null {
  if (state.runs.has(id)) return { intentId: id, lookupKind: "intent_id" };

  const byReceipt = state.receipt_to_intent.get(id);
  if (byReceipt) return { intentId: byReceipt, lookupKind: "receipt_id" };

  const byVerification = state.verification_to_intent.get(id);
  if (byVerification) {
    return { intentId: byVerification, lookupKind: "verification_id" };
  }

  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!verifyApiKey(request)) return unauthorizedResponse();

  const { id } = await params;
  const lookupId = id.trim();
  if (!lookupId) {
    return NextResponse.json({ error: "Run id is required" }, { status: 400 });
  }

  const state = getBridgeState();
  const resolution = resolveIntentId(lookupId, state);
  if (!resolution) {
    return NextResponse.json(
      { error: `Run '${lookupId}' not found` },
      { status: 404 }
    );
  }

  const run = state.runs.get(resolution.intentId);
  if (!run) {
    return NextResponse.json(
      { error: `Run '${lookupId}' not found` },
      { status: 404 }
    );
  }

  const stage = {
    intent: run.intent ? "completed" : "pending",
    execution: run.execution ? "completed" : "pending",
    verification: run.verification ? "completed" : "pending",
  };

  const lifecycle =
    stage.verification === "completed"
      ? "verified"
      : stage.execution === "completed"
        ? "executed"
        : stage.intent === "completed"
          ? "intent_accepted"
          : "missing";

  return NextResponse.json({
    run_id: resolution.intentId,
    lookup: {
      input: lookupId,
      kind: resolution.lookupKind,
    },
    lifecycle,
    stage,
    run,
  });
}
