import { randomUUID, createHash } from "crypto";
import { NextResponse } from "next/server";
import { verifyApiKey, unauthorizedResponse } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonMap = Record<string, unknown>;

type IntentEnvelope = {
  intent_id: string;
  agent_id: string;
  user_id: string;
  strategy: JsonMap;
  risk_limits: JsonMap;
  market_context_hash: string;
  created_at: string;
};

type BridgeRun = {
  intent?: IntentEnvelope;
  execution?: unknown;
  verification?: unknown;
  updated_at: string;
};

type BridgeState = {
  runs: Map<string, BridgeRun>;
  receipt_to_intent: Map<string, string>;
  verification_to_intent: Map<string, string>;
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

function asObject(value: unknown): JsonMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonMap;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== "object") return value;

  const entries = Object.entries(value as JsonMap).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const out: JsonMap = {};
  for (const [key, nested] of entries) {
    out[key] = canonicalize(nested);
  }
  return out;
}

function hashPayload(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export async function POST(request: Request) {
  if (!verifyApiKey(request)) return unauthorizedResponse();

  let body: JsonMap;
  try {
    const parsed = await request.json();
    body = asObject(parsed) ?? {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  const strategy = asObject(body.strategy) ?? {};
  const riskLimits = asObject(body.risk_limits) ?? {};
  const marketContextHash =
    typeof body.market_context_hash === "string"
      ? body.market_context_hash.trim()
      : "";

  if (!agentId || !userId || !marketContextHash) {
    return NextResponse.json(
      {
        error:
          "agent_id, user_id, and market_context_hash are required string fields",
      },
      { status: 400 }
    );
  }

  const intentId =
    typeof body.intent_id === "string" && body.intent_id.trim().length > 0
      ? body.intent_id.trim()
      : `intent_${randomUUID()}`;

  const createdAt = new Date().toISOString();
  const intent: IntentEnvelope = {
    intent_id: intentId,
    agent_id: agentId,
    user_id: userId,
    strategy,
    risk_limits: riskLimits,
    market_context_hash: marketContextHash,
    created_at: createdAt,
  };
  const intentHash = hashPayload(intent);

  const state = getBridgeState();
  const previous = state.runs.get(intentId);
  state.runs.set(intentId, {
    intent,
    execution: previous?.execution,
    verification: previous?.verification,
    updated_at: createdAt,
  });

  return NextResponse.json(
    {
      accepted: true,
      intent,
      intent_hash: intentHash,
      run_id: intentId,
      stage: {
        intent: "completed",
        execution: previous?.execution ? "completed" : "pending",
        verification: previous?.verification ? "completed" : "pending",
      },
    },
    { status: 202 }
  );
}
