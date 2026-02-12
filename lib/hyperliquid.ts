import { randomBytes } from "crypto";
import {
  HttpTransport,
  InfoClient,
  ExchangeClient,
  WebSocketTransport,
  SubscriptionClient,
} from "@nktkas/hyperliquid";
import { type Address } from "viem";
import {
  type MarketData,
  type PlaceOrderParams,
  type OrderConfig,
  type TimeInForce,
} from "./types";
import { isHlTestnet, onNetworkChange } from "./network";

function privateKeyToAccountCompat(privateKey: `0x${string}`) {
  // Load viem/accounts lazily so non-signing routes don't fail at module init.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { privateKeyToAccount } = require("viem/accounts");
  return privateKeyToAccount(privateKey);
}

// ============================================
// Config
// ============================================

const DEFAULT_ORDER_CONFIG: OrderConfig = {
  defaultSlippagePercent: 1,
  defaultTif: "Gtc" as TimeInForce,
};

// ============================================
// Retry / Back-off Utility
// ============================================

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

const HL_MAX_CONCURRENT_REQUESTS = Math.max(
  1,
  parseInt(process.env.HL_MAX_CONCURRENT_REQUESTS || "2", 10)
);
const HL_MIN_REQUEST_SPACING_MS = Math.max(
  0,
  parseInt(process.env.HL_MIN_REQUEST_SPACING_MS || "300", 10)
);
const HL_429_FALLBACK_DELAY_MS = Math.max(
  500,
  parseInt(process.env.HL_429_FALLBACK_DELAY_MS || "8000", 10)
);
const HL_429_MIN_COOLDOWN_MS = Math.max(
  500,
  parseInt(process.env.HL_429_MIN_COOLDOWN_MS || "8000", 10)
);

let hlInFlightRequests = 0;
const hlRequestWaiters: Array<() => void> = [];
let nextRequestNotBeforeMs = 0;
let paceQueue: Promise<void> = Promise.resolve();
let globalRateLimitedUntilMs = 0;

async function acquireRequestSlot(): Promise<void> {
  if (hlInFlightRequests < HL_MAX_CONCURRENT_REQUESTS) {
    hlInFlightRequests++;
    return;
  }

  await new Promise<void>((resolve) => {
    hlRequestWaiters.push(() => {
      hlInFlightRequests++;
      resolve();
    });
  });
}

function releaseRequestSlot(): void {
  hlInFlightRequests = Math.max(0, hlInFlightRequests - 1);
  const next = hlRequestWaiters.shift();
  if (next) next();
}

async function waitForPacing(): Promise<void> {
  let releaseCurrent!: () => void;
  const previous = paceQueue;
  paceQueue = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });

  await previous;
  try {
    const now = Date.now();
    if (now < nextRequestNotBeforeMs) {
      await sleep(nextRequestNotBeforeMs - now);
    }
    nextRequestNotBeforeMs = Date.now() + HL_MIN_REQUEST_SPACING_MS;
  } finally {
    releaseCurrent();
  }
}

async function waitForGlobalRateLimitCooldown(): Promise<void> {
  const now = Date.now();
  if (globalRateLimitedUntilMs > now) {
    await sleep(globalRateLimitedUntilMs - now);
  }
}

function setGlobalRateLimitCooldown(ms: number, label: string): void {
  const cooldownMs = Math.max(HL_429_MIN_COOLDOWN_MS, ms);
  const nextUntil = Date.now() + cooldownMs;
  if (nextUntil > globalRateLimitedUntilMs) {
    globalRateLimitedUntilMs = nextUntil;
    console.warn(`[HL] ${label} hit 429, pausing new requests for ${cooldownMs}ms`);
  }
}

async function runWithGlobalRequestGate<T>(
  fn: () => Promise<T>
): Promise<T> {
  await acquireRequestSlot();
  try {
    await waitForGlobalRateLimitCooldown();
    await waitForPacing();
    return await fn();
  } finally {
    releaseRequestSlot();
  }
}

