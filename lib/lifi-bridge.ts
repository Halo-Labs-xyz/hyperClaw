/**
 * LI.FI Bridge Integration
 *
 * Bridges MON/USDC from Monad to USDC spot on Hyperliquid.
 * Uses LI.FI REST API: https://li.quest/v1
 *
 * Flow: Monad (MON/USDC) → LI.FI → Hyperliquid (USDC spot)
 *       Then use usdClassTransfer(toPerp: true) to move spot → perps margin
 *
 * @see https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer
 * @see https://li.fi/knowledge-hub/bringing-all-of-defis-liquidity-to-hyperliquid-powered-by-li-fi/
 */

const LIFI_BASE = "https://li.quest";

// Chain IDs (LI.FI uses these - verify via GET /v1/chains)
// Monad mainnet: 143, testnet: 10143
// Hyperliquid HyperEVM mainnet: 999, testnet: 998
export const LIFI_CHAINS = {
  monad: 143,
  monadTestnet: 10143,
  hyperliquid: 999,
  hyperliquidTestnet: 998,
} as const;

export interface LifiQuoteParams {
  fromChain: number;
  toChain: number;
  fromToken: string; // "MON" or token address
  toToken: string;   // "USDC" or token address
  fromAmount: string; // Amount with decimals, e.g. "1000000000000000000" for 1 MON
  fromAddress: string;
  toAddress?: string;
  slippage?: number;  // 0.005 = 0.5%
  integrator?: string;
}

export interface LifiQuoteResponse {
  id: string;
  type: "swap" | "cross" | "lifi" | "protocol";
  tool: string;
  action: {
    fromChainId: number;
    toChainId: number;
    fromToken: { address: string; symbol: string; decimals: number };
    toToken: { address: string; symbol: string; decimals: number };
    fromAmount: string;
    toAmount?: string;
    fromAddress: string;
    toAddress: string;
  };
  estimate?: {
    toAmount: string;
    toAmountMin: string;
  };
  transactionRequest?: {
    from: string;
    to: string;
    chainId: number;
    data: string;
    value?: string;
    gasPrice?: string;
    gasLimit?: string;
  };
  includedSteps?: unknown[];
}

export interface LifiStatusParams {
  txHash: string;
  bridge?: string;
  fromChain: number;
  toChain: number;
}

export type LifiStatus = "NOT_FOUND" | "PENDING" | "DONE" | "FAILED";

export interface LifiStatusResponse {
  status: LifiStatus;
  substatus?: string;
  sending?: { txHash: string; chainId: number };
  receiving?: { txHash?: string; chainId: number };
  explorerUrls?: { sending?: string; receiving?: string };
}

function getBaseUrl(): string {
  return process.env.NODE_ENV === "production" ? LIFI_BASE : LIFI_BASE;
}

/**
 * Get a LI.FI quote for Monad MON/USDC → Hyperliquid USDC spot
 */
export async function getLifiQuote(params: LifiQuoteParams): Promise<LifiQuoteResponse | null> {
  const base = getBaseUrl();
  const url = new URL(`${base}/v1/quote`);

  url.searchParams.set("fromChain", String(params.fromChain));
  url.searchParams.set("toChain", String(params.toChain));
  url.searchParams.set("fromToken", params.fromToken);
  url.searchParams.set("toToken", params.toToken);
  url.searchParams.set("fromAmount", params.fromAmount);
  url.searchParams.set("fromAddress", params.fromAddress);
  if (params.toAddress) url.searchParams.set("toAddress", params.toAddress);
  if (params.slippage != null) url.searchParams.set("slippage", String(params.slippage));
  if (params.integrator) url.searchParams.set("integrator", params.integrator);

  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
      headers: process.env.LIFI_API_KEY
        ? { "x-lifi-api-key": process.env.LIFI_API_KEY }
        : undefined,
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[LifiBridge] Quote failed:", res.status, err);
      return null;
    }

    return (await res.json()) as LifiQuoteResponse;
  } catch (error) {
    console.error("[LifiBridge] Quote error:", error);
    return null;
  }
}

/**
 * Check status of a cross-chain transfer
 */
export async function getLifiStatus(
  params: LifiStatusParams
): Promise<LifiStatusResponse | null> {
  const base = getBaseUrl();
  const url = new URL(`${base}/v1/status`);

  url.searchParams.set("txHash", params.txHash);
  url.searchParams.set("fromChain", String(params.fromChain));
  url.searchParams.set("toChain", String(params.toChain));
  if (params.bridge) url.searchParams.set("bridge", params.bridge);

  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
      headers: process.env.LIFI_API_KEY
        ? { "x-lifi-api-key": process.env.LIFI_API_KEY }
        : undefined,
    });

    if (!res.ok) return null;
    return (await res.json()) as LifiStatusResponse;
  } catch {
    return null;
  }
}

/**
 * Helper: Get quote for MON on Monad → USDC on Hyperliquid (spot)
 */
export async function getMonadToHlQuote(
  monAmountWei: string,
  fromAddress: string,
  toAddress?: string,
  useTestnet = false
): Promise<LifiQuoteResponse | null> {
  return getLifiQuote({
    fromChain: useTestnet ? LIFI_CHAINS.monadTestnet : LIFI_CHAINS.monad,
    toChain: useTestnet ? LIFI_CHAINS.hyperliquidTestnet : LIFI_CHAINS.hyperliquid,
    fromToken: "MON",
    toToken: "USDC",
    fromAmount: monAmountWei,
    fromAddress,
    toAddress: toAddress || fromAddress,
    slippage: 0.005,
    integrator: "hyperclaw",
  });
}

/**
 * Helper: Get quote for USDC on Monad → USDC on Hyperliquid
 */
export async function getUsdcMonadToHlQuote(
  usdcAmountUnits: string, // 6 decimals, e.g. "1000000" for 1 USDC
  fromAddress: string,
  toAddress?: string,
  useTestnet = false
): Promise<LifiQuoteResponse | null> {
  return getLifiQuote({
    fromChain: useTestnet ? LIFI_CHAINS.monadTestnet : LIFI_CHAINS.monad,
    toChain: useTestnet ? LIFI_CHAINS.hyperliquidTestnet : LIFI_CHAINS.hyperliquid,
    fromToken: "USDC",
    toToken: "USDC",
    fromAmount: usdcAmountUnits,
    fromAddress,
    toAddress: toAddress || fromAddress,
    slippage: 0.005,
    integrator: "hyperclaw",
  });
}
