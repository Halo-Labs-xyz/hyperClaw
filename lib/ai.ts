import OpenAI from "openai";
import axios from "axios";
import { type TradeDecision, type MarketData, type IndicatorConfig } from "./types";
import { evaluateIndicator, formatIndicatorForAI } from "./indicators";

let openaiClient: OpenAI | null = null;

const OPENAI_MAX_CONCURRENT_REQUESTS = Math.max(
  1,
  parseInt(process.env.OPENAI_MAX_CONCURRENT_REQUESTS || "1", 10)
);
const OPENAI_MIN_REQUEST_SPACING_MS = Math.max(
  0,
  parseInt(process.env.OPENAI_MIN_REQUEST_SPACING_MS || "1000", 10)
);
const OPENAI_MODELS_DEFAULT = ["gpt-4o"];
const OPENAI_MAX_RETRIES = Math.max(
  0,
  parseInt(process.env.OPENAI_MAX_RETRIES || "2", 10)
);
const OPENAI_RETRY_BASE_DELAY_MS = Math.max(
  500,
  parseInt(process.env.OPENAI_RETRY_BASE_DELAY_MS || "1500", 10)
);
const OPENAI_RATE_LIMIT_MIN_COOLDOWN_MS = Math.max(
  500,
  parseInt(process.env.OPENAI_RATE_LIMIT_MIN_COOLDOWN_MS || "15000", 10)
);
const OPENAI_QUOTA_COOLDOWN_MS = Math.max(
  60_000,
  parseInt(process.env.OPENAI_QUOTA_COOLDOWN_MS || "900000", 10)
);
const GEMINI_MAX_CONCURRENT_REQUESTS = Math.max(
  1,
  parseInt(process.env.GEMINI_MAX_CONCURRENT_REQUESTS || "1", 10)
);
const GEMINI_MIN_REQUEST_SPACING_MS = Math.max(
  0,
  parseInt(process.env.GEMINI_MIN_REQUEST_SPACING_MS || "1000", 10)
);
const GEMINI_MAX_RETRIES = Math.max(
  0,
  parseInt(process.env.GEMINI_MAX_RETRIES || "2", 10)
);
const GEMINI_RETRY_BASE_DELAY_MS = Math.max(
  500,
  parseInt(process.env.GEMINI_RETRY_BASE_DELAY_MS || "1500", 10)
);
const GEMINI_RATE_LIMIT_MIN_COOLDOWN_MS = Math.max(
  500,
  parseInt(process.env.GEMINI_RATE_LIMIT_MIN_COOLDOWN_MS || "15000", 10)
);
const GEMINI_REQUEST_TIMEOUT_MS = Math.max(
  2000,
  parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || "15000", 10)
);
const NVIDIA_MAX_CONCURRENT_REQUESTS = Math.max(
  1,
  parseInt(process.env.NVIDIA_MAX_CONCURRENT_REQUESTS || "1", 10)
);
const NVIDIA_MIN_REQUEST_SPACING_MS = Math.max(
  0,
  parseInt(process.env.NVIDIA_MIN_REQUEST_SPACING_MS || "1000", 10)
);
const NVIDIA_MAX_RETRIES = Math.max(
  0,
  parseInt(process.env.NVIDIA_MAX_RETRIES || "2", 10)
);
const NVIDIA_RETRY_BASE_DELAY_MS = Math.max(
  500,
  parseInt(process.env.NVIDIA_RETRY_BASE_DELAY_MS || "1500", 10)
);
const NVIDIA_RATE_LIMIT_MIN_COOLDOWN_MS = Math.max(
  500,
  parseInt(process.env.NVIDIA_RATE_LIMIT_MIN_COOLDOWN_MS || "15000", 10)
);
const NVIDIA_REQUEST_TIMEOUT_MS = Math.max(
  2000,
  parseInt(process.env.NVIDIA_REQUEST_TIMEOUT_MS || "15000", 10)
);
const NVIDIA_MODELS_DEFAULT = ["moonshotai/kimi-k2.5"];
const DEFAULT_GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
  "gemini-2.5-flash-lite",
  "gemma-3-27b-it",
  "gemma-3-12b-it",
  "gemma-3-4b-it",
  "gemma-3-2b-it",
  "gemma-3-1b-it",
];
const AI_NEAR_LIMIT_THRESHOLD = Math.min(
  0.99,
  Math.max(0.5, parseFloat(process.env.AI_NEAR_LIMIT_THRESHOLD || "0.85"))
);
const AI_NEAR_LIMIT_MIN_COOLDOWN_MS = Math.max(
  1000,
  parseInt(process.env.AI_NEAR_LIMIT_MIN_COOLDOWN_MS || "15000", 10)
);

let openAiInFlight = 0;
const openAiWaiters: Array<() => void> = [];
let openAiNextRequestNotBeforeMs = 0;
let openAiPaceQueue: Promise<void> = Promise.resolve();
let openAiRateLimitedUntilMs = 0;
let geminiInFlight = 0;
const geminiWaiters: Array<() => void> = [];
let geminiNextRequestNotBeforeMs = 0;
let geminiPaceQueue: Promise<void> = Promise.resolve();
let geminiRateLimitedUntilMs = 0;
let nvidiaInFlight = 0;
const nvidiaWaiters: Array<() => void> = [];
let nvidiaNextRequestNotBeforeMs = 0;
let nvidiaPaceQueue: Promise<void> = Promise.resolve();
let nvidiaRateLimitedUntilMs = 0;
const modelCooldownUntilMs = new Map<string, number>();
let balancedProviderStartOffset = 0;

