import { timingSafeEqual } from "crypto";
import { getNetworkState } from "@/lib/network";

type JsonRecord = Record<string, unknown>;

export interface X402VerificationSuccess {
  ok: true;
  expectedChainId: number;
  observedChainId?: number;
  observedChain?: string;
}

export interface X402VerificationFailure {
  ok: false;
  status: number;
  code:
    | "x402_gateway_key_missing"
    | "x402_gateway_unauthorized"
    | "x402_payment_required"
    | "x402_chain_mismatch";
  message: string;
  expectedChainId: number;
  observedChainId?: number;
  observedChain?: string;
}

export type X402VerificationResult = X402VerificationSuccess | X402VerificationFailure;

const TRUE_STRINGS = new Set(["1", "true", "yes", "ok", "paid", "verified", "success"]);
const FALSE_STRINGS = new Set(["0", "false", "no", "unpaid", "failed", "rejected"]);

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function getFirstRecord(record: JsonRecord | null, keys: string[]): JsonRecord | null {
  if (!record) return null;
  for (const key of keys) {
    const nested = asRecord(record[key]);
    if (nested) return nested;
  }
  return null;
}

function getFirstString(record: JsonRecord | null, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (TRUE_STRINGS.has(normalized)) return true;
  if (FALSE_STRINGS.has(normalized)) return false;
  return undefined;
}

function parseNumberLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 0);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function firstHeader(request: Request, names: string[]): string | undefined {
  for (const name of names) {
    const value = request.headers.get(name);
    if (!value) continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseCommaList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function getExpectedChainAliases(expectedChainId: number): string[] {
  const configured = parseCommaList(
    process.env.X402_REQUIRED_CHAIN_NAME || process.env.X402_REQUIRED_NETWORK
  );
  if (configured.length > 0) return configured;

  if (expectedChainId === 143) return ["monad", "mainnet"];
  if (expectedChainId === 10143) return ["monad", "testnet"];
  if (expectedChainId === 1) return ["ethereum", "eth", "mainnet"];
  if (expectedChainId === 11155111) return ["sepolia", "testnet"];
  return ["evm"];
}

function matchesExpectedEvmNetwork(chain: string, expectedChainId: number): boolean {
  const normalized = chain.toLowerCase();
  const aliases = getExpectedChainAliases(expectedChainId);
  const matchesAlias = aliases.some((alias) => normalized.includes(alias));
  if (!matchesAlias) return false;

  const mentionsTestnet = normalized.includes("testnet");
  const mentionsMainnet = normalized.includes("mainnet");

  if (expectedChainId === 10143 && mentionsMainnet) return false;
  if (expectedChainId === 143 && mentionsTestnet) return false;
  return true;
}

function resolveExpectedChainId(): number {
  const envValue =
    parseNumberLike(process.env.X402_CHAIN_ID) ??
    parseNumberLike(process.env.X402_MONAD_CHAIN_ID);
  if (envValue !== undefined && envValue > 0) return envValue;
  const defaultMainnetChainId =
    parseNumberLike(process.env.NEXT_PUBLIC_EVM_MAINNET_CHAIN_ID) ??
    parseNumberLike(process.env.NEXT_PUBLIC_MONAD_MAINNET_CHAIN_ID) ??
    143;
  const defaultTestnetChainId =
    parseNumberLike(process.env.NEXT_PUBLIC_EVM_TESTNET_CHAIN_ID) ??
    parseNumberLike(process.env.NEXT_PUBLIC_MONAD_TESTNET_CHAIN_ID) ??
    10143;
  return getNetworkState().evmTestnet ? defaultTestnetChainId : defaultMainnetChainId;
}

function isX402Required(): boolean {
  const raw = process.env.X402_REQUIRED?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return true;
}

function secureEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function getConfiguredGatewayKey(): string | undefined {
  const candidates = [process.env.X402_GATEWAY_KEY, process.env.AIP_GATEWAY_KEY];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function getPresentedGatewayKey(request: Request): string | undefined {
  const directHeader = firstHeader(request, [
    "x-x402-gateway-key",
    "x-aip-gateway-key",
    "x-gateway-key",
    "x-api-key",
  ]);
  if (directHeader) return directHeader;

  const auth = firstHeader(request, ["authorization"]);
  if (!auth) return undefined;
  if (auth.toLowerCase().startsWith("bearer ")) {
    const bearer = auth.slice(7).trim();
    return bearer || undefined;
  }
  return undefined;
}

function parsePaymentVerified(request: Request, body: JsonRecord | null, payment: JsonRecord | null): boolean {
  const headerValue = firstHeader(request, [
    "x-x402-verified",
    "x-aip-payment-verified",
    "x-payment-verified",
  ]);
  const parsedHeader = parseBooleanLike(headerValue);
  if (parsedHeader !== undefined) return parsedHeader;

  const topLevel = parseBooleanLike(body?.payment_verified);
  if (topLevel !== undefined) return topLevel;

  const nested = parseBooleanLike(payment?.verified ?? payment?.payment_verified);
  if (nested !== undefined) return nested;

  const status = parseBooleanLike(payment?.status ?? payment?.state);
  if (status !== undefined) return status;

  return false;
}

function parseObservedChain(
  request: Request,
  body: JsonRecord | null,
  payment: JsonRecord | null
): { chainId?: number; chainName?: string } {
  const chainId =
    parseNumberLike(
      firstHeader(request, [
        "x-x402-chain-id",
        "x-aip-chain-id",
        "x-payment-chain-id",
        "x-chain-id",
      ])
    ) ??
    parseNumberLike(payment?.chain_id) ??
    parseNumberLike(payment?.chainId) ??
    parseNumberLike(payment?.source_chain_id) ??
    parseNumberLike(body?.chain_id) ??
    parseNumberLike(body?.chainId);

  const chainName =
    firstHeader(request, ["x-x402-chain", "x-aip-chain", "x-payment-chain", "x-chain"]) ??
    getFirstString(payment, ["chain", "network", "chain_name", "source_chain"]) ??
    getFirstString(body, ["chain", "network"]);

  return { chainId, chainName };
}

export function verifyX402Payment(request: Request, requestBody: unknown): X402VerificationResult {
  const expectedChainId = resolveExpectedChainId();
  const required = isX402Required();
  const configuredGatewayKey = getConfiguredGatewayKey();

  if (required && !configuredGatewayKey) {
    return {
      ok: false,
      status: 500,
      code: "x402_gateway_key_missing",
      message: "X402_GATEWAY_KEY is required when X402 protection is enabled.",
      expectedChainId,
    };
  }

  if (configuredGatewayKey) {
    const presentedKey = getPresentedGatewayKey(request);
    if (!presentedKey || !secureEqual(presentedKey, configuredGatewayKey)) {
      return {
        ok: false,
        status: 401,
        code: "x402_gateway_unauthorized",
        message: "Invalid x402 gateway credentials.",
        expectedChainId,
      };
    }
  }

  if (!required) {
    return {
      ok: true,
      expectedChainId,
    };
  }

  const body = asRecord(requestBody);
  const payment = getFirstRecord(body, ["payment", "payment_proof", "x402"]);
  const paymentVerified = parsePaymentVerified(request, body, payment);

  if (!paymentVerified) {
    return {
      ok: false,
      status: 402,
      code: "x402_payment_required",
      message: "Valid x402 payment proof is required.",
      expectedChainId,
    };
  }

  const observed = parseObservedChain(request, body, payment);
  const hasObservedChain = observed.chainId !== undefined || !!observed.chainName;
  const onExpectedEvmChain =
    observed.chainId !== undefined
      ? observed.chainId === expectedChainId
      : observed.chainName
        ? matchesExpectedEvmNetwork(observed.chainName, expectedChainId)
        : false;

  if (!hasObservedChain || !onExpectedEvmChain) {
    return {
      ok: false,
      status: 402,
      code: "x402_chain_mismatch",
      message: "x402 payment must be settled on the configured EVM chain.",
      expectedChainId,
      observedChainId: observed.chainId,
      observedChain: observed.chainName,
    };
  }

  return {
    ok: true,
    expectedChainId,
    observedChainId: observed.chainId,
    observedChain: observed.chainName,
  };
}

export const verifyX402MonadPayment = verifyX402Payment;