/**
 * Execute an async function with exponential backoff retry.
 * Retries on timeout errors and transient HTTP errors.
 * Only logs on first failure and final give-up to avoid log flooding.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 2, baseDelayMs = 800, maxDelayMs = 5000, label = "API call" } = opts;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await runWithGlobalRequestGate(fn);
    } catch (error: unknown) {
      lastError = error;
      const isRetryable = isRetryableError(error);
      const rateLimited = isRateLimitError(error);

      if (rateLimited) {
        const retryAfterMs = getRetryAfterMs(error);
        const cooldownMs =
          retryAfterMs ??
          Math.min(
            HL_429_FALLBACK_DELAY_MS * Math.pow(2, attempt),
            Math.max(maxDelayMs, 20_000)
          );
        setGlobalRateLimitCooldown(cooldownMs, label);
      }

      if (!isRetryable || attempt === maxRetries) {
        if (attempt > 0) {
          console.warn(`[HL] ${label} failed after ${attempt + 1} attempts: ${getErrorMessage(error)}`);
        }
        throw error;
      }

      const attemptBaseDelay = rateLimited
        ? Math.max(baseDelayMs * Math.pow(2, attempt), HL_429_FALLBACK_DELAY_MS)
        : baseDelayMs * Math.pow(2, attempt);
      const retryDelayCap = rateLimited
        ? Math.max(maxDelayMs, 20_000)
        : maxDelayMs;
      const delay = Math.min(attemptBaseDelay + Math.random() * 500, retryDelayCap);

      // Only log the first retry to keep logs clean
      if (attempt === 0) {
        const reason = rateLimited ? "rate limited" : "timed out";
        console.warn(`[HL] ${label} ${reason}, retrying (up to ${maxRetries} retries)...`);
      }
      await sleep(delay);
    }
  }
  throw lastError;
}

function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  const msg = getErrorMessage(error).toLowerCase();
  // Retry on timeouts, network errors, 429 rate limits, 5xx server errors
  return (
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("429") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504")
  );
}

function isRateLimitError(error: unknown): boolean {
  const status = Number((error as { response?: { status?: number } } | undefined)?.response?.status);
  if (status === 429) return true;
  const msg = getErrorMessage(error).toLowerCase();
  return msg.includes("429") || msg.includes("too many requests") || msg.includes("rate limit");
}

function getRetryAfterMs(error: unknown): number | null {
  const response = (error as { response?: { headers?: Headers } } | undefined)?.response;
  const retryAfter = response?.headers?.get?.("retry-after");
  if (!retryAfter) return null;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================
// In-flight Request Deduplication
// ============================================
// Prevents thundering-herd: if 5 callers ask for clearinghouseState("0xABC")
// at the same time, only 1 real API call is made and all 5 share the result.

const inflightRequests = new Map<string, Promise<unknown>>();

async function dedup<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflightRequests.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fn().finally(() => {
    inflightRequests.delete(key);
  });
  inflightRequests.set(key, promise);
  return promise;
}

// ============================================
// Negative Cache (failure cooldown)
// ============================================
// After all retries fail for a given key, remember the failure for COOLDOWN_MS
// so subsequent requests get an immediate rejection instead of waiting 30s again.

const FAILURE_COOLDOWN_MS = 30_000; // 30s cooldown after a timeout failure
const failureCache = new Map<string, { error: Error; expiry: number }>();
const ACCOUNT_STATE_CACHE_TTL_MS = Math.max(
  1000,
  parseInt(process.env.HL_ACCOUNT_STATE_CACHE_TTL_MS || "20000", 10)
);
const USER_FILLS_CACHE_TTL_MS = Math.max(
  1000,
  parseInt(process.env.HL_USER_FILLS_CACHE_TTL_MS || "45000", 10)
);
const CANDLE_CACHE_TTL_MS = Math.max(
  1000,
  parseInt(process.env.HL_CANDLE_CACHE_TTL_MS || "60000", 10)
);
const CANDLE_CACHE_MAX_ENTRIES = Math.max(
  100,
  parseInt(process.env.HL_CANDLE_CACHE_MAX_ENTRIES || "1000", 10)
);
const candleCache = new Map<string, { data: unknown[]; expiry: number }>();
const accountStateCache = new Map<string, { data: unknown; expiry: number }>();
const userFillsCache = new Map<string, { data: unknown[]; expiry: number }>();

function checkFailureCache(key: string): Error | null {
  const entry = failureCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    failureCache.delete(key);
    return null;
  }
  return entry.error;
}

function setFailureCache(key: string, error: Error): void {
  failureCache.set(key, { error, expiry: Date.now() + FAILURE_COOLDOWN_MS });
}

function clearFailureCache(key: string): void {
  failureCache.delete(key);
}

function getFreshCache<T>(cache: Map<string, { data: T; expiry: number }>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setFreshCache<T>(
  cache: Map<string, { data: T; expiry: number }>,
  key: string,
  data: T,
  ttlMs: number
): void {
  cache.set(key, { data, expiry: Date.now() + ttlMs });
}

function getCandleCache(key: string): unknown[] | null {
  const entry = candleCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    candleCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCandleCache(key: string, data: unknown[]): void {
  if (candleCache.has(key)) candleCache.delete(key);
  candleCache.set(key, { data, expiry: Date.now() + CANDLE_CACHE_TTL_MS });

  while (candleCache.size > CANDLE_CACHE_MAX_ENTRIES) {
    const firstKey = candleCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    candleCache.delete(firstKey);
  }
}

/**
 * Format a price for Hyperliquid API (max 5 significant figures, no trailing zeros).
 */
function formatHlPrice(price: number): string {
  // Use toPrecision to get 5 sig figs, then strip trailing zeros
  return parseFloat(price.toPrecision(5)).toString();
}

// ============================================
// Singleton clients (HTTP) — invalidated on network switch
// ============================================

let infoClient: InfoClient | null = null;
let exchangeClient: ExchangeClient | null = null;

// Per-agent exchange clients
const agentExchangeClients = new Map<string, ExchangeClient>();
const pkpExchangeClients = new Map<string, ExchangeClient>();

/**
 * Flush all cached clients so they rebuild with the new network.
 */
function invalidateClients(): void {
  infoClient = null;
  exchangeClient = null;
  agentExchangeClients.clear();
  pkpExchangeClients.clear();
  // WebSocket also needs to reconnect
  if (wsTransport) {
    wsTransport.close().catch(() => {});
    wsTransport = null;
    subscriptionClient = null;
  }
  // Clear market cache
  marketsCache = null;
}

// Auto-invalidate when HL network changes
onNetworkChange(() => {
  console.log("[HL] Network changed, invalidating clients");
  invalidateClients();
});

export function getInfoClient(): InfoClient {
  if (!infoClient) {
    const transport = new HttpTransport({ 
      isTestnet: isHlTestnet(),
      timeout: 10000, // 10 second timeout — fast-fail for dashboard, retries handle transients
    });
    infoClient = new InfoClient({ transport });
  }
  return infoClient;
}

export function getExchangeClient(): ExchangeClient {
  if (!exchangeClient) {
    const pk = process.env.HYPERLIQUID_PRIVATE_KEY;
    if (!pk) throw new Error("HYPERLIQUID_PRIVATE_KEY not set");
    const wallet = privateKeyToAccountCompat(pk as `0x${string}`);
    const transport = new HttpTransport({ 
      isTestnet: isHlTestnet(),
      timeout: 15000, // 15 second timeout for exchange operations
    });
    exchangeClient = new ExchangeClient({ transport, wallet });
  }
  return exchangeClient;
}

export function getExchangeClientForAgent(
  privateKey: string
): ExchangeClient {
  // Cache by key hash (first 10 chars)
  const cacheKey = privateKey.slice(0, 10);
  let client = agentExchangeClients.get(cacheKey);
  if (!client) {
    const wallet = privateKeyToAccountCompat(privateKey as `0x${string}`);
    const transport = new HttpTransport({ 
      isTestnet: isHlTestnet(),
      timeout: 30000, // 30 second timeout
    });
    client = new ExchangeClient({ transport, wallet });
    agentExchangeClients.set(cacheKey, client);
  }
  return client;
}