type AiProvider = "openai" | "gemini" | "nvidia";

interface ModelRoute {
  provider: AiProvider;
  model: string;
}

interface ProviderCallResult {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
}

interface ModelQuota {
  rpm?: number;
  tpm?: number;
  rpd?: number;
}

interface ModelUsageWindow {
  minuteWindowStartMs: number;
  minuteRequests: number;
  minuteTokens: number;
  dayWindowStartMs: number;
  dayRequests: number;
  dayTokens: number;
}

const modelUsageByKey = new Map<string, ModelUsageWindow>();

const KNOWN_MODEL_QUOTAS: Record<string, ModelQuota> = {
  "gemini-2.5-flash": { rpm: 5, tpm: 250_000, rpd: 20 },
  "gemini-2.5-flash-lite": { rpm: 10, tpm: 250_000, rpd: 20 },
  "gemini-3-flash": { rpm: 5, tpm: 250_000, rpd: 20 },
  "gemini-3-flash-preview": { rpm: 5, tpm: 250_000, rpd: 20 },
  "gemma-3-1b": { rpm: 30, tpm: 15_000, rpd: 14_400 },
  "gemma-3-2b": { rpm: 30, tpm: 15_000, rpd: 14_400 },
  "gemma-3-4b": { rpm: 30, tpm: 15_000, rpd: 14_400 },
  "gemma-3-12b": { rpm: 30, tpm: 15_000, rpd: 14_400 },
  "gemma-3-27b": { rpm: 30, tpm: 15_000, rpd: 14_400 },
  "gemma-3-1b-it": { rpm: 30, tpm: 15_000, rpd: 14_400 },
  "gemma-3-2b-it": { rpm: 30, tpm: 15_000, rpd: 14_400 },
  "gemma-3-4b-it": { rpm: 30, tpm: 15_000, rpd: 14_400 },
  "gemma-3-12b-it": { rpm: 30, tpm: 15_000, rpd: 14_400 },
  "gemma-3-27b-it": { rpm: 30, tpm: 15_000, rpd: 14_400 },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireOpenAiSlot(): Promise<void> {
  if (openAiInFlight < OPENAI_MAX_CONCURRENT_REQUESTS) {
    openAiInFlight++;
    return;
  }
  await new Promise<void>((resolve) => {
    openAiWaiters.push(() => {
      openAiInFlight++;
      resolve();
    });
  });
}

function releaseOpenAiSlot(): void {
  openAiInFlight = Math.max(0, openAiInFlight - 1);
  const next = openAiWaiters.shift();
  if (next) next();
}

async function acquireGeminiSlot(): Promise<void> {
  if (geminiInFlight < GEMINI_MAX_CONCURRENT_REQUESTS) {
    geminiInFlight++;
    return;
  }
  await new Promise<void>((resolve) => {
    geminiWaiters.push(() => {
      geminiInFlight++;
      resolve();
    });
  });
}

function releaseGeminiSlot(): void {
  geminiInFlight = Math.max(0, geminiInFlight - 1);
  const next = geminiWaiters.shift();
  if (next) next();
}

async function acquireNvidiaSlot(): Promise<void> {
  if (nvidiaInFlight < NVIDIA_MAX_CONCURRENT_REQUESTS) {
    nvidiaInFlight++;
    return;
  }
  await new Promise<void>((resolve) => {
    nvidiaWaiters.push(() => {
      nvidiaInFlight++;
      resolve();
    });
  });
}

function releaseNvidiaSlot(): void {
  nvidiaInFlight = Math.max(0, nvidiaInFlight - 1);
  const next = nvidiaWaiters.shift();
  if (next) next();
}

async function waitForOpenAiPacing(): Promise<void> {
  let releaseCurrent!: () => void;
  const previous = openAiPaceQueue;
  openAiPaceQueue = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });

  await previous;
  try {
    const now = Date.now();
    if (now < openAiNextRequestNotBeforeMs) {
      await sleep(openAiNextRequestNotBeforeMs - now);
    }
    openAiNextRequestNotBeforeMs = Date.now() + OPENAI_MIN_REQUEST_SPACING_MS;
  } finally {
    releaseCurrent();
  }
}

async function waitForGeminiPacing(): Promise<void> {
  let releaseCurrent!: () => void;
  const previous = geminiPaceQueue;
  geminiPaceQueue = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });

  await previous;
  try {
    const now = Date.now();
    if (now < geminiNextRequestNotBeforeMs) {
      await sleep(geminiNextRequestNotBeforeMs - now);
    }
    geminiNextRequestNotBeforeMs = Date.now() + GEMINI_MIN_REQUEST_SPACING_MS;
  } finally {
    releaseCurrent();
  }
}

async function waitForNvidiaPacing(): Promise<void> {
  let releaseCurrent!: () => void;
  const previous = nvidiaPaceQueue;
  nvidiaPaceQueue = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });

  await previous;
  try {
    const now = Date.now();
    if (now < nvidiaNextRequestNotBeforeMs) {
      await sleep(nvidiaNextRequestNotBeforeMs - now);
    }
    nvidiaNextRequestNotBeforeMs = Date.now() + NVIDIA_MIN_REQUEST_SPACING_MS;
  } finally {
    releaseCurrent();
  }
}

async function waitForOpenAiRateLimitCooldown(): Promise<void> {
  const now = Date.now();
  if (openAiRateLimitedUntilMs > now) {
    await sleep(openAiRateLimitedUntilMs - now);
  }
}

