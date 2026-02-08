import { randomBytes } from "crypto";
import {
  HttpTransport,
  InfoClient,
  ExchangeClient,
  WebSocketTransport,
  SubscriptionClient,
} from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { type Address } from "viem";
import {
  type MarketData,
  type PlaceOrderParams,
  type OrderConfig,
  type TimeInForce,
} from "./types";
import { isHlTestnet, onNetworkChange } from "./network";

// ============================================
// Config
// ============================================

const DEFAULT_ORDER_CONFIG: OrderConfig = {
  defaultSlippagePercent: 1,
  defaultTif: "Gtc" as TimeInForce,
};

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

/**
 * Flush all cached clients so they rebuild with the new network.
 */
function invalidateClients(): void {
  infoClient = null;
  exchangeClient = null;
  agentExchangeClients.clear();
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
    const transport = new HttpTransport({ isTestnet: isHlTestnet() });
    infoClient = new InfoClient({ transport });
  }
  return infoClient;
}

export function getExchangeClient(): ExchangeClient {
  if (!exchangeClient) {
    const pk = process.env.HYPERLIQUID_PRIVATE_KEY;
    if (!pk) throw new Error("HYPERLIQUID_PRIVATE_KEY not set");
    const wallet = privateKeyToAccount(pk as `0x${string}`);
    const transport = new HttpTransport({ isTestnet: isHlTestnet() });
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
    const wallet = privateKeyToAccount(privateKey as `0x${string}`);
    const transport = new HttpTransport({ isTestnet: isHlTestnet() });
    client = new ExchangeClient({ transport, wallet });
    agentExchangeClients.set(cacheKey, client);
  }
  return client;
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
  return await info.allMids();
}

export async function getMarketData(): Promise<MarketData[]> {
  const info = getInfoClient();
  const [mids, meta] = await Promise.all([info.allMids(), info.meta()]);

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
    info.allMids(),
    info.meta(),
    info.metaAndAssetCtxs(),
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
  return await info.l2Book({ coin, nSigFigs: 5 });
}

export async function getFundingHistory(coin: string, startTime: number) {
  const info = getInfoClient();
  return await info.fundingHistory({ coin, startTime });
}

// ============================================
// Account & Positions
// ============================================

export async function getAccountState(user: Address) {
  const info = getInfoClient();
  return await info.clearinghouseState({ user });
}

export async function getOpenOrders(user: Address) {
  const info = getInfoClient();
  return await info.openOrders({ user });
}

export async function getUserFills(user: Address) {
  const info = getInfoClient();
  return await info.userFills({ user });
}

export async function getUserFillsByTime(
  user: Address,
  startTime: number,
  endTime?: number
) {
  const info = getInfoClient();
  return await info.userFillsByTime({
    user,
    startTime,
    endTime,
  });
}

export async function getSpotState(user: Address) {
  const info = getInfoClient();
  return await info.spotClearinghouseState({ user });
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
}, exchange?: ExchangeClient) {
  const exchangeClient = exchange ?? getExchangeClient();
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
  const wallet = privateKeyToAccount(pk as `0x${string}`);

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
  return await exchangeClient.updateLeverage({
    asset,
    isCross,
    leverage,
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
}, exchange?: ExchangeClient) {
  const info = getInfoClient();
  const meta = await info.meta();
  const coin = meta.universe[params.asset]?.name;
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

  return await placeOrder({
    asset: params.asset,
    isBuy: params.isBuy,
    price,
    size: params.size,
    reduceOnly: params.reduceOnly ?? false,
    orderType: "Ioc",
    vaultAddress: params.vaultAddress,
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
}, exchange?: ExchangeClient) {
  const exchangeClient = exchange ?? getExchangeClient();
  return await exchangeClient.order({
    orders: [
      {
        a: params.asset,
        b: params.isBuy,
        p: params.price,
        s: params.size,
        r: true, // stop-loss is always reduce-only
        t: {
          trigger: {
            triggerPx: params.triggerPrice,
            isMarket: true,
            tpsl: "sl",
          },
        },
      },
    ],
    grouping: params.isTpsl ? "positionTpsl" : "na",
    ...(params.vaultAddress ? { vaultAddress: params.vaultAddress } : {}),
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
}, exchange?: ExchangeClient) {
  const exchangeClient = exchange ?? getExchangeClient();
  return await exchangeClient.order({
    orders: [
      {
        a: params.asset,
        b: params.isBuy,
        p: params.price,
        s: params.size,
        r: true,
        t: {
          trigger: {
            triggerPx: params.triggerPrice,
            isMarket: true,
            tpsl: "tp",
          },
        },
      },
    ],
    grouping: params.isTpsl ? "positionTpsl" : "na",
    ...(params.vaultAddress ? { vaultAddress: params.vaultAddress } : {}),
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

  switch (params.orderType) {
    case "market":
      return placeMarketOrder({
        asset: assetIndex,
        isBuy,
        size: params.size.toString(),
        slippagePercent: params.slippagePercent,
        reduceOnly: params.reduceOnly,
        vaultAddress: params.vaultAddress,
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
    const meta = await info.meta();
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
 * Generate a brand new Hyperliquid wallet for an agent.
 * Returns the private key and derived address.
 */
export function generateAgentWallet(): { privateKey: string; address: Address } {
  // Generate random private key (32 bytes)
  const keyBytes = randomBytes(32);
  const privateKey = "0x" + keyBytes.toString("hex");
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return { privateKey, address: account.address };
}

/**
 * Provision and fund a new HL testnet wallet for an agent.
 *
 * 1. Generate new wallet
 * 2. Store it encrypted via account-manager
 * 3. Send USDC from operator to the new wallet
 * 4. Return the wallet info
 */
export async function provisionAgentWallet(
  agentId: string,
  fundingAmountUsd: number
): Promise<{
  address: Address;
  funded: boolean;
  fundedAmount: number;
  txResult: unknown;
}> {
  // Dynamic import to avoid circular deps
  const { addAccount, getAccountForAgent } = await import("./account-manager");

  // Check if agent already has a wallet
  const existing = await getAccountForAgent(agentId);
  if (existing) {
    // Already has a wallet — just fund it
    if (fundingAmountUsd > 0) {
      try {
        const result = await sendUsdToAgent(existing.address, fundingAmountUsd);
        return {
          address: existing.address,
          funded: true,
          fundedAmount: fundingAmountUsd,
          txResult: result,
        };
      } catch (err) {
        console.error("[HL] Failed to fund existing agent wallet:", err);
        return {
          address: existing.address,
          funded: false,
          fundedAmount: 0,
          txResult: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return {
      address: existing.address,
      funded: false,
      fundedAmount: 0,
      txResult: null,
    };
  }

  // Generate new wallet
  const { privateKey, address } = generateAgentWallet();

  // Store encrypted
  await addAccount({
    alias: `agent-${agentId.slice(0, 8)}`,
    privateKey,
    agentId,
    isDefault: false,
  });

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

  return {
    address,
    funded,
    fundedAmount: funded ? fundingAmountUsd : 0,
    txResult,
  };
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
  const [perpMeta, spotMeta] = await Promise.all([
    info.meta(),
    info.spotMeta(),
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
}
