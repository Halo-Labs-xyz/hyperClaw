import { randomUUID, createHash } from "crypto";
import { NextResponse } from "next/server";
import { verifyApiKey, unauthorizedResponse } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonMap = Record<string, unknown>;

type InformationSharingScope =
  | "none"
  | "signals_only"
  | "signals_and_execution"
  | "full_audit";

type CopyTradingProfile = {
  max_allocation_usd: string;
  per_trade_notional_cap_usd: string;
  max_leverage: string;
  symbol_allowlist: string[];
  symbol_denylist: string[];
  max_slippage_bps: number;
  information_sharing_scope: InformationSharingScope;
};

type A2aSignalPublicationContract = {
  kind: "signal_publication";
  signal_id: string;
  provider_id: string;
  signal_hash: string;
  symbol: string;
  side: "buy" | "sell";
  confidence_bps: number;
  price_ref: string;
};

type A2aPolicyNegotiationContract = {
  kind: "policy_negotiation";
  negotiation_id: string;
  requester_agent_id: string;
  source_agent_id: string;
  natural_language_policy: string;
  compiled_policy_hash: string;
  fee_schedule: {
    fixed_fee_bps: number;
    performance_fee_bps: number;
    max_fee_usd: string;
  };
};

type A2aExecutionIntentContract = {
  kind: "execution_intent";
  execution_intent_id: string;
  source_signal_hash: string;
  policy_hash: string;
  profile_hash: string;
  wallet_attestation_hash: string;
  expected_notional: string;
  expected_leverage: string;
};

type A2aCopyTradingMessage =
  | A2aSignalPublicationContract
  | A2aPolicyNegotiationContract
  | A2aExecutionIntentContract;

type ProviderAttribution = {
  provider_id: string;
  signal_id: string;
  signal_hash: string;
  attribution_weight_bps: number;
  fixed_fee_bps: number;
  performance_fee_bps: number;
};

type IntentEnvelope = {
  intent_id: string;
  agent_id: string;
  user_id: string;
  strategy: JsonMap;
  risk_limits: JsonMap;
  market_context_hash: string;
  created_at: string;
  copytrading_profile?: CopyTradingProfile;
  natural_language_policy?: string;
  source_signal_hash?: string;
  wallet_attestation_hash?: string;
  provider_attributions?: ProviderAttribution[];
  a2a_message?: A2aCopyTradingMessage;
};

type BridgeRun = {
  intent?: IntentEnvelope;
  execution?: unknown;
  verification?: unknown;
  settlement?: unknown;
  updated_at: string;
};

type BridgeState = {
  runs: Map<string, BridgeRun>;
  receipt_to_intent: Map<string, string>;
  verification_to_intent: Map<string, string>;
  settlement_to_intent: Map<string, string>;
};

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
      settlement_to_intent: new Map<string, string>(),
    };
  }

  return globals.__liquidclaw_bridge_state__;
}

function asObject(value: unknown): JsonMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonMap;
}

function getStringField(value: unknown, key: string): string | null {
  const obj = asObject(value);
  const field = obj?.[key];
  return typeof field === "string" && field.trim().length > 0 ? field : null;
}

function getVerificationStage(value: unknown): VerificationStage {
  const status = getStringField(value, "status");
  if (status === "verified") return "completed";
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return value ? "completed" : "pending";
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

function isHash64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function parseDecimalString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed) && Number(trimmed) > 0) return trimmed;
  }
  return null;
}

function parseCopyTradingProfile(value: unknown): CopyTradingProfile | null {
  const input = asObject(value);
  if (!input) return null;

  const maxAllocation = parseDecimalString(input.max_allocation_usd);
  const perTradeCap = parseDecimalString(input.per_trade_notional_cap_usd);
  const maxLeverage = parseDecimalString(input.max_leverage);
  const maxSlippage =
    typeof input.max_slippage_bps === "number" &&
    Number.isInteger(input.max_slippage_bps) &&
    input.max_slippage_bps > 0
      ? input.max_slippage_bps
      : null;
  const scope =
    typeof input.information_sharing_scope === "string"
      ? input.information_sharing_scope.trim().toLowerCase()
      : "signals_only";
  const sharingScope: InformationSharingScope =
    scope === "none" ||
    scope === "signals_only" ||
    scope === "signals_and_execution" ||
    scope === "full_audit"
      ? scope
      : "signals_only";

  if (!maxAllocation || !perTradeCap || !maxLeverage || maxSlippage === null) {
    return null;
  }

  const allowlist = Array.isArray(input.symbol_allowlist)
    ? input.symbol_allowlist
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toUpperCase())
        .filter((item) => item.length > 0)
    : [];
  const denylist = Array.isArray(input.symbol_denylist)
    ? input.symbol_denylist
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toUpperCase())
        .filter((item) => item.length > 0)
    : [];

  if (allowlist.length === 0) return null;

  return {
    max_allocation_usd: maxAllocation,
    per_trade_notional_cap_usd: perTradeCap,
    max_leverage: maxLeverage,
    symbol_allowlist: allowlist,
    symbol_denylist: denylist,
    max_slippage_bps: maxSlippage,
    information_sharing_scope: sharingScope,
  };
}

