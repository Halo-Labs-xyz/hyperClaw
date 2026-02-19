import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { verifyApiKey, unauthorizedResponse } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonMap = Record<string, unknown>;

type SimulatedFill = {
  quantity: string;
  price: string;
};

type ExecutionReceipt = {
  receipt_id: string;
  intent_id: string;
  intent_hash: string;
  mode: "paper" | "live";
  symbol: string;
  side: "buy" | "sell";
  notional: string;
  price_ref: string;
  simulated_fills: SimulatedFill[];
  decision_hash: string;
  receipt_hash: string;
  created_at: string;
};

type BridgeRun = {
  intent?: unknown;
  execution?: ExecutionReceipt;
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

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toDecimal(value: number, places: number): string {
  return value.toFixed(places).replace(/\.?0+$/, "");
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

  const intentId = typeof body.intent_id === "string" ? body.intent_id.trim() : "";
  const modeRaw = typeof body.mode === "string" ? body.mode.trim().toLowerCase() : "paper";
  const symbolRaw = typeof body.symbol === "string" ? body.symbol.trim() : "";
  const sideRaw = typeof body.side === "string" ? body.side.trim().toLowerCase() : "";
  const notional = parseFiniteNumber(body.notional);
  const priceRef = parseFiniteNumber(body.price_ref);
  const symbol = symbolRaw.toUpperCase();

  if (!intentId || !symbol || !["buy", "sell"].includes(sideRaw)) {
    return NextResponse.json(
      { error: "intent_id, symbol, and side (buy|sell) are required" },
      { status: 400 }
    );
  }
  if (notional === null || notional <= 0 || priceRef === null || priceRef <= 0) {
    return NextResponse.json(
      { error: "notional and price_ref must be positive numbers" },
      { status: 400 }
    );
  }

  if (!["paper", "live"].includes(modeRaw)) {
    return NextResponse.json(
      { error: "mode must be either 'paper' or 'live'" },
      { status: 400 }
    );
  }
  const mode: "paper" | "live" = modeRaw === "live" ? "live" : "paper";
  const side: "buy" | "sell" = sideRaw === "sell" ? "sell" : "buy";

  const state = getBridgeState();
  const previous = state.runs.get(intentId);
  if (!previous?.intent) {
    return NextResponse.json(
      { error: `No intent found for intent_id '${intentId}'` },
      { status: 409 }
    );
  }
  const intentHash = hashPayload(previous.intent);

  const quantity = notional / priceRef;
  const qtyA = quantity * 0.6;
  const qtyB = quantity - qtyA;
  const priceA = side === "buy" ? priceRef * 1.0005 : priceRef * 0.9995;
  const priceB = side === "buy" ? priceRef * 1.001 : priceRef * 0.999;

  const simulatedFills: SimulatedFill[] = [
    { quantity: toDecimal(qtyA, 8), price: toDecimal(priceA, 8) },
    { quantity: toDecimal(qtyB, 8), price: toDecimal(priceB, 8) },
  ];

  const decisionHash = hashPayload({
    intent_id: intentId,
    intent_hash: intentHash,
    mode,
    symbol,
    side,
    notional: toDecimal(notional, 8),
    price_ref: toDecimal(priceRef, 8),
    simulated_fills: simulatedFills,
  });

  const createdAt = new Date().toISOString();
  const receiptId = `rcpt_${decisionHash.slice(0, 24)}`;
  const receiptHash = hashPayload({
    receipt_id: receiptId,
    intent_id: intentId,
    intent_hash: intentHash,
    mode,
    symbol,
    side,
    notional: toDecimal(notional, 8),
    price_ref: toDecimal(priceRef, 8),
    simulated_fills: simulatedFills,
    decision_hash: decisionHash,
  });
  const receipt: ExecutionReceipt = {
    receipt_id: receiptId,
    intent_id: intentId,
    intent_hash: intentHash,
    mode,
    symbol,
    side,
    notional: toDecimal(notional, 8),
    price_ref: toDecimal(priceRef, 8),
    simulated_fills: simulatedFills,
    decision_hash: decisionHash,
    receipt_hash: receiptHash,
    created_at: createdAt,
  };

  state.runs.set(intentId, {
    intent: previous?.intent,
    execution: receipt,
    verification: previous?.verification,
    updated_at: createdAt,
  });
  state.receipt_to_intent.set(receipt.receipt_id, intentId);

  return NextResponse.json(
    {
      accepted: true,
      execution: receipt,
      stage: {
        intent: "completed",
        execution: "completed",
        verification: previous?.verification ? "completed" : "pending",
      },
    },
    { status: 202 }
  );
}