function setOpenAiRateLimitCooldown(ms: number): void {
  const cooldownMs = Math.max(OPENAI_RATE_LIMIT_MIN_COOLDOWN_MS, ms);
  const nextUntil = Date.now() + cooldownMs;
  if (nextUntil > openAiRateLimitedUntilMs) {
    openAiRateLimitedUntilMs = nextUntil;
    console.warn(`[AI] Rate limited, pausing OpenAI requests for ${cooldownMs}ms`);
  }
}

async function waitForGeminiRateLimitCooldown(): Promise<void> {
  const now = Date.now();
  if (geminiRateLimitedUntilMs > now) {
    await sleep(geminiRateLimitedUntilMs - now);
  }
}

function setGeminiRateLimitCooldown(ms: number): void {
  const cooldownMs = Math.max(GEMINI_RATE_LIMIT_MIN_COOLDOWN_MS, ms);
  const nextUntil = Date.now() + cooldownMs;
  if (nextUntil > geminiRateLimitedUntilMs) {
    geminiRateLimitedUntilMs = nextUntil;
    console.warn(`[AI] Gemini rate limited, pausing Gemini requests for ${cooldownMs}ms`);
  }
}

async function waitForNvidiaRateLimitCooldown(): Promise<void> {
  const now = Date.now();
  if (nvidiaRateLimitedUntilMs > now) {
    await sleep(nvidiaRateLimitedUntilMs - now);
  }
}

function setNvidiaRateLimitCooldown(ms: number): void {
  const cooldownMs = Math.max(NVIDIA_RATE_LIMIT_MIN_COOLDOWN_MS, ms);
  const nextUntil = Date.now() + cooldownMs;
  if (nextUntil > nvidiaRateLimitedUntilMs) {
    nvidiaRateLimitedUntilMs = nextUntil;
    console.warn(`[AI] NVIDIA rate limited, pausing NVIDIA requests for ${cooldownMs}ms`);
  }
}

function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/\s+/g, "-");
}