export async function getExchangeClientForPKP(agentId: string): Promise<ExchangeClient> {
  const cached = pkpExchangeClients.get(agentId);
  if (cached) return cached;

  const { getPKPForAgent } = await import("./account-manager");
  const { getLitClient, getOperatorAuthContext } = await import("./lit-protocol");

  const pkpInfo = await getPKPForAgent(agentId);
  if (!pkpInfo) {
    throw new Error(`No PKP wallet found for agent ${agentId}`);
  }

  const client = await getLitClient();
  const authContext = await getOperatorAuthContext();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { arbitrum, arbitrumSepolia } = require("viem/chains");
  const wallet = await client.getPkpViemAccount({
    pkpPublicKey: pkpInfo.publicKey,
    authContext,
    chainConfig: isHlTestnet() ? arbitrumSepolia : arbitrum,
  });

  const transport = new HttpTransport({
    isTestnet: isHlTestnet(),
    timeout: 30000,
  });
  const exchange = new ExchangeClient({ transport, wallet: wallet as any });
  pkpExchangeClients.set(agentId, exchange);
  return exchange;
}

// ============================================
// Singleton WebSocket transport + subscription client
// ============================================

let wsTransport: WebSocketTransport | null = null;
let subscriptionClient: SubscriptionClient | null = null;

export function getWsTransport(): WebSocketTransport {
  if (!wsTransport) {
    wsTransport = new WebSocketTransport({
      isTestnet: isHlTestnet(),
      resubscribe: true,
    });
  }
  return wsTransport;
}

export async function getSubscriptionClient(): Promise<SubscriptionClient> {
  if (!subscriptionClient) {
    const transport = getWsTransport();
    await transport.ready();
    subscriptionClient = new SubscriptionClient({ transport });
  }
  return subscriptionClient;
}

export async function closeWsTransport(): Promise<void> {
  if (wsTransport) {
    await wsTransport.close();
    wsTransport = null;
    subscriptionClient = null;
  }
}

// ============================================
// Testnet Helpers
// ============================================

export function isTestnet(): boolean {
  return isHlTestnet();
}

export function getApiUrl(): string {
  return isHlTestnet()
    ? "https://api.hyperliquid-testnet.xyz"
    : "https://api.hyperliquid.xyz";
}

// ============================================
// Market Data
// ============================================

export async function getAllMids(): Promise<Record<string, string>> {
  const info = getInfoClient();
  return await withRetry(() => info.allMids(), { label: "allMids" });
}

export async function getMarketData(): Promise<MarketData[]> {
  const info = getInfoClient();
  const [mids, meta] = await Promise.all([
    withRetry(() => info.allMids(), { label: "allMids" }),
    withRetry(() => info.meta(), { label: "meta" }),
  ]);

  return meta.universe.map((asset) => ({
    coin: asset.name,
    price: parseFloat(mids[asset.name] || "0"),
    change24h: 0,
    volume24h: 0,
    fundingRate: 0,
    openInterest: 0,
  }));
}

export async function getEnrichedMarketData(): Promise<MarketData[]> {
  const info = getInfoClient();
  const [mids, meta, assetCtxs] = await Promise.all([
    withRetry(() => info.allMids(), { label: "allMids" }),
    withRetry(() => info.meta(), { label: "meta" }),
    withRetry(() => info.metaAndAssetCtxs(), { label: "metaAndAssetCtxs" }),
  ]);

  const ctxs = assetCtxs[1]; // second element is the asset contexts array

  return meta.universe.map((asset, i) => {
    const ctx = ctxs[i];
    return {
      coin: asset.name,
      price: parseFloat(mids[asset.name] || "0"),
      change24h: 0,
      volume24h: ctx ? parseFloat(String(ctx.dayNtlVlm || "0")) : 0,
      fundingRate: ctx ? parseFloat(String(ctx.funding || "0")) * 100 : 0,
      openInterest: ctx ? parseFloat(String(ctx.openInterest || "0")) : 0,
    };
  });
}

export async function getL2Book(coin: string) {
  const info = getInfoClient();
  return await withRetry(() => info.l2Book({ coin, nSigFigs: 5 }), { label: `l2Book(${coin})` });
}

export async function getFundingHistory(coin: string, startTime: number) {
  const info = getInfoClient();
  return await withRetry(() => info.fundingHistory({ coin, startTime }), { label: `fundingHistory(${coin})` });
}

/**
 * Fetch historical candle data for a coin
 * @param coin - The coin symbol (e.g., "SOL", "ETH")
 * @param interval - The candle interval
 * @param startTime - Start timestamp in milliseconds
 * @param endTime - End timestamp in milliseconds (optional, defaults to now)
 * @returns Array of candles with [timestamp, open, high, low, close, volume]
 */
export async function getCandleData(
  coin: string,
  interval: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "8h" | "12h" | "1d" | "3d" | "1w" | "1M" = "1h",
  startTime?: number,
  endTime?: number
) {
  const info = getInfoClient();

  // Default to last 100 candles if no time specified
  if (!startTime) {
    const intervalMs = parseInterval(interval);
    endTime = Date.now();
    startTime = endTime - (intervalMs * 100);
  }

  const resolvedEndTime = endTime || Date.now();
  const cacheKey = `candleSnapshot:${coin}:${interval}:${startTime}:${resolvedEndTime}`;
  const cached = getCandleCache(cacheKey);
  if (cached) return cached;

  const candles = await dedup(cacheKey, () =>
    withRetry(
      () => info.candleSnapshot({
        coin,
        interval,
        startTime: startTime,
        endTime: resolvedEndTime,
      }),
      { label: `candleSnapshot(${coin})` }
    )
  );

  setCandleCache(cacheKey, candles as unknown[]);
  return candles;
}

/**
 * Parse interval string to milliseconds
 */
function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)([mhdwM])$/);
  if (!match) return 60 * 60 * 1000; // default 1h

  const value = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    case 'w': return value * 7 * 24 * 60 * 60 * 1000;
    case 'M': return value * 30 * 24 * 60 * 60 * 1000;
    default: return 60 * 60 * 1000;
  }
}

/**
 * Get historical prices from candle data
 * @param coin - The coin symbol
 * @param interval - Candle interval (default "15m" for good RSI calculation)
 * @param count - Number of candles to fetch (default 50, enough for 14-period RSI with history)
 */
