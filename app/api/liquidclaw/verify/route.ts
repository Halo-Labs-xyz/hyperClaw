import { randomUUID, createHash } from "crypto";
import { NextResponse } from "next/server";
import { verifyApiKey, unauthorizedResponse } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VerificationStatus = "pending" | "verified" | "failed";
type VerificationBackend = "eigencloud_primary" | "signed_fallback";

type VerificationRecord = {
  verification_id: string;
  receipt_id: string;
  backend: VerificationBackend;
  proof_ref: string;
  status: VerificationStatus;
  verified_at: string;
};

type BridgeRun = {
  intent?: unknown;
  execution?: { receipt_id?: string };
  verification?: VerificationRecord;
  updated_at: string;
};

type BridgeState = {
  runs: Map<string, BridgeRun>;
  receipt_to_intent: Map<string, string>;
  verification_to_intent: Map<string, string>;
};

type JsonMap = Record<string, unknown>;

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

function parseBackend(value: unknown): VerificationBackend {
  if (value === "eigencloud_primary") return value;
  return "signed_fallback";
}

function parseStatus(value: unknown): VerificationStatus {
  if (value === "pending" || value === "failed") return value;
  return "verified";
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function POST(request: Request) {
  if (!verifyApiKey(request)) return unauthorizedResponse();

  let body: JsonMap;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as JsonMap) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const receiptId =
    typeof body.receipt_id === "string" ? body.receipt_id.trim() : "";
  if (!receiptId) {
    return NextResponse.json(
      { error: "receipt_id is required" },
      { status: 400 }
    );
  }

  const state = getBridgeState();
  const intentId = state.receipt_to_intent.get(receiptId);
  if (!intentId) {
    return NextResponse.json(
      { error: `Unknown receipt_id '${receiptId}'` },
      { status: 404 }
    );
  }

  const run = state.runs.get(intentId);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const backend = parseBackend(body.backend);
  const status = parseStatus(body.status);
  const verifiedAt = new Date().toISOString();
  const verificationId = `ver_${randomUUID()}`;
  const proofRef =
    typeof body.proof_ref === "string" && body.proof_ref.trim().length > 0
      ? body.proof_ref.trim()
      : `local:${hashPayload({ receipt_id: receiptId, backend, status, verifiedAt })}`;

  const verification: VerificationRecord = {
    verification_id: verificationId,
    receipt_id: receiptId,
    backend,
    proof_ref: proofRef,
    status,
    verified_at: verifiedAt,
  };

  state.runs.set(intentId, {
    intent: run.intent,
    execution: run.execution,
    verification,
    updated_at: verifiedAt,
  });
  state.verification_to_intent.set(verificationId, intentId);

  return NextResponse.json({ accepted: true, verification }, { status: 202 });
}