function modelKey(provider: AiProvider, model: string): string {
  return `${provider}:${normalizeModelId(model)}`;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function getUtcDayStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function getOrCreateModelUsage(key: string, nowMs: number): ModelUsageWindow {
  const dayStart = getUtcDayStartMs(nowMs);
  const minuteStart = nowMs - (nowMs % 60_000);
  const existing = modelUsageByKey.get(key);

  if (!existing) {
    const created: ModelUsageWindow = {
      minuteWindowStartMs: minuteStart,
      minuteRequests: 0,
      minuteTokens: 0,
      dayWindowStartMs: dayStart,
      dayRequests: 0,
      dayTokens: 0,
    };
    modelUsageByKey.set(key, created);
    return created;
  }

  if (existing.minuteWindowStartMs !== minuteStart) {
    existing.minuteWindowStartMs = minuteStart;
    existing.minuteRequests = 0;
    existing.minuteTokens = 0;
  }

  if (existing.dayWindowStartMs !== dayStart) {
    existing.dayWindowStartMs = dayStart;
    existing.dayRequests = 0;
    existing.dayTokens = 0;
  }

  return existing;
}

function getModelQuota(provider: AiProvider, model: string): ModelQuota | null {
  const normalized = normalizeModelId(model);
  const fromKnown =
    KNOWN_MODEL_QUOTAS[normalized] ||
    KNOWN_MODEL_QUOTAS[normalized.replace(/-latest$/, "")] ||
    null;
  if (fromKnown) return fromKnown;

  const prefix =
    provider === "openai" ? "OPENAI" : provider === "gemini" ? "GEMINI" : "NVIDIA";
  const rpm = parseInt(process.env[`${prefix}_QUOTA_RPM`] || "", 10);
  const tpm = parseInt(process.env[`${prefix}_QUOTA_TPM`] || "", 10);
  const rpd = parseInt(process.env[`${prefix}_QUOTA_RPD`] || "", 10);

  const quota: ModelQuota = {};
  if (Number.isFinite(rpm) && rpm > 0) quota.rpm = rpm;
  if (Number.isFinite(tpm) && tpm > 0) quota.tpm = tpm;
  if (Number.isFinite(rpd) && rpd > 0) quota.rpd = rpd;
  return quota.rpm || quota.tpm || quota.rpd ? quota : null;
}

function setModelCooldown(provider: AiProvider, model: string, ms: number, reason: string): void {
  const key = modelKey(provider, model);
  const cooldownMs = Math.max(AI_NEAR_LIMIT_MIN_COOLDOWN_MS, ms);
  const nextUntil = Date.now() + cooldownMs;
  const current = modelCooldownUntilMs.get(key) || 0;
  if (nextUntil > current) {
    modelCooldownUntilMs.set(key, nextUntil);
    console.warn(`[AI] ${provider}:${model} cooling down for ${cooldownMs}ms (${reason})`);
  }
}

function getModelCooldownRemainingMs(provider: AiProvider, model: string): number {
  const until = modelCooldownUntilMs.get(modelKey(provider, model)) || 0;
  return Math.max(0, until - Date.now());
}

function enforceNearLimitBudget(
  provider: AiProvider,
  model: string,
  estimatedInputTokens: number
): void {
  const now = Date.now();
  const remainingCooldownMs = getModelCooldownRemainingMs(provider, model);
  if (remainingCooldownMs > 0) {
    throw new Error(
      `${provider}:${model} cooling down (${Math.ceil(remainingCooldownMs / 1000)}s remaining)`
    );
  }

  const quota = getModelQuota(provider, model);
  if (!quota) return;

  const usage = getOrCreateModelUsage(modelKey(provider, model), now);
  const minuteWindowEndMs = usage.minuteWindowStartMs + 60_000;
  const dayWindowEndMs = usage.dayWindowStartMs + 86_400_000;
  const rpmThreshold = quota.rpm ? Math.max(1, Math.floor(quota.rpm * AI_NEAR_LIMIT_THRESHOLD)) : null;
  const tpmThreshold = quota.tpm ? Math.max(1, Math.floor(quota.tpm * AI_NEAR_LIMIT_THRESHOLD)) : null;
  const rpdThreshold = quota.rpd ? Math.max(1, Math.floor(quota.rpd * AI_NEAR_LIMIT_THRESHOLD)) : null;

  if (rpmThreshold !== null && usage.minuteRequests + 1 >= rpmThreshold) {
    setModelCooldown(provider, model, minuteWindowEndMs - now, "near RPM limit");
    throw new Error(`${provider}:${model} near RPM limit`);
  }

  if (tpmThreshold !== null && usage.minuteTokens + Math.max(0, estimatedInputTokens) >= tpmThreshold) {
    setModelCooldown(provider, model, minuteWindowEndMs - now, "near TPM limit");
    throw new Error(`${provider}:${model} near TPM limit`);
  }

  if (rpdThreshold !== null && usage.dayRequests + 1 >= rpdThreshold) {
    setModelCooldown(provider, model, dayWindowEndMs - now, "near RPD limit");
    throw new Error(`${provider}:${model} near RPD limit`);
  }
}

function reserveModelUsage(provider: AiProvider, model: string, estimatedInputTokens: number): void {
  const usage = getOrCreateModelUsage(modelKey(provider, model), Date.now());
  usage.minuteRequests += 1;
  usage.dayRequests += 1;
  usage.minuteTokens += Math.max(0, estimatedInputTokens);
  usage.dayTokens += Math.max(0, estimatedInputTokens);
}

function adjustPromptTokenEstimate(
  provider: AiProvider,
  model: string,
  estimatedInputTokens: number,
  actualPromptTokens?: number
): void {
  if (!Number.isFinite(actualPromptTokens)) return;
  const usage = getOrCreateModelUsage(modelKey(provider, model), Date.now());
  const delta = Math.max(0, Math.round(actualPromptTokens || 0)) - Math.max(0, estimatedInputTokens);
  if (delta !== 0) {
    usage.minuteTokens += delta;
    usage.dayTokens += delta;
  }
}

function recordCompletionTokens(provider: AiProvider, model: string, completionTokens: number): void {
  const usage = getOrCreateModelUsage(modelKey(provider, model), Date.now());
  usage.minuteTokens += Math.max(0, Math.round(completionTokens));
  usage.dayTokens += Math.max(0, Math.round(completionTokens));
}

async function runWithOpenAiGate<T>(fn: () => Promise<T>): Promise<T> {
  await acquireOpenAiSlot();
  try {
    await waitForOpenAiRateLimitCooldown();
    await waitForOpenAiPacing();
    return await fn();
  } finally {
    releaseOpenAiSlot();
  }
}

async function runWithGeminiGate<T>(fn: () => Promise<T>): Promise<T> {
  await acquireGeminiSlot();
  try {
    await waitForGeminiRateLimitCooldown();
    await waitForGeminiPacing();
    return await fn();
  } finally {
    releaseGeminiSlot();
  }
}

async function runWithNvidiaGate<T>(fn: () => Promise<T>): Promise<T> {
  await acquireNvidiaSlot();
  try {
    await waitForNvidiaRateLimitCooldown();
    await waitForNvidiaPacing();
    return await fn();
  } finally {
    releaseNvidiaSlot();
  }
}

function getOpenAiStatus(error: unknown): number | null {
  const err = error as
    | { status?: number; response?: { status?: number } }
    | undefined;
  const status = err?.status ?? err?.response?.status;
  return typeof status === "number" ? status : null;
}

function isOpenAiRetryable(error: unknown): boolean {
  const status = getOpenAiStatus(error);
  if (status === 429 || status === 408 || status === 409) return true;
  if (status !== null && status >= 500) return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return msg.includes("timeout") || msg.includes("network") || msg.includes("rate limit") || msg.includes("429");
}

function isOpenAiQuotaExhausted(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "insufficient_quota") return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return msg.includes("insufficient_quota") || msg.includes("exceeded your current quota");
}

