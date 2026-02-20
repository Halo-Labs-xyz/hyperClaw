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
  verification_hash: string;
  verified_at: string;
};

type BridgeRun = {
  intent?: unknown;
  execution?: { receipt_id?: string; receipt_hash?: string };
  verification?: VerificationRecord;
  updated_at: string;
};

type BridgeState = {
  runs: Map<string, BridgeRun>;
  receipt_to_intent: Map<string, string>;
  verification_to_intent: Map<string, string>;
};

type JsonMap = Record<string, unknown>;
type VerificationStage = "pending" | "completed" | "failed";

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

function parseBackend(value: unknown): VerificationBackend | null {
  if (value === undefined) return "signed_fallback";
  if (value === "eigencloud_primary" || value === "signed_fallback") return value;
  return null;
}

function parseStatus(value: unknown): VerificationStatus | null {
  if (value === undefined) return "verified";
  if (value === "pending" || value === "verified" || value === "failed") return value;
  return null;
}

function stageFromVerificationStatus(status: VerificationStatus): VerificationStage {
  if (status === "verified") return "completed";
  if (status === "failed") return "failed";
  return "pending";
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
  if (!run.execution?.receipt_id || run.execution.receipt_id !== receiptId) {
    return NextResponse.json(
      { error: `No execution found for receipt_id '${receiptId}'` },
      { status: 409 }
    );
  }

  const providedReceiptHash =
    typeof body.receipt_hash === "string" ? body.receipt_hash.trim() : "";
  if (
    providedReceiptHash &&
    run.execution.receipt_hash &&
    providedReceiptHash !== run.execution.receipt_hash
  ) {
    return NextResponse.json(
      { error: `receipt_hash mismatch for receipt_id '${receiptId}'` },
      { status: 409 }
    );
  }

  const backend = parseBackend(body.backend);
  const status = parseStatus(body.status);
  if (!backend) {
    return NextResponse.json(
      { error: "backend must be 'eigencloud_primary' or 'signed_fallback'" },
      { status: 400 }
    );
  }
  if (!status) {
    return NextResponse.json(
      { error: "status must be 'pending', 'verified', or 'failed'" },
      { status: 400 }
    );
  }
  const verifiedAt = new Date().toISOString();
  const verificationId = `ver_${randomUUID()}`;
  const proofRef =
    typeof body.proof_ref === "string" && body.proof_ref.trim().length > 0
      ? body.proof_ref.trim()
      : `local:${hashPayload({ receipt_id: receiptId, backend, status, verifiedAt })}`;
  const verificationHash = hashPayload({
    verification_id: verificationId,
    receipt_id: receiptId,
    backend,
    proof_ref: proofRef,
    status,
    receipt_hash: run.execution.receipt_hash ?? null,
  });

  const verification: VerificationRecord = {
    verification_id: verificationId,
    receipt_id: receiptId,
    backend,
    proof_ref: proofRef,
    status,
    verification_hash: verificationHash,
    verified_at: verifiedAt,
  };

  const previousVerificationId =
    run.verification && typeof run.verification.verification_id === "string"
      ? run.verification.verification_id
      : null;
  if (previousVerificationId) {
    state.verification_to_intent.delete(previousVerificationId);
  }

  state.runs.set(intentId, {
    intent: run.intent,
    execution: run.execution,
    verification,
    updated_at: verifiedAt,
  });
  state.verification_to_intent.set(verificationId, intentId);

  return NextResponse.json(
    {
      accepted: true,
      run_id: intentId,
      verification,
      stage: {
        intent: run.intent ? "completed" : "missing",
        execution: run.execution ? "completed" : "missing",
        verification: stageFromVerificationStatus(status),
      },
    },
    { status: 202 }
  );
}