export async function getHistoricalPrices(
  coin: string,
  interval: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "8h" | "12h" | "1d" | "3d" | "1w" | "1M" = "15m",
  count: number = 50
): Promise<{ prices: number[]; highs: number[]; lows: number[] }> {
  try {
    const intervalMs = parseInterval(interval);
    const endTime = Math.floor(Date.now() / intervalMs) * intervalMs;
    const startTime = endTime - (intervalMs * count);

    const candles = await getCandleData(coin, interval, startTime, endTime);

    if (!candles || candles.length === 0) {
      console.warn(`[HL] No candle data for ${coin}`);
      return { prices: [], highs: [], lows: [] };
    }

    // Extract close prices, highs, and lows
    const prices = candles.map((c: any) => parseFloat(c.c)); // close price
    const highs = candles.map((c: any) => parseFloat(c.h)); // high
    const lows = candles.map((c: any) => parseFloat(c.l)); // low
    
    return { prices, highs, lows };
  } catch (error) {
    console.error(`[HL] Failed to fetch historical prices for ${coin}:`, error);
    return { prices: [], highs: [], lows: [] };
  }
}

// ============================================
// Account & Positions
// ============================================

export async function getAccountState(user: Address) {
  const cacheKey = `clearinghouseState:${user}`;
  const stale = getFreshCache(accountStateCache, cacheKey);
  // Fast-reject if this address recently failed — don't wait 30s again
  const cached = checkFailureCache(cacheKey);
  if (cached) {
    if (stale) {
      console.warn(`[HL] Using cached account state for ${user.slice(0, 8)} after recent failure`);
      return stale as Awaited<ReturnType<InfoClient["clearinghouseState"]>>;
    }
    throw cached;
  }

  return dedup(cacheKey, async () => {
    const info = getInfoClient();
    try {
      const state = await withRetry(
        () => info.clearinghouseState({ user }),
        { label: `clearinghouseState(${user.slice(0, 8)})` }
      );
      setFreshCache(accountStateCache, cacheKey, state, ACCOUNT_STATE_CACHE_TTL_MS);
      clearFailureCache(cacheKey);
      return state;
    } catch (error) {
      if (stale) {
        console.warn(`[HL] clearinghouseState fallback to cached snapshot for ${user.slice(0, 8)}`);
        return stale as Awaited<ReturnType<InfoClient["clearinghouseState"]>>;
      }
      // Cache the failure so next request within 30s returns immediately
      if (error instanceof Error) setFailureCache(cacheKey, error);
      throw error;
    }
  });
}

export async function getOpenOrders(user: Address) {
  return dedup(`openOrders:${user}`, async () => {
    const info = getInfoClient();
    return await withRetry(
      () => info.openOrders({ user }),
      { label: `openOrders(${user.slice(0, 8)})` }
    );
  });
}

export async function getUserFills(user: Address) {
  const cacheKey = `userFills:${user}`;
  const stale = getFreshCache(userFillsCache, cacheKey);
  return dedup(cacheKey, async () => {
    const info = getInfoClient();
    try {
      const fills = await withRetry(
      () => info.userFills({ user }),
      { label: `userFills(${user.slice(0, 8)})` }
      );
      setFreshCache(userFillsCache, cacheKey, fills as unknown[], USER_FILLS_CACHE_TTL_MS);
      return fills;
    } catch (error) {
      if (stale) {
        console.warn(`[HL] userFills fallback to cached snapshot for ${user.slice(0, 8)}`);
        return stale as Awaited<ReturnType<InfoClient["userFills"]>>;
      }
      throw error;
    }
  });
}

export async function getUserFillsByTime(
  user: Address,
  startTime: number,
  endTime?: number
) {
  const info = getInfoClient();
  return await withRetry(
    () => info.userFillsByTime({ user, startTime, endTime }),
    { label: `userFillsByTime(${user.slice(0, 8)})` }
  );
}

export async function getSpotState(user: Address) {
  const info = getInfoClient();
  return await withRetry(
    () => info.spotClearinghouseState({ user }),
    { label: `spotState(${user.slice(0, 8)})` }
  );
}

// ============================================
// Trading - Core
// ============================================

export async function placeOrder(params: {
  asset: number;
  isBuy: boolean;
  price: string;
  size: string;
  reduceOnly: boolean;
  orderType: "Gtc" | "Ioc" | "Alo";
  vaultAddress?: Address;
  builder?: { b: string; f: number };
}, exchange?: ExchangeClient) {
  const exchangeClient = exchange ?? getExchangeClient();
  
  // Add builder code if available
  const { assertBuilderConfiguredForTrading, getBuilderParam } = await import("./builder");
  assertBuilderConfiguredForTrading();
  const builderParam = params.builder ?? getBuilderParam();
  
  return await exchangeClient.order({
    orders: [
      {
        a: params.asset,
        b: params.isBuy,
        p: params.price,
        s: params.size,
        r: params.reduceOnly,
        t: { limit: { tif: params.orderType } },
      },
    ],
    grouping: "na",
    ...(params.vaultAddress ? { vaultAddress: params.vaultAddress } : {}),
    ...(builderParam ? { builder: builderParam } : {}),
  });
}

export async function cancelOrder(asset: number, orderId: number, exchange?: ExchangeClient) {
  const exchangeClient = exchange ?? getExchangeClient();
  return await exchangeClient.cancel({
    cancels: [{ a: asset, o: orderId }],
  });
}

export async function cancelAllOrders(coin?: string) {
  const info = getInfoClient();
  const exchange = getExchangeClient();

  // Get the wallet address from the exchange client
  const pk = process.env.HYPERLIQUID_PRIVATE_KEY;
  if (!pk) throw new Error("HYPERLIQUID_PRIVATE_KEY not set");
  const wallet = privateKeyToAccountCompat(pk as `0x${string}`);

  const orders = await info.openOrders({ user: wallet.address });
  const cancels = orders
    .filter((o) => !coin || o.coin === coin)
    .map((o) => ({ a: getAssetIndexSync(o.coin) ?? 0, o: o.oid }));

  if (cancels.length === 0) return { cancelled: 0 };

  const result = await exchange.cancel({ cancels });
  return { cancelled: cancels.length, result };
}

export async function updateLeverage(
  asset: number,
  leverage: number,
  isCross: boolean = true,
  exchange?: ExchangeClient
) {
  const exchangeClient = exchange ?? getExchangeClient();
  
  // Ensure leverage is a valid integer between 1 and 50
  const validLeverage = Math.max(1, Math.min(50, Math.round(leverage)));
  
  console.log(`[HL] Setting leverage for asset ${asset} to ${validLeverage}x (requested: ${leverage})`);
  
  return await exchangeClient.updateLeverage({
    asset,
    isCross,
    leverage: validLeverage,
  });
}