function getOpenAiRetryAfterMs(error: unknown): number | null {
  const headers = (error as { headers?: Headers | Record<string, string> } | undefined)?.headers;
  if (!headers) return null;

  const retryAfter =
    headers instanceof Headers
      ? headers.get("retry-after")
      : headers["retry-after"] ?? headers["Retry-After"];
  if (!retryAfter) return null;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function getConfiguredOpenAiModels(): string[] {
  const raw =
    process.env.AI_OPENAI_MODELS ||
    process.env.OPENAI_MODELS ||
    process.env.OPENAI_MODEL ||
    OPENAI_MODELS_DEFAULT.join(",");

  const normalized = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  return normalized.length > 0 ? normalized : OPENAI_MODELS_DEFAULT;
}

function getConfiguredGeminiModels(): string[] {
  const raw =
    process.env.GEMINI_MODELS ||
    process.env.GEMINI_MODEL ||
    DEFAULT_GEMINI_MODELS.join(",");

  const configured = raw
    .split(",")
    .map((x) => x.trim().replace(/\s+/g, "-"))
    .filter(Boolean);

  return Array.from(new Set([...configured, ...DEFAULT_GEMINI_MODELS]));
}

function getConfiguredNvidiaModels(): string[] {
  const raw =
    process.env.NVIDIA_MODELS ||
    process.env.NVIDIA_MODEL ||
    NVIDIA_MODELS_DEFAULT.join(",");

  const configured = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  return Array.from(new Set([...configured, ...NVIDIA_MODELS_DEFAULT]));
}

function inferProviderFromModel(model: string): AiProvider {
  const normalized = normalizeModelId(model);
  if (normalized.startsWith("gemini") || normalized.startsWith("gemma")) {
    return "gemini";
  }
  if (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3")
  ) {
    return "openai";
  }
  return "nvidia";
}

function buildBalancedPrimaryRoutes(geminiModels: string[], nvidiaModels: string[]): ModelRoute[] {
  const primary: ModelRoute[] = [];
  const geminiQueue = [...geminiModels];
  const nvidiaQueue = [...nvidiaModels];
  const startWithGemini = balancedProviderStartOffset % 2 === 0;
  balancedProviderStartOffset += 1;

  let takeGemini = startWithGemini;
  while (geminiQueue.length > 0 || nvidiaQueue.length > 0) {
    if (takeGemini && geminiQueue.length > 0) {
      primary.push({ provider: "gemini", model: geminiQueue.shift()! });
    } else if (!takeGemini && nvidiaQueue.length > 0) {
      primary.push({ provider: "nvidia", model: nvidiaQueue.shift()! });
    } else if (geminiQueue.length > 0) {
      primary.push({ provider: "gemini", model: geminiQueue.shift()! });
    } else if (nvidiaQueue.length > 0) {
      primary.push({ provider: "nvidia", model: nvidiaQueue.shift()! });
    }
    takeGemini = !takeGemini;
  }

  return primary;
}

function getConfiguredModelChain(): ModelRoute[] {
  const explicit = (process.env.AI_MODEL_CHAIN || "").trim();
  const chainItems = explicit
    ? explicit.split(",").map((x) => x.trim()).filter(Boolean)
    : [
        ...buildBalancedPrimaryRoutes(getConfiguredGeminiModels(), getConfiguredNvidiaModels()).map(
          (route) => `${route.provider}:${route.model}`
        ),
        ...getConfiguredOpenAiModels().map((model) => `openai:${model}`),
      ];

  const routes: ModelRoute[] = [];
  const seen = new Set<string>();

  for (const item of chainItems) {
    const sep = item.indexOf(":");
    const hasPrefix = sep > 0;
    const providerRaw = hasPrefix ? item.slice(0, sep).toLowerCase() : "";
    const modelRaw = hasPrefix ? item.slice(sep + 1).trim() : item.trim();
    if (!modelRaw) continue;

    const provider =
      providerRaw === "openai" || providerRaw === "gemini" || providerRaw === "nvidia"
        ? (providerRaw as AiProvider)
        : inferProviderFromModel(modelRaw);
    const normalizedModel = provider === "gemini" ? modelRaw.replace(/\s+/g, "-") : modelRaw;
    const key = `${provider}:${normalizeModelId(normalizedModel)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ provider, model: normalizedModel });
  }

  return routes;
}

function getGeminiApiKey(): string | null {
  const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  return key || null;
}

function getNvidiaApiKey(): string | null {
  const key = (process.env.NVIDIA_API_KEY || "").trim();
  return key || null;
}

function getErrorStatus(error: unknown): number | null {
  const err = error as
    | { status?: number; response?: { status?: number } }
    | undefined;
  const status = err?.status ?? err?.response?.status;
  return typeof status === "number" ? status : null;
}

function isGeminiRetryable(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 429 || status === 408 || status === 409) return true;
  if (status !== null && status >= 500) return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return msg.includes("timeout") || msg.includes("network") || msg.includes("rate limit") || msg.includes("429");
}

function getRetryAfterFromHeaders(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return null;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  if (trimmed.startsWith("```")) {
    const withoutFenceStart = trimmed.replace(/^```(?:json)?\s*/i, "");
    const withoutFenceEnd = withoutFenceStart.replace(/\s*```$/, "");
    return withoutFenceEnd.trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

async function callGeminiModel(
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<ProviderCallResult> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error("Gemini API key missing (set GEMINI_API_KEY or GOOGLE_API_KEY)");
  const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
  enforceNearLimitBudget("gemini", model, estimatedInputTokens);
  reserveModelUsage("gemini", model, estimatedInputTokens);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);

  try {
    const response = await runWithGeminiGate(() =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 500,
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      })
    );

    const body = (await response.json().catch(() => ({}))) as GeminiGenerateContentResponse;
    if (!response.ok) {
      const retryAfterMs = getRetryAfterFromHeaders(response.headers);
      if (response.status === 429) {
        const cooldownMs = retryAfterMs ?? GEMINI_RATE_LIMIT_MIN_COOLDOWN_MS;
        setGeminiRateLimitCooldown(cooldownMs);
        setModelCooldown("gemini", model, cooldownMs, "429");
      }
      const msg = body?.error?.message || `Gemini HTTP ${response.status}`;
      const err = new Error(msg) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }

    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!text) throw new Error(`Gemini empty response for model ${model}`);
    const promptTokens = body.usageMetadata?.promptTokenCount;
    const completionTokens =
      body.usageMetadata?.candidatesTokenCount ??
      Math.max(
        1,
        (body.usageMetadata?.totalTokenCount || 0) - (body.usageMetadata?.promptTokenCount || 0)
      );
    adjustPromptTokenEstimate("gemini", model, estimatedInputTokens, promptTokens);
    if (Number.isFinite(completionTokens)) {
      recordCompletionTokens("gemini", model, completionTokens || 0);
    } else {
      recordCompletionTokens("gemini", model, estimateTokens(text));
    }
    return {
      content: text,
      promptTokens,
      completionTokens,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function withGeminiRetry(
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<ProviderCallResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    try {
      return await callGeminiModel(model, systemPrompt, userPrompt);
    } catch (error: unknown) {
      lastError = error;
      const status = getErrorStatus(error);
      const rateLimited = status === 429;
      const retryable = isGeminiRetryable(error);

      if (rateLimited) {
        setGeminiRateLimitCooldown(GEMINI_RATE_LIMIT_MIN_COOLDOWN_MS);
        setModelCooldown("gemini", model, GEMINI_RATE_LIMIT_MIN_COOLDOWN_MS, "429");
      }

      if (!retryable || attempt === GEMINI_MAX_RETRIES) {
        throw error;
      }

      const delay = Math.min(
        GEMINI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 300,
        30_000
      );
      if (attempt === 0) {
        console.warn(`[AI] Gemini ${model} failed, retrying...`);
      }
      await sleep(delay);
    }
  }

  throw lastError;
}

interface NvidiaChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

async function callNvidiaModel(
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<ProviderCallResult> {
  const apiKey = getNvidiaApiKey();
  if (!apiKey) throw new Error("NVIDIA API key missing (set NVIDIA_API_KEY)");
  const endpoint = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1/chat/completions";
  const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
  enforceNearLimitBudget("nvidia", model, estimatedInputTokens);
  reserveModelUsage("nvidia", model, estimatedInputTokens);

  const result = await runWithNvidiaGate(async () => {
    const response = await axios.post<NvidiaChatResponse>(
      endpoint,
      {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 500,
        temperature: 0.3,
        top_p: 1,
        stream: false,
        chat_template_kwargs: { thinking: true },
      },
      {
        timeout: NVIDIA_REQUEST_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  });

  const content = (result.choices?.[0]?.message?.content || "").trim();
  if (!content) throw new Error(`NVIDIA empty response for model ${model}`);
  const promptTokens = result.usage?.prompt_tokens;
  const completionTokens = result.usage?.completion_tokens;
  adjustPromptTokenEstimate("nvidia", model, estimatedInputTokens, promptTokens);
  if (Number.isFinite(completionTokens)) {
    recordCompletionTokens("nvidia", model, completionTokens || 0);
  } else {
    recordCompletionTokens("nvidia", model, estimateTokens(content));
  }

  return {
    content,
    promptTokens,
    completionTokens,
  };
}

async function withNvidiaRetry(
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<ProviderCallResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= NVIDIA_MAX_RETRIES; attempt++) {
    try {
      return await callNvidiaModel(model, systemPrompt, userPrompt);
    } catch (error: unknown) {
      lastError = error;
      const status = getErrorStatus(error);
      const retryable = isGeminiRetryable(error);
      const rateLimited = status === 429;

      if (rateLimited) {
        setNvidiaRateLimitCooldown(NVIDIA_RATE_LIMIT_MIN_COOLDOWN_MS);
        setModelCooldown("nvidia", model, NVIDIA_RATE_LIMIT_MIN_COOLDOWN_MS, "429");
      }

      if (!retryable || attempt === NVIDIA_MAX_RETRIES) {
        throw error;
      }

      const delay = Math.min(
        NVIDIA_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 300,
        30_000
      );
      if (attempt === 0) {
        console.warn(`[AI] NVIDIA ${model} failed, retrying...`);
      }
      await sleep(delay);
    }
  }

  throw lastError;
}

async function withOpenAiRetry<T>(fn: () => Promise<T>, label: string, model: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt++) {
    try {
      return await runWithOpenAiGate(fn);
    } catch (error: unknown) {
      lastError = error;
      const status = getOpenAiStatus(error);
      const rateLimited = status === 429;
      const quotaExhausted = isOpenAiQuotaExhausted(error);
      const retryable = isOpenAiRetryable(error);

      if (quotaExhausted) {
        setOpenAiRateLimitCooldown(OPENAI_QUOTA_COOLDOWN_MS);
        setModelCooldown("openai", model, OPENAI_QUOTA_COOLDOWN_MS, "quota exhausted");
        throw error;
      }

      if (rateLimited) {
        const retryAfterMs = getOpenAiRetryAfterMs(error);
        const cooldownMs =
          retryAfterMs ??
          Math.min(
            OPENAI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
            30_000
          );
        setOpenAiRateLimitCooldown(cooldownMs);
        setModelCooldown("openai", model, cooldownMs, "429");
      }

      if (!retryable || attempt === OPENAI_MAX_RETRIES) {
        throw error;
      }

      const attemptDelay = Math.min(
        OPENAI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 300,
        30_000
      );
      if (attempt === 0) {
        console.warn(`[AI] ${label} failed, retrying...`);
      }
      await sleep(attemptDelay);
    }
  }

  throw lastError;
}

async function callOpenAiModel(
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<ProviderCallResult> {
  const openai = getOpenAI();
  const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
  enforceNearLimitBudget("openai", model, estimatedInputTokens);
  reserveModelUsage("openai", model, estimatedInputTokens);
  const response = await withOpenAiRetry(
    () =>
      openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: "json_object" },
      }),
    `OpenAI ${model}`,
    model
  );

  const content = response.choices[0]?.message?.content ?? "";
  const promptTokens = response.usage?.prompt_tokens;
  const completionTokens = response.usage?.completion_tokens;
  adjustPromptTokenEstimate("openai", model, estimatedInputTokens, promptTokens);
  if (Number.isFinite(completionTokens)) {
    recordCompletionTokens("openai", model, completionTokens || 0);
  } else if (content) {
    recordCompletionTokens("openai", model, estimateTokens(content));
  }

  return {
    content,
    promptTokens,
    completionTokens,
  };
}