function parseProviderAttributions(value: unknown): ProviderAttribution[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asObject(item))
    .filter((item): item is JsonMap => !!item)
    .map((item) => ({
      provider_id:
        typeof item.provider_id === "string" ? item.provider_id.trim() : "",
      signal_id: typeof item.signal_id === "string" ? item.signal_id.trim() : "",
      signal_hash:
        typeof item.signal_hash === "string" ? item.signal_hash.trim() : "",
      attribution_weight_bps:
        typeof item.attribution_weight_bps === "number"
          ? Math.max(0, Math.floor(item.attribution_weight_bps))
          : 0,
      fixed_fee_bps:
        typeof item.fixed_fee_bps === "number"
          ? Math.max(0, Math.floor(item.fixed_fee_bps))
          : 0,
      performance_fee_bps:
        typeof item.performance_fee_bps === "number"
          ? Math.max(0, Math.floor(item.performance_fee_bps))
          : 0,
    }))
    .filter(
      (item) =>
        item.provider_id.length > 0 &&
        item.signal_id.length > 0 &&
        isHash64(item.signal_hash) &&
        item.attribution_weight_bps > 0
    );
}

function parseA2aMessage(value: unknown): A2aCopyTradingMessage | null {
  const input = asObject(value);
  if (!input || typeof input.kind !== "string") return null;

  const kind = input.kind.trim().toLowerCase();
  if (kind === "signal_publication") {
    const signalId = typeof input.signal_id === "string" ? input.signal_id.trim() : "";
    const providerId =
      typeof input.provider_id === "string" ? input.provider_id.trim() : "";
    const signalHash =
      typeof input.signal_hash === "string" ? input.signal_hash.trim() : "";
    const symbol = typeof input.symbol === "string" ? input.symbol.trim().toUpperCase() : "";
    const sideRaw = typeof input.side === "string" ? input.side.trim().toLowerCase() : "";
    const confidenceBps =
      typeof input.confidence_bps === "number" ? Math.floor(input.confidence_bps) : 0;
    const priceRef = parseDecimalString(input.price_ref);

    if (
      !signalId ||
      !providerId ||
      !isHash64(signalHash) ||
      !symbol ||
      (sideRaw !== "buy" && sideRaw !== "sell") ||
      confidenceBps <= 0 ||
      !priceRef
    ) {
      return null;
    }

    return {
      kind: "signal_publication",
      signal_id: signalId,
      provider_id: providerId,
      signal_hash: signalHash,
      symbol,
      side: sideRaw,
      confidence_bps: confidenceBps,
      price_ref: priceRef,
    };
  }

  if (kind === "policy_negotiation") {
    const negotiationId =
      typeof input.negotiation_id === "string" ? input.negotiation_id.trim() : "";
    const requester =
      typeof input.requester_agent_id === "string"
        ? input.requester_agent_id.trim()
        : "";
    const source =
      typeof input.source_agent_id === "string" ? input.source_agent_id.trim() : "";
    const policy =
      typeof input.natural_language_policy === "string"
        ? input.natural_language_policy.trim()
        : "";
    const policyHash =
      typeof input.compiled_policy_hash === "string"
        ? input.compiled_policy_hash.trim()
        : "";

    const feeSchedule = asObject(input.fee_schedule);
    const fixedFeeBps =
      feeSchedule && typeof feeSchedule.fixed_fee_bps === "number"
        ? Math.max(0, Math.floor(feeSchedule.fixed_fee_bps))
        : 0;
    const performanceFeeBps =
      feeSchedule && typeof feeSchedule.performance_fee_bps === "number"
        ? Math.max(0, Math.floor(feeSchedule.performance_fee_bps))
        : 0;
    const maxFeeUsd = parseDecimalString(feeSchedule?.max_fee_usd);

    if (
      !negotiationId ||
      !requester ||
      !source ||
      !policy ||
      !isHash64(policyHash) ||
      !maxFeeUsd
    ) {
      return null;
    }

    return {
      kind: "policy_negotiation",
      negotiation_id: negotiationId,
      requester_agent_id: requester,
      source_agent_id: source,
      natural_language_policy: policy,
      compiled_policy_hash: policyHash,
      fee_schedule: {
        fixed_fee_bps: fixedFeeBps,
        performance_fee_bps: performanceFeeBps,
        max_fee_usd: maxFeeUsd,
      },
    };
  }

  if (kind === "execution_intent") {
    const executionIntentId =
      typeof input.execution_intent_id === "string"
        ? input.execution_intent_id.trim()
        : "";
    const sourceSignalHash =
      typeof input.source_signal_hash === "string"
        ? input.source_signal_hash.trim()
        : "";
    const policyHash =
      typeof input.policy_hash === "string" ? input.policy_hash.trim() : "";
    const profileHash =
      typeof input.profile_hash === "string" ? input.profile_hash.trim() : "";
    const walletAttestationHash =
      typeof input.wallet_attestation_hash === "string"
        ? input.wallet_attestation_hash.trim()
        : "";
    const expectedNotional = parseDecimalString(input.expected_notional);
    const expectedLeverage = parseDecimalString(input.expected_leverage);

    if (
      !executionIntentId ||
      !isHash64(sourceSignalHash) ||
      !isHash64(policyHash) ||
      !isHash64(profileHash) ||
      !isHash64(walletAttestationHash) ||
      !expectedNotional ||
      !expectedLeverage
    ) {
      return null;
    }

    return {
      kind: "execution_intent",
      execution_intent_id: executionIntentId,
      source_signal_hash: sourceSignalHash,
      policy_hash: policyHash,
      profile_hash: profileHash,
      wallet_attestation_hash: walletAttestationHash,
      expected_notional: expectedNotional,
      expected_leverage: expectedLeverage,
    };
  }

  return null;
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

  const copyProfile =
    body.copytrading_profile !== undefined
      ? parseCopyTradingProfile(body.copytrading_profile)
      : null;
  if (body.copytrading_profile !== undefined && !copyProfile) {
    return NextResponse.json(
      { error: "Invalid copytrading_profile" },
      { status: 400 }
    );
  }

  const policyText =
    typeof body.natural_language_policy === "string"
      ? body.natural_language_policy.trim()
      : undefined;
  const sourceSignalHash =
    typeof body.source_signal_hash === "string"
      ? body.source_signal_hash.trim()
      : undefined;
  const walletAttestationHash =
    typeof body.wallet_attestation_hash === "string"
      ? body.wallet_attestation_hash.trim()
      : undefined;
  if (sourceSignalHash && !isHash64(sourceSignalHash)) {
    return NextResponse.json(
      { error: "source_signal_hash must be 64-char lowercase hex" },
      { status: 400 }
    );
  }
  if (walletAttestationHash && !isHash64(walletAttestationHash)) {
    return NextResponse.json(
      { error: "wallet_attestation_hash must be 64-char lowercase hex" },
      { status: 400 }
    );
  }

  const a2aMessage = parseA2aMessage(body.a2a_message);
  if (body.a2a_message !== undefined && !a2aMessage) {
    return NextResponse.json(
      { error: "Invalid a2a_message contract" },
      { status: 400 }
    );
  }

  const providerAttributions = parseProviderAttributions(body.provider_attributions);

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
    copytrading_profile: copyProfile ?? undefined,
    natural_language_policy: policyText || undefined,
    source_signal_hash: sourceSignalHash || undefined,
    wallet_attestation_hash: walletAttestationHash || undefined,
    provider_attributions:
      providerAttributions.length > 0 ? providerAttributions : undefined,
    a2a_message: a2aMessage ?? undefined,
  };
  const intentHash = hashPayload(intent);

  const state = getBridgeState();
  const previous = state.runs.get(intentId);
  const previousIntentHash = previous?.intent ? hashPayload(previous.intent) : null;
  const intentChanged = Boolean(previousIntentHash && previousIntentHash !== intentHash);
  const nextExecution = intentChanged ? undefined : previous?.execution;
  const nextVerification = intentChanged ? undefined : previous?.verification;
  const nextSettlement = intentChanged ? undefined : previous?.settlement;

  if (intentChanged) {
    const previousReceiptId = getStringField(previous?.execution, "receipt_id");
    if (previousReceiptId) {
      state.receipt_to_intent.delete(previousReceiptId);
    }

    const previousVerificationId = getStringField(previous?.verification, "verification_id");
    if (previousVerificationId) {
      state.verification_to_intent.delete(previousVerificationId);
    }

    const previousSettlementId = getStringField(previous?.settlement, "settlement_id");
    if (previousSettlementId) {
      state.settlement_to_intent.delete(previousSettlementId);
    }
  }

  state.runs.set(intentId, {
    intent,
    execution: nextExecution,
    verification: nextVerification,
    settlement: nextSettlement,
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
        execution: nextExecution ? "completed" : "pending",
        verification: getVerificationStage(nextVerification),
      },
      a2a_contract: a2aMessage,
      policy_hash: policyText ? hashPayload({ policy: policyText }) : undefined,
      profile_hash: copyProfile ? hashPayload(copyProfile) : undefined,
    },
    { status: 202 }
  );
}