// ============================================
// Trading - Extended Order Types
// ============================================

export async function placeMarketOrder(params: {
  asset: number;
  isBuy: boolean;
  size: string;
  slippagePercent?: number;
  reduceOnly?: boolean;
  vaultAddress?: Address;
  builder?: { b: string; f: number };
}, exchange?: ExchangeClient) {
  const info = getInfoClient();
  const meta = await info.meta();
  const assetMeta = meta.universe[params.asset];
  const coin = assetMeta?.name;
  if (!coin) throw new Error(`Unknown asset index: ${params.asset}`);

  const mids = await info.allMids();
  const midPrice = parseFloat(mids[coin] || "0");
  if (midPrice === 0) throw new Error(`No price for ${coin}`);

  const slippage = (params.slippagePercent ?? DEFAULT_ORDER_CONFIG.defaultSlippagePercent) / 100;
  const rawPrice = params.isBuy
    ? midPrice * (1 + slippage)
    : midPrice * (1 - slippage);

  // HL requires prices with at most 5 significant figures
  const price = formatHlPrice(rawPrice);

  // Format size to correct decimal places for this asset
  const szDecimals = assetMeta.szDecimals ?? 2;
  const rawSize = parseFloat(params.size);
  const formattedSize = rawSize.toFixed(szDecimals);

  return await placeOrder({
    asset: params.asset,
    isBuy: params.isBuy,
    price,
    size: formattedSize,
    reduceOnly: params.reduceOnly ?? false,
    orderType: "Ioc",
    vaultAddress: params.vaultAddress,
    builder: params.builder,
  }, exchange);
}

export async function placeStopLossOrder(params: {
  asset: number;
  isBuy: boolean;
  size: string;
  price: string;
  triggerPrice: string;
  isTpsl?: boolean;
  vaultAddress?: Address;
  builder?: { b: string; f: number };
}, exchange?: ExchangeClient) {
  const exchangeClient = exchange ?? getExchangeClient();
  const info = getInfoClient();
  const meta = await info.meta();
  const szDecimals = meta.universe[params.asset]?.szDecimals ?? 2;
  const formattedSize = parseFloat(params.size).toFixed(szDecimals);
  const formattedPrice = formatHlPrice(parseFloat(params.price));
  const formattedTrigger = formatHlPrice(parseFloat(params.triggerPrice));
  
  // Add builder code if available
  const { assertBuilderConfiguredForTrading, getBuilderParam } = await import("./builder");
  assertBuilderConfiguredForTrading();
  const builderParam = params.builder ?? getBuilderParam();
  
  return await exchangeClient.order({
    orders: [
      {
        a: params.asset,
        b: params.isBuy,
        p: formattedPrice,
        s: formattedSize,
        r: true, // stop-loss is always reduce-only
        t: {
          trigger: {
            triggerPx: formattedTrigger,
            isMarket: true,
            tpsl: "sl",
          },
        },
      },
    ],
    grouping: params.isTpsl ? "positionTpsl" : "na",
    ...(params.vaultAddress ? { vaultAddress: params.vaultAddress } : {}),
    ...(builderParam ? { builder: builderParam } : {}),
  });
}

export async function placeTakeProfitOrder(params: {
  asset: number;
  isBuy: boolean;
  size: string;
  price: string;
  triggerPrice: string;
  isTpsl?: boolean;
  vaultAddress?: Address;
  builder?: { b: string; f: number };
}, exchange?: ExchangeClient) {
  const exchangeClient = exchange ?? getExchangeClient();
  const info = getInfoClient();
  const meta = await info.meta();
  const szDecimals = meta.universe[params.asset]?.szDecimals ?? 2;
  const formattedSize = parseFloat(params.size).toFixed(szDecimals);
  const formattedPrice = formatHlPrice(parseFloat(params.price));
  const formattedTrigger = formatHlPrice(parseFloat(params.triggerPrice));
  
  // Add builder code if available
  const { assertBuilderConfiguredForTrading, getBuilderParam } = await import("./builder");
  assertBuilderConfiguredForTrading();
  const builderParam = params.builder ?? getBuilderParam();
  
  return await exchangeClient.order({
    orders: [
      {
        a: params.asset,
        b: params.isBuy,
        p: formattedPrice,
        s: formattedSize,
        r: true,
        t: {
          trigger: {
            triggerPx: formattedTrigger,
            isMarket: true,
            tpsl: "tp",
          },
        },
      },
    ],
    grouping: params.isTpsl ? "positionTpsl" : "na",
    ...(params.vaultAddress ? { vaultAddress: params.vaultAddress } : {}),
    ...(builderParam ? { builder: builderParam } : {}),
  });
}

/**
 * Unified order placement - resolves order type and executes.
 * If exchange is provided (e.g. agent's wallet), uses that; otherwise uses operator key.
 */
export async function executeOrder(
  params: PlaceOrderParams,
  exchange?: ExchangeClient
): Promise<unknown> {
  const assetIndex = await getAssetIndex(params.coin);
  const isBuy =
    params.side === "buy" || params.side === "long";

  // Get builder param if available
  const { assertBuilderConfiguredForTrading, getBuilderParam } = await import("./builder");
  assertBuilderConfiguredForTrading();
  const builderParam = getBuilderParam();

  switch (params.orderType) {
    case "market":
      return placeMarketOrder({
        asset: assetIndex,
        isBuy,
        size: params.size.toString(),
        slippagePercent: params.slippagePercent,
        reduceOnly: params.reduceOnly,
        vaultAddress: params.vaultAddress,
        builder: builderParam,
      }, exchange);

    case "limit":
      if (!params.price) throw new Error("Price required for limit orders");
      return placeOrder({
        asset: assetIndex,
        isBuy,
        price: params.price.toString(),
        size: params.size.toString(),
        reduceOnly: params.reduceOnly ?? false,
        orderType: params.tif ?? DEFAULT_ORDER_CONFIG.defaultTif,
        vaultAddress: params.vaultAddress,
        builder: builderParam,
      }, exchange);

    case "stop-loss":
      if (!params.price || !params.triggerPrice)
        throw new Error("Price and triggerPrice required for stop-loss");
      return placeStopLossOrder({
        asset: assetIndex,
        isBuy,
        size: params.size.toString(),
        price: params.price.toString(),
        triggerPrice: params.triggerPrice.toString(),
        isTpsl: params.isTpsl,
        vaultAddress: params.vaultAddress,
        builder: builderParam,
      }, exchange);

    case "take-profit":
      if (!params.price || !params.triggerPrice)
        throw new Error("Price and triggerPrice required for take-profit");
      return placeTakeProfitOrder({
        asset: assetIndex,
        isBuy,
        size: params.size.toString(),
        price: params.price.toString(),
        triggerPrice: params.triggerPrice.toString(),
        isTpsl: params.isTpsl,
        vaultAddress: params.vaultAddress,
        builder: builderParam,
      }, exchange);

    default:
      throw new Error(`Unknown order type: ${params.orderType}`);
  }
}