async function callModelRoute(
  route: ModelRoute,
  systemPrompt: string,
  userPrompt: string
): Promise<ProviderCallResult> {
  if (route.provider === "openai") {
    return callOpenAiModel(route.model, systemPrompt, userPrompt);
  }
  if (route.provider === "gemini") {
    return withGeminiRetry(route.model, systemPrompt, userPrompt);
  }
  return withNvidiaRetry(route.model, systemPrompt, userPrompt);
}

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

// ============================================
// System Prompt
// ============================================

const SYSTEM_PROMPT = `You are an elite quantitative trading AI agent operating on Hyperliquid perpetual futures.

ROLE: Analyze market data and produce a single trading decision in strict JSON format.

RISK MANAGEMENT RULES:
- Never exceed the max leverage provided
- Always set stop losses based on the risk level
- Conservative: 2-5% stop loss, low leverage (1-3x), high-confidence entries only
- Moderate: 3-8% stop loss, medium leverage (3-10x), balanced approach
- Aggressive: 5-15% stop loss, higher leverage (5-20x), momentum-driven

IMPORTANT: In testnet/low-volatility conditions where 24h_change is 0% or very small, still look for opportunities:
- Use funding rate direction as a signal (positive funding = consider shorts, negative = consider longs)
- Open interest changes can indicate accumulation
- Even with stable prices, you can take positions when other signals align

ANALYSIS FRAMEWORK:
1. Price trend (current price vs recent levels)
2. Funding rate (positive = longs paying shorts, negative = shorts paying longs)
3. Open interest changes
4. Volume analysis
5. Cross-asset correlation

INDICATOR-BASED TRADING:
When a key indicator is provided, it becomes a primary signal source:
- STRICT MODE + STRONG SIGNAL (>60% confidence): Follow the indicator signal unless there is overwhelming evidence against it
- STRICT MODE + WEAK/NEUTRAL SIGNAL (<60% confidence): You MAY look at other signals (funding, OI, strategy) to make a decision
- ADVISORY MODE: Use the indicator as one of many inputs, weighing it by its configured weight
- You may REASON AGAINST the indicator if market conditions clearly contradict it
- NEUTRAL indicator signals are NOT actionable on their own - look for other opportunities
- Always explain your reasoning when agreeing or disagreeing with indicator signals

STRATEGY EXECUTION:
When a custom strategy is provided, it is your PRIMARY trading directive:
- Parse the strategy for timeframes, entry/exit rules, and market patterns
- Adapt your risk management and position sizing to match the strategy
- If the strategy mentions specific behaviors (e.g., "secure profit in 1 hour", "break every hour"), incorporate this into your reasoning
- The strategy overrides general guidance - follow it as the agent's personality

OUTPUT FORMAT (strict JSON, no markdown):
{
  "action": "long" | "short" | "close" | "hold",
  "asset": "<coin symbol>",
  "size": <0.0 to 1.0, fraction of available capital>,
  "leverage": <integer>,
  "confidence": <0.0 to 1.0>,
  "reasoning": "<1-2 sentence explanation including indicator analysis if applicable>",
  "stopLoss": <price or null>,
  "takeProfit": <price or null>
}

If no high-confidence opportunity exists, output action "hold" with reasoning.`;

