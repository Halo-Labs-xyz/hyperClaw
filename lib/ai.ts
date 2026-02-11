import OpenAI from "openai";
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
const DEFAULT_GEMINI_MODELS = ["gemini-3-flash-preview", "gemini-2.5-flash"];

let openAiInFlight = 0;
const openAiWaiters: Array<() => void> = [];
let openAiNextRequestNotBeforeMs = 0;
let openAiPaceQueue: Promise<void> = Promise.resolve();
let openAiRateLimitedUntilMs = 0;
let geminiRateLimitedUntilMs = 0;

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

async function runWithAiProviderGate<T>(
  fn: () => Promise<T>,
  waitForCooldown?: () => Promise<void>
): Promise<T> {
  await acquireOpenAiSlot();
  try {
    if (waitForCooldown) {
      await waitForCooldown();
    }
    await waitForOpenAiPacing();
    return await fn();
  } finally {
    releaseOpenAiSlot();
  }
}

async function runWithOpenAiGate<T>(fn: () => Promise<T>): Promise<T> {
  return runWithAiProviderGate(fn, waitForOpenAiRateLimitCooldown);
}

async function runWithGeminiGate<T>(fn: () => Promise<T>): Promise<T> {
  return runWithAiProviderGate(fn, waitForGeminiRateLimitCooldown);
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

function getConfiguredGeminiModels(): string[] {
  const raw =
    process.env.GEMINI_MODELS ||
    process.env.GEMINI_MODEL ||
    DEFAULT_GEMINI_MODELS.join(",");

  const normalized = raw
    .split(",")
    .map((x) => x.trim().replace(/\s+/g, "-"))
    .filter(Boolean);

  return normalized.length > 0 ? normalized : DEFAULT_GEMINI_MODELS;
}

function getGeminiApiKey(): string | null {
  const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
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
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

async function callGeminiModel(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error("Gemini API key missing (set GEMINI_API_KEY or GOOGLE_API_KEY)");

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
        setGeminiRateLimitCooldown(retryAfterMs ?? GEMINI_RATE_LIMIT_MIN_COOLDOWN_MS);
      }
      const msg = body?.error?.message || `Gemini HTTP ${response.status}`;
      const err = new Error(msg) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }

    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!text) throw new Error(`Gemini empty response for model ${model}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function withGeminiRetry(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
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

async function getGeminiDecisionContent(systemPrompt: string, userPrompt: string): Promise<string> {
  const models = getConfiguredGeminiModels();
  let lastError: unknown = null;

  for (const model of models) {
    try {
      const content = await withGeminiRetry(model, systemPrompt, userPrompt);
      console.log(`[AI] Using Gemini fallback model ${model}`);
      return content;
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[AI] Gemini model ${model} failed: ${msg.slice(0, 160)}`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Gemini fallback failed");
}

async function withOpenAiRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
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

  try {
    const openai = getOpenAI();
    const response = await withOpenAiRetry(
      () =>
        openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 500,
          response_format: { type: "json_object" },
        }),
      "getTradeDecision"
    );
    content = response.choices[0]?.message?.content ?? null;
    if (content) {
      console.log("[AI] Using OpenAI model gpt-4o");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[AI] OpenAI unavailable, switching to Gemini fallback: ${msg.slice(0, 160)}`);
  }

  if (!content) {
    try {
      content = await getGeminiDecisionContent(SYSTEM_PROMPT, userPrompt);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[AI] Gemini fallback unavailable: ${msg.slice(0, 160)}`);
      return {
        action: "hold",
        asset: params.allowedMarkets[0] || "BTC",
        size: 0,
        leverage: 1,
        confidence: 0,
        reasoning: "AI unavailable due to provider rate limit/quota; holding position.",
      };
    }
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

  return decision;
}