// ============================================
// Vault Operations (Hyperliquid native vaults)
// ============================================

export async function depositToVault(
  vaultAddress: Address,
  usdAmount: number
) {
  const exchange = getExchangeClient();
  return await exchange.vaultTransfer({
    vaultAddress,
    isDeposit: true,
    usd: usdAmount,
  });
}

export async function withdrawFromVault(
  vaultAddress: Address,
  usdAmount: number
) {
  const exchange = getExchangeClient();
  return await exchange.vaultTransfer({
    vaultAddress,
    isDeposit: false,
    usd: usdAmount,
  });
}

// ============================================
// Asset index lookup
// ============================================

let assetMap: Record<string, number> | null = null;

export function getAssetIndexSync(coin: string): number | undefined {
  return assetMap?.[coin];
}

export async function getAssetIndex(coin: string): Promise<number> {
  if (!assetMap) {
    const info = getInfoClient();
    const meta = await withRetry(() => info.meta(), { label: "meta (asset index)" });
    assetMap = {};
    meta.universe.forEach((asset, index) => {
      assetMap![asset.name] = index;
    });
  }
  const idx = assetMap[coin];
  if (idx === undefined) throw new Error(`Unknown asset: ${coin}`);
  return idx;
}

export async function getAllAssets(): Promise<
  Array<{ name: string; index: number; maxLeverage: number }>
> {
  const info = getInfoClient();
  const meta = await info.meta();
  return meta.universe.map((asset, index) => ({
    name: asset.name,
    index,
    maxLeverage: asset.maxLeverage,
  }));
}

// ============================================
// USD Transfers (fund agent wallets)
// ============================================

/**
 * Send USDC from the operator's HL account to a destination address.
 * Used to fund agent wallets 1:1 when users deposit MON on Monad.
 *
 * @param destination - Agent's HL address
 * @param amount - USD amount (1 = $1)
 */
export async function sendUsdToAgent(
  destination: Address,
  amount: number
): Promise<unknown> {
  const exchange = getExchangeClient();
  return await exchange.usdSend({
    destination,
    amount: amount.toString(),
  });
}

/**
 * Send USDC from an agent wallet to a destination address.
 * Supports both traditional key-based wallets and PKP wallets.
 */
export async function sendUsdFromAgent(
  agentId: string,
  destination: Address,
  amount: number
): Promise<unknown> {
  const { getAccountForAgent, getPrivateKeyForAgent } = await import("./account-manager");
  const account = await getAccountForAgent(agentId);
  if (!account) {
    throw new Error(`No wallet found for agent ${agentId}`);
  }

  if (account.type === "readonly") {
    throw new Error(`Agent ${agentId} wallet is readonly and cannot sign transfers`);
  }

  if (account.type === "pkp") {
    const exchange = await getExchangeClientForPKP(agentId);
    return await exchange.usdSend({
      destination,
      amount: amount.toString(),
    });
  }

  const privateKey = await getPrivateKeyForAgent(agentId);
  if (!privateKey) {
    throw new Error(`No private key available for agent ${agentId}`);
  }

  const exchange = getExchangeClientForAgent(privateKey);
  return await exchange.usdSend({
    destination,
    amount: amount.toString(),
  });
}

/**
 * Generate a brand new Hyperliquid wallet for an agent.
 * Returns the private key and derived address.
 *
 * NOTE: For production, consider using provisionPKPWallet() instead
 * which provides distributed key management via Lit Protocol.
 *
 * @deprecated Use provisionPKPWallet for better security
 */
export function generateAgentWallet(): { privateKey: string; address: Address } {
  // Generate random private key (32 bytes)
  const keyBytes = randomBytes(32);
  const privateKey = "0x" + keyBytes.toString("hex");
  const account = privateKeyToAccountCompat(privateKey as `0x${string}`);
  return { privateKey, address: account.address };
}

/**
 * Provision a PKP (Programmable Key Pair) wallet for an agent.
 *
 * This is the secure alternative to generateAgentWallet():
 * - Private key never exists in full form
 * - Distributed via Lit Protocol's threshold network
 * - Trading constraints enforced at cryptographic layer
 *
 * @param agentId - The agent ID to provision wallet for
 * @param constraints - Optional trading constraints to enforce
 */
export async function provisionPKPWallet(
  agentId: string,
  constraints?: {
    maxPositionSizeUsd?: number;
    allowedCoins?: string[];
    maxLeverage?: number;
    requireStopLoss?: boolean;
  }
): Promise<{
  address: Address;
  pkpTokenId: string;
  signingMethod: "pkp";
} | null> {
  try {
    const { provisionPKPForAgent } = await import("./lit-signing");
    
    const result = await provisionPKPForAgent(agentId, constraints);
    
    if (!result.success || !result.address || !result.pkpTokenId) {
      console.error("[HL] Failed to provision PKP:", result.error);
      return null;
    }
    
    return {
      address: result.address,
      pkpTokenId: result.pkpTokenId,
      signingMethod: "pkp",
    };
  } catch (error) {
    console.error("[HL] Error provisioning PKP wallet:", error);
    return null;
  }
}

/**
 * Provision and fund a new HL wallet for an agent.
 *
 * Supports two modes:
 * - "pkp" (recommended): Uses Lit Protocol for distributed key management
 * - "traditional": Uses encrypted private key storage
 *
 * Flow:
 * 1. Generate new wallet (PKP or traditional)
 * 2. Store it via account-manager
 * 3. Send USDC from operator to the new wallet
 * 4. Auto-approve builder code (if traditional mode)
 * 5. Return the wallet info
 */