// ============================================
// Trading Decision
// ============================================

export async function getTradeDecision(params: {
  markets: MarketData[];
  currentPositions: Array<{
    coin: string;
    size: number;
    entryPrice: number;
    unrealizedPnl: number;
    leverage: number;
  }>;
  availableBalance: number;
  riskLevel: "conservative" | "moderate" | "aggressive";
  maxLeverage: number;
  allowedMarkets: string[];
  aggressiveness?: number; // 0-100, higher = more willing to take trades
  indicator?: IndicatorConfig; // Key indicator for decision making
  historicalPrices?: Record<string, number[]>; // coin -> price history
  // Agent identity and strategy
  agentName?: string;
  agentStrategy?: string; // The agent's custom strategy description
}): Promise<TradeDecision> {
  // Evaluate indicator if configured
  let indicatorSection = "";
  if (params.indicator?.enabled) {
    const primaryMarket = params.allowedMarkets[0];
    const marketData = params.markets.find(m => m.coin === primaryMarket);
    
    if (marketData) {
      const historicalData = params.historicalPrices?.[primaryMarket] 
        ? { prices: params.historicalPrices[primaryMarket] }
        : undefined;
      
      const evaluation = evaluateIndicator(params.indicator, marketData, historicalData);
      indicatorSection = `

${formatIndicatorForAI(params.indicator, evaluation)}

IMPORTANT: The above indicator is configured as a KEY signal source. ${
  params.indicator.strictMode 
    ? "You MUST follow this signal unless you have extremely strong counter-evidence. Explain your reasoning if you disagree."
    : `Weight this signal at ${params.indicator.weight}% in your decision. You may reason against it if other factors strongly contradict.`
}
`;
    }
  }

  // Build strategy section if agent has custom strategy
  let strategySection = "";
  if (params.agentStrategy && params.agentStrategy.trim()) {
    strategySection = `
=== YOUR TRADING STRATEGY ===
${params.agentName ? `Agent: ${params.agentName}` : ""}
Strategy: ${params.agentStrategy}

IMPORTANT: You MUST follow this strategy as your primary trading approach. This defines how you should trade.
Parse the strategy for:
- Timeframes mentioned (e.g., "3 minute chart", "1 hour")
- Entry/exit rules
- Risk parameters
- Market behavior patterns to watch for
`;
  }

  const userPrompt = `CURRENT MARKET DATA:
${params.markets
  .filter((m) => params.allowedMarkets.includes(m.coin))
  .map(
    (m) =>
      `${m.coin}: price=$${m.price}, 24h_change=${m.change24h}%, funding=${m.fundingRate}%, OI=$${m.openInterest}`
  )
  .join("\n")}

CURRENT POSITIONS:
${
  params.currentPositions.length === 0
    ? "None"
    : params.currentPositions
        .map(
          (p) =>
            `${p.coin}: size=${p.size}, entry=$${p.entryPrice}, uPnL=$${p.unrealizedPnl}, leverage=${p.leverage}x`
        )
        .join("\n")
}

ACCOUNT:
- Available balance: $${params.availableBalance.toFixed(2)}
- Risk level: ${params.riskLevel}
- Max leverage: ${params.maxLeverage}x (IMPORTANT: leverage must be an integer between 1 and ${params.maxLeverage})
- Allowed markets: ${params.allowedMarkets.join(", ")}
- Aggressiveness: ${params.aggressiveness ?? 50}% (higher = more willing to take trades even with weaker signals)
${strategySection}
${(params.aggressiveness ?? 50) >= 80 ? 'NOTE: High aggressiveness - be willing to take trades with moderate signals. Do not require strong momentum.' : ''}
${indicatorSection}
Provide your trading decision as JSON:`;

  let content: string | null = null;
  const modelChain = getConfiguredModelChain();
  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasGeminiKey = Boolean(getGeminiApiKey());
  const hasNvidiaKey = Boolean(getNvidiaApiKey());
  let lastError: unknown = null;

  for (const route of modelChain) {
    if (route.provider === "openai" && !hasOpenAiKey) continue;
    if (route.provider === "gemini" && !hasGeminiKey) continue;
    if (route.provider === "nvidia" && !hasNvidiaKey) continue;

    try {
      const result = await callModelRoute(route, SYSTEM_PROMPT, userPrompt);
      const candidate = (result.content || "").trim();
      if (!candidate) throw new Error(`${route.provider}:${route.model} returned empty content`);
      content = candidate;
      console.log(`[AI] Decision model: ${route.provider}:${route.model}`);
      break;
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[AI] ${route.provider}:${route.model} failed: ${msg.slice(0, 160)}`);
    }
  }

  if (!content) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
    console.error(`[AI] Model chain exhausted: ${msg.slice(0, 160)}`);
    return {
      action: "hold",
      asset: params.allowedMarkets[0] || "BTC",
      size: 0,
      leverage: 1,
      confidence: 0,
      reasoning: "AI unavailable due to provider rate limit/quota; holding position.",
    };
  }

  if (!content) throw new Error("No response from AI");

  let decision: TradeDecision;
  try {
    decision = JSON.parse(extractJsonPayload(content)) as TradeDecision;
  } catch {
    console.error("[AI] Failed to parse response:", content);
    // Return safe hold decision on parse failure
    return {
      action: "hold",
      asset: params.allowedMarkets[0] || "BTC",
      size: 0,
      leverage: 1,
      confidence: 0,
      reasoning: "AI response parsing failed; holding position.",
    };
  }

  // Validate required fields
  if (!decision.action || !decision.asset) {
    return {
      action: "hold",
      asset: params.allowedMarkets[0] || "BTC",
      size: 0,
      leverage: 1,
      confidence: 0,
      reasoning: "AI returned incomplete decision; holding position.",
    };
  }

  // Safety clamps
  decision.leverage = Math.min(
    Math.max(1, Math.round(decision.leverage || 1)),
    params.maxLeverage
  );
  decision.size = Math.max(0, Math.min(1, decision.size || 0));
  decision.confidence = Math.max(0, Math.min(1, decision.confidence || 0));
  decision.asset = String(decision.asset || "").trim().toUpperCase();

  const allowedMarketsUpper = new Set(params.allowedMarkets.map((m) => m.toUpperCase()));
  const openPositionMarketsUpper = new Set(
    params.currentPositions
      .filter((p) => Math.abs(p.size) > 0)
      .map((p) => p.coin.toUpperCase())
  );

  if (decision.action !== "hold" && !allowedMarketsUpper.has(decision.asset)) {
    return {
      action: "hold",
      asset: params.allowedMarkets[0] || "BTC",
      size: 0,
      leverage: 1,
      confidence: 0,
      reasoning: `AI selected disallowed market (${decision.asset}); holding position.`,
    };
  }

  if (decision.action === "close" && openPositionMarketsUpper.size > 0 && !openPositionMarketsUpper.has(decision.asset)) {
    const firstOpenPosition = params.currentPositions.find((p) => Math.abs(p.size) > 0);
    if (firstOpenPosition) {
      decision.asset = firstOpenPosition.coin.toUpperCase();
    }
  }

  if (typeof decision.stopLoss === "number" && !Number.isFinite(decision.stopLoss)) {
    decision.stopLoss = undefined;
  }
  if (typeof decision.takeProfit === "number" && !Number.isFinite(decision.takeProfit)) {
    decision.takeProfit = undefined;
  }

  return decision;
}