export async function provisionAgentWallet(
  agentId: string,
  fundingAmountUsd: number,
  options?: {
    mode?: "pkp" | "traditional";
    constraints?: {
      maxPositionSizeUsd?: number;
      allowedCoins?: string[];
      maxLeverage?: number;
      requireStopLoss?: boolean;
    };
  }
): Promise<{
  address: Address;
  funded: boolean;
  fundedAmount: number;
  txResult: unknown;
  builderApproved?: boolean;
  signingMethod: "pkp" | "traditional";
}> {
  const mode = options?.mode || (process.env.USE_LIT_PKP === "true" ? "pkp" : "traditional");
  
  // Dynamic import to avoid circular deps
  const { addAccount, getAccountForAgent, isPKPAccount } = await import("./account-manager");

  // Check if agent already has a wallet
  const existing = await getAccountForAgent(agentId);
  if (existing) {
    const existingMethod = await isPKPAccount(agentId) ? "pkp" : "traditional";
    
    // Already has a wallet — just fund it
    if (fundingAmountUsd > 0) {
      try {
        const result = await sendUsdToAgent(existing.address, fundingAmountUsd);
        return {
          address: existing.address,
          funded: true,
          fundedAmount: fundingAmountUsd,
          txResult: result,
          signingMethod: existingMethod,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTimeout = errMsg.toLowerCase().includes("timeout");
        if (isTimeout) {
          console.warn(`[HL] Timeout funding agent wallet ${existing.address.slice(0, 8)} — HL API unreachable`);
        } else {
          console.error(`[HL] Failed to fund agent wallet ${existing.address.slice(0, 8)}: ${errMsg.slice(0, 150)}`);
        }
        return {
          address: existing.address,
          funded: false,
          fundedAmount: 0,
          txResult: errMsg,
          signingMethod: existingMethod,
        };
      }
    }
    return {
      address: existing.address,
      funded: false,
      fundedAmount: 0,
      txResult: null,
      signingMethod: existingMethod,
    };
  }

  let address: Address;
  let signingMethod: "pkp" | "traditional";
  let privateKey: string | undefined;

  let builderApproved = false;

  if (mode === "pkp") {
    // Use Lit Protocol PKP for secure distributed key management
    console.log(`[HL] Provisioning PKP wallet for agent ${agentId}`);
    
    const pkpResult = await provisionPKPWallet(agentId, options?.constraints);
    
    if (!pkpResult) {
      // Fallback to traditional if PKP fails
      console.warn("[HL] PKP provisioning failed, falling back to traditional wallet");
      const generated = generateAgentWallet();
      privateKey = generated.privateKey;
      
      await addAccount({
        alias: `agent-${agentId.slice(0, 8)}`,
        privateKey,
        agentId,
        isDefault: false,
      });
      
      address = generated.address;
      signingMethod = "traditional";
    } else {
      address = pkpResult.address;
      signingMethod = "pkp";
      // Builder approval for PKP is handled at order-time fallback if needed.
      builderApproved = false;
    }
  } else {
    // Traditional: generate local wallet with encrypted private key
    console.log(`[HL] Provisioning traditional wallet for agent ${agentId}`);
    
    const generated = generateAgentWallet();
    privateKey = generated.privateKey;

    // Store encrypted
    await addAccount({
      alias: `agent-${agentId.slice(0, 8)}`,
      privateKey,
      agentId,
      isDefault: false,
    });
    
    address = generated.address;
    signingMethod = "traditional";
  }

  // Fund from operator
  let funded = false;
  let txResult: unknown = null;
  if (fundingAmountUsd > 0) {
    try {
      txResult = await sendUsdToAgent(address, fundingAmountUsd);
      funded = true;
    } catch (err) {
      console.error("[HL] Failed to fund new agent wallet:", err);
      txResult = err instanceof Error ? err.message : String(err);
    }
  }

  // Auto-approve builder code for new wallet (Vincent-style)
  // Handles both PKP and traditional wallets
  if (funded) {
    try {
      const { autoApproveBuilderCode } = await import("./builder");
      const approvalResult = await autoApproveBuilderCode(
        address, 
        privateKey, // undefined for PKP
        agentId      // used for PKP signing
      );
      builderApproved = approvalResult.success;
      
      if (approvalResult.alreadyApproved) {
        console.log(`[HL] Builder code already approved for ${address}`);
      } else if (builderApproved) {
        console.log(`[HL] Builder code auto-approved for new agent ${address}`);
      } else {
        console.warn(`[HL] Failed to auto-approve builder code: ${approvalResult.error}`);
      }
    } catch (err) {
      console.error("[HL] Builder code auto-approval error:", err);
      // Don't fail wallet provisioning if builder approval fails
    }
  }

  return {
    address,
    funded,
    fundedAmount: funded ? fundingAmountUsd : 0,
    txResult,
    builderApproved,
    signingMethod,
  };
}

export interface AgentPosition {
  coin: string;
  size: number;
  side: "long" | "short";
  entryPrice: number;
  markPrice: number;
  positionValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  leverage: number;
  marginUsed: number;
  liquidationPrice: number | null;
}

export interface AgentHlState {
  address: Address | null;
  accountValue: string;
  availableBalance: string;
  marginUsed: string;
  totalUnrealizedPnl: number;
  /** Realized PnL from closed trades (sum of closedPnl from user fills) */
  realizedPnl: number;
  /** Total PnL = realized + unrealized (holistic view of active + closed trades) */
  totalPnl: number;
  positions: AgentPosition[];
}

/**
 * Get the HL account balance for an agent's wallet.
 */
export async function getAgentHlBalance(
  agentId: string
): Promise<{
  address: Address | null;
  accountValue: string;
  availableBalance: string;
  marginUsed: string;
} | null> {
  // Dedup: multiple callers for the same agent share one in-flight request
  return dedup(`agentHlBalance:${agentId}`, async () => {
    const { getAccountForAgent } = await import("./account-manager");
    const account = await getAccountForAgent(agentId);
    if (!account) return null;

    try {
      const state = await getAccountState(account.address);
      return {
        address: account.address,
        accountValue: state.marginSummary?.accountValue || "0",
        availableBalance: state.withdrawable || "0",
        marginUsed: state.marginSummary?.totalMarginUsed || "0",
      };
    } catch {
      return {
        address: account.address,
        accountValue: "0",
        availableBalance: "0",
        marginUsed: "0",
      };
    }
  });
}

/**
 * Compute realized PnL from HL user fills (closed trades).
 * Sums closedPnl across all fills for holistic closed-trade PnL.
 */
export async function getRealizedPnlFromFills(user: Address): Promise<number> {
  try {
    const fills = await getUserFills(user);
    const realized = fills.reduce(
      (sum, f) => sum + parseFloat(String((f as { closedPnl?: string }).closedPnl ?? "0")),
      0
    );
    return realized;
  } catch {
    return 0;
  }
}

/**
 * Get the full HL account state including positions for an agent's wallet.
 * totalPnl = realized (from closed trades) + unrealized (from open positions).
 */
export async function getAgentHlState(
  agentId: string
): Promise<AgentHlState | null> {
  // Dedup: multiple concurrent callers for the same agent share one request
  return dedup(`agentHlState:${agentId}`, async () => {
  const { getAccountForAgent } = await import("./account-manager");
  const account = await getAccountForAgent(agentId);
  if (!account) return null;

  try {
    // Fetch state and fills in parallel for holistic PnL (active + closed trades)
    const [state, realizedPnl] = await Promise.all([
      getAccountState(account.address),
      getRealizedPnlFromFills(account.address),
    ]);
    const mids = await withRetry(() => getInfoClient().allMids(), { label: "allMids(agent state)" });
    
    // Parse positions
    const positions: AgentPosition[] = (state.assetPositions || [])
      .filter((p) => parseFloat(p.position.szi) !== 0)
      .map((p) => {
        const size = parseFloat(p.position.szi);
        const entryPrice = parseFloat(p.position.entryPx || "0");
        const markPrice = parseFloat(mids[p.position.coin] || "0");
        const positionValue = Math.abs(size) * markPrice;
        const unrealizedPnl = parseFloat(p.position.unrealizedPnl);
        const leverageVal = parseFloat(String(p.position.leverage?.value ?? "1"));
        const marginUsed = parseFloat(p.position.marginUsed || "0");
        const liquidationPx = p.position.liquidationPx ? parseFloat(p.position.liquidationPx) : null;
        
        return {
          coin: p.position.coin,
          size: Math.abs(size),
          side: size > 0 ? "long" as const : "short" as const,
          entryPrice,
          markPrice,
          positionValue,
          unrealizedPnl,
          unrealizedPnlPercent: entryPrice > 0 
            ? (unrealizedPnl / (Math.abs(size) * entryPrice)) * 100 
            : 0,
          leverage: leverageVal,
          marginUsed,
          liquidationPrice: liquidationPx,
        };
      });

    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const totalPnl = realizedPnl + totalUnrealizedPnl;

    return {
      address: account.address,
      accountValue: state.marginSummary?.accountValue || "0",
      availableBalance: state.withdrawable || "0",
      marginUsed: state.marginSummary?.totalMarginUsed || "0",
      totalUnrealizedPnl,
      realizedPnl,
      totalPnl,
      positions,
    };
  } catch (error) {
    // Log concisely instead of dumping full stack traces
    const msg = error instanceof Error ? error.message : String(error);
    const isTimeout = msg.toLowerCase().includes("timeout");
    if (isTimeout) {
      console.warn(`[HL] Timeout fetching agent state for ${agentId} — returning cached/empty`);
    } else {
      console.error(`[HL] Error fetching agent state for ${agentId}: ${msg}`);
    }
    return {
      address: account.address,
      accountValue: "0",
      availableBalance: "0",
      marginUsed: "0",
      totalUnrealizedPnl: 0,
      realizedPnl: 0,
      totalPnl: 0,
      positions: [],
    };
  }
  }); // end dedup
}

// ============================================
// Full Market Catalog (Perps + Spot)
// ============================================

export interface PerpMarketInfo {
  name: string;
  index: number;
  maxLeverage: number;
  isDelisted: boolean;
  category: "perp";
}

export interface SpotMarketInfo {
  name: string;
  index: number;
  tokens: number[];
  isCanonical: boolean; // "verified" / established market
  category: "spot";
}

export interface SpotTokenInfo {
  name: string;
  fullName: string | null;
  index: number;
  tokenId: string;
  isCanonical: boolean;
  szDecimals: number;
  weiDecimals: number;
  evmContract: string | null;
}

export interface AllMarketsResult {
  perps: PerpMarketInfo[];
  spots: SpotMarketInfo[];
  spotTokens: SpotTokenInfo[];
}

let marketsCache: { data: AllMarketsResult; timestamp: number } | null = null;
const MARKETS_CACHE_TTL = 60_000; // 1 min

export async function getAllMarkets(): Promise<AllMarketsResult> {
  // Return cached if fresh
  if (marketsCache && Date.now() - marketsCache.timestamp < MARKETS_CACHE_TTL) {
    return marketsCache.data;
  }

  const info = getInfoClient();
  try {
  const [perpMeta, spotMeta] = await Promise.all([
    withRetry(() => info.meta(), { label: "meta (markets)" }),
    withRetry(() => info.spotMeta(), { label: "spotMeta (markets)" }),
  ]);

  const perps: PerpMarketInfo[] = perpMeta.universe.map((asset, index) => ({
    name: asset.name,
    index,
    maxLeverage: asset.maxLeverage,
    isDelisted: asset.isDelisted ?? false,
    category: "perp" as const,
  }));

  const spots: SpotMarketInfo[] = spotMeta.universe.map((pair) => ({
    name: pair.name,
    index: pair.index,
    tokens: pair.tokens,
    isCanonical: pair.isCanonical,
    category: "spot" as const,
  }));

  const spotTokens: SpotTokenInfo[] = spotMeta.tokens.map((token) => ({
    name: token.name,
    fullName: token.fullName ?? null,
    index: token.index,
    tokenId: token.tokenId,
    isCanonical: token.isCanonical,
    szDecimals: token.szDecimals,
    weiDecimals: token.weiDecimals,
    evmContract: token.evmContract?.address ?? null,
  }));

  const result: AllMarketsResult = { perps, spots, spotTokens };
  marketsCache = { data: result, timestamp: Date.now() };
  return result;
  } catch (error) {
    // If we have stale cache, return it instead of failing
    if (marketsCache) {
      console.warn("[HL] Markets fetch failed, returning stale cache");
      return marketsCache.data;
    }
    throw error; // No cache at all — let caller handle
  }
}
