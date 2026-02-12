import {
  createWalletClient,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadMainnet } from "./chains";
import { sendUsdFromAgent } from "./hyperliquid";

export type BridgeStatus = "submitted" | "pending" | "failed";

export interface BridgeExecution {
  provider: "hyperunit" | "debridge" | "none";
  status: BridgeStatus;
  destinationAddress?: Address;
  relayTxHash?: Hex;
  bridgeOrderId?: string;
  note?: string;
  quote?: Record<string, unknown> | null;
}

interface HyperunitAddressResponse {
  address?: string;
  result?: { address?: string };
  data?: { address?: string };
}

interface HyperunitOperationAddress {
  sourceCoinType?: string;
  destinationChain?: string;
  address?: string;
}

interface HyperunitOperation {
  operationId?: string;
  sourceTxHash?: string;
  state?: string;
}

interface HyperunitOperationsResponse {
  addresses?: HyperunitOperationAddress[];
  operations?: HyperunitOperation[];
}

interface DeBridgeCreateTxResponse {
  estimation?: Record<string, unknown>;
  tx?: {
    to?: string;
    data?: string;
    value?: string;
  };
  order?: {
    orderId?: string;
    id?: string;
  };
  orderId?: string;
}

const MAINNET_BRIDGE_ENABLED = process.env.MAINNET_BRIDGE_ENABLED === "true";
const MAINNET_BRIDGE_PREFER_DEBRIDGE =
  process.env.MAINNET_BRIDGE_PREFER_DEBRIDGE === "true";

const HYPERUNIT_API_URL =
  (process.env.HYPERUNIT_API_URL || "https://api.hyperunit.xyz").replace(/\/$/, "");
const HYPERUNIT_MONAD_CHAIN =
  (process.env.HYPERUNIT_MONAD_CHAIN || "monad").toLowerCase();
const HYPERUNIT_HYPERLIQUID_CHAIN =
  (process.env.HYPERUNIT_HYPERLIQUID_CHAIN || "hyperliquid").toLowerCase();
const HYPERUNIT_DEPOSIT_ASSET =
  (process.env.HYPERUNIT_DEPOSIT_ASSET || "mon").toLowerCase();
const HYPERUNIT_WITHDRAW_ASSET =
  (process.env.HYPERUNIT_WITHDRAW_ASSET || "usdc").toLowerCase();
const HYPERUNIT_API_KEY = process.env.HYPERUNIT_API_KEY?.trim() || "";
const HYPERUNIT_BEARER_TOKEN = process.env.HYPERUNIT_BEARER_TOKEN?.trim() || "";

const DEBRIDGE_API_URL =
  (process.env.DEBRIDGE_API_URL || "https://dln.debridge.finance").replace(/\/$/, "");

function getRelayMonadPrivateKey(): `0x${string}` | null {
  const raw = process.env.RELAY_MONAD_PRIVATE_KEY || process.env.MONAD_PRIVATE_KEY;
  if (!raw || !/^0x[a-fA-F0-9]{64}$/.test(raw.trim())) return null;
  return raw.trim() as `0x${string}`;
}

function getMonadRpcUrl(): string {
  return process.env.MONAD_MAINNET_RPC_URL || monadMainnet.rpcUrls.default.http[0];
}

async function sendMonadNative(to: Address, value: bigint): Promise<Hex> {
  const relayPk = getRelayMonadPrivateKey();
  if (!relayPk) {
    throw new Error("Relay private key is missing; cannot send native MON");
  }
  const account = privateKeyToAccount(relayPk);
  const wallet = createWalletClient({
    account,
    chain: monadMainnet,
    transport: http(getMonadRpcUrl()),
  });
  return wallet.sendTransaction({
    account,
    chain: monadMainnet,
    to,
    value,
  });
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs: number = 12_000): Promise<any> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
  }

  const text = await res.text();
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function parseAddress(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  return isAddress(value) ? (value as Address) : null;
}

function pickHyperunitAddress(payload: HyperunitAddressResponse): Address | null {
  const direct = parseAddress(payload.address);
  if (direct) return direct;
  const nestedResult = parseAddress(payload.result?.address);
  if (nestedResult) return nestedResult;
  return parseAddress(payload.data?.address);
}

function getHyperunitHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (HYPERUNIT_API_KEY) headers["x-api-key"] = HYPERUNIT_API_KEY;
  if (HYPERUNIT_BEARER_TOKEN) headers.Authorization = `Bearer ${HYPERUNIT_BEARER_TOKEN}`;
  return headers;
}

function hasDebridgeConfig(): boolean {
  return Boolean(
    process.env.DEBRIDGE_MONAD_CHAIN_ID &&
      process.env.DEBRIDGE_HYPERLIQUID_CHAIN_ID &&
      process.env.DEBRIDGE_MONAD_TOKEN_IN &&
      process.env.DEBRIDGE_HYPERLIQUID_TOKEN_OUT
  );
}

function isStableRelayToken(token: Address): boolean {
  const allowlist = new Set(
    (process.env.RELAY_STABLE_TOKENS || "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
  );
  if (allowlist.size === 0) return false;
  return allowlist.has(token.toLowerCase());
}

function extractLikelyTxHash(value: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  const walk = (node: unknown): Hex | undefined => {
    if (!node || seen.has(node)) return undefined;
    if (typeof node === "string") {
      const match = node.match(/0x[a-fA-F0-9]{64}/);
      if (match) return match[0] as Hex;
      return undefined;
    }
    if (typeof node !== "object") return undefined;

    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return undefined;
    }

    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (k.toLowerCase().includes("hash") && typeof v === "string") {
        const match = v.match(/0x[a-fA-F0-9]{64}/);
        if (match) return match[0] as Hex;
      }
      const found = walk(v);
      if (found) return found;
    }
    return undefined;
  };

  return walk(value);
}

async function getHyperunitDestinationAddress(params: {
  sourceChain: string;
  destinationChain: string;
  asset: string;
  destinationAddress: Address;
}): Promise<Address> {
  const { sourceChain, destinationChain, asset, destinationAddress } = params;
  const url = `${HYPERUNIT_API_URL}/gen/${sourceChain}/${destinationChain}/${asset}/${destinationAddress}`;
  const payload = (await fetchJson(
    url,
    {
      method: "GET",
      headers: getHyperunitHeaders(),
    },
    10_000
  )) as HyperunitAddressResponse;
  const addr = pickHyperunitAddress(payload);
  if (!addr) {
    throw new Error("Hyperunit did not return a protocol address");
  }
  return addr;
}

async function getHyperunitOperations(destinationAddress: Address): Promise<HyperunitOperationsResponse> {
  const url = `${HYPERUNIT_API_URL}/operations/${destinationAddress}`;
  return (await fetchJson(
    url,
    {
      method: "GET",
      headers: getHyperunitHeaders(),
    },
    10_000
  )) as HyperunitOperationsResponse;
}

async function getKnownHyperunitProtocolAddress(
  destinationAddress: Address,
  destinationChain: string
): Promise<Address | null> {
  const payload = await getHyperunitOperations(destinationAddress);
  const targetChain = destinationChain.toLowerCase();

  for (const item of payload.addresses || []) {
    const addr = parseAddress(item.address);
    if (!addr) continue;
    const itemDstChain = (item.destinationChain || "").toLowerCase();
    if (itemDstChain === targetChain) return addr;
  }

  return null;
}

export async function resolveHyperunitWithdrawalProtocolAddress(
  monadAddress: Address
): Promise<Address> {
  try {
    return await getHyperunitDestinationAddress({
      sourceChain: HYPERUNIT_HYPERLIQUID_CHAIN,
      destinationChain: HYPERUNIT_MONAD_CHAIN,
      asset: HYPERUNIT_WITHDRAW_ASSET,
      destinationAddress: monadAddress,
    });
  } catch (error) {
    const known = await getKnownHyperunitProtocolAddress(monadAddress, HYPERUNIT_MONAD_CHAIN);
    if (known) return known;
    throw error;
  }
}

export async function resolveHyperunitDepositProtocolAddress(
  hlAddress: Address
): Promise<Address> {
  try {
    return await getHyperunitDestinationAddress({
      sourceChain: HYPERUNIT_MONAD_CHAIN,
      destinationChain: HYPERUNIT_HYPERLIQUID_CHAIN,
      asset: HYPERUNIT_DEPOSIT_ASSET,
      destinationAddress: hlAddress,
    });
  } catch (error) {
    const known = await getKnownHyperunitProtocolAddress(hlAddress, HYPERUNIT_HYPERLIQUID_CHAIN);
    if (known) return known;
    throw error;
  }
}

// MAINNET_BRIDGE_ENABLED=true but deBridge fallback envs are missing; Hyperunit-only mode will be used
// If deBridge fallback envs are present, use deBridge for deposits.

/**


async function tryResolveDebridgeProtocolAddress(params: {
  sourceChain: string;
  destinationChain: string;
  asset: string;
  destinationAddress: Address;
}): Promise<Address | null> {
  if (!hasDebridgeConfig()) {
    return null;
  }

  const query = new URLSearchParams({
    srcChainId: String(params.sourceChain),
    dstChainId: String(params.destinationChain),
    srcChainTokenIn: String(params.asset),
    dstChainTokenOut: String(params.asset),
    srcChainTokenInAmount: "0",
    srcChainOrderAuthorityAddress: params.destinationAddress,
    srcChainRefundAddress: params.destinationAddress,
    dstChainOrderAuthorityAddress: params.destinationAddress,
    dstChainRecipientAddress: params.destinationAddress,
    prependOperatingExpense: process.env.DEBRIDGE_PREPEND_OPERATING_EXPENSE || "true",
    slippage: process.env.DEBRIDGE_SLIPPAGE || "1",
  });

  if (process.env.DEBRIDGE_AFFILIATE_FEE_PERCENT) {
    query.set("affiliateFeePercent", process.env.DEBRIDGE_AFFILIATE_FEE_PERCENT);
  }

  const headers: Record<string, string> = {};
  if (process.env.DEBRIDGE_API_KEY) {
    headers["x-api-key"] = process.env.DEBRIDGE_API_KEY;
  }

  const url = `${DEBRIDGE_API_URL}/v1.0/dln/order/create-tx?${query.toString()}`;
  const resp = await fetchJson(url, { method: "GET", headers }, 12_000);
  // Type must be Address (a hex string), not an object.
  const protocolAddress = resp.tx?.to;
  if (typeof protocolAddress !== "string" || !protocolAddress.startsWith("0x")) {
    // Ensure the value returned is of type Address (`0x${string}`).
    if (typeof protocolAddress !== "string" || !protocolAddress.startsWith("0x")) {
      throw new Error("Invalid protocol address from deBridge response");
    }
    // Safely assert type for returning
    return protocolAddress as Address;
  }
} */

async function createDeBridgeOrderTx(params: {
  srcAmountRaw: string;
  senderAddress: Address;
  recipientAddress: Address;
}): Promise<DeBridgeCreateTxResponse> {
  if (!hasDebridgeConfig()) {
    throw new Error("deBridge env config is incomplete");
  }

  const query = new URLSearchParams({
    srcChainId: String(process.env.DEBRIDGE_MONAD_CHAIN_ID),
    dstChainId: String(process.env.DEBRIDGE_HYPERLIQUID_CHAIN_ID),
    srcChainTokenIn: String(process.env.DEBRIDGE_MONAD_TOKEN_IN),
    dstChainTokenOut: String(process.env.DEBRIDGE_HYPERLIQUID_TOKEN_OUT),
    srcChainTokenInAmount: params.srcAmountRaw,
    srcChainOrderAuthorityAddress: params.senderAddress,
    srcChainRefundAddress: params.senderAddress,
    dstChainOrderAuthorityAddress: params.recipientAddress,
    dstChainRecipientAddress: params.recipientAddress,
    prependOperatingExpense: process.env.DEBRIDGE_PREPEND_OPERATING_EXPENSE || "true",
    slippage: process.env.DEBRIDGE_SLIPPAGE || "1",
  });

  if (process.env.DEBRIDGE_AFFILIATE_FEE_PERCENT) {
    query.set("affiliateFeePercent", process.env.DEBRIDGE_AFFILIATE_FEE_PERCENT);
  }

  const headers: Record<string, string> = {};
  if (process.env.DEBRIDGE_API_KEY) {
    headers["x-api-key"] = process.env.DEBRIDGE_API_KEY;
  }

  const url = `${DEBRIDGE_API_URL}/v1.0/dln/order/create-tx?${query.toString()}`;
  return (await fetchJson(url, { method: "GET", headers }, 12_000)) as DeBridgeCreateTxResponse;
}

async function tryExecuteDebridge(params: {
  srcAmountRaw: string;
  senderAddress: Address;
  recipientAddress: Address;
}): Promise<BridgeExecution> {
  const resp = await createDeBridgeOrderTx(params);
  const tx = resp.tx;
  const quote = resp.estimation || null;
  const orderId = resp.order?.orderId || resp.order?.id || resp.orderId;

  if (!tx?.to || !tx?.data) {
    return {
      provider: "debridge",
      status: "pending",
      bridgeOrderId: orderId,
      note: "deBridge returned no executable tx payload",
      quote,
    };
  }

  const relayPk = getRelayMonadPrivateKey();
  if (!relayPk) {
    return {
      provider: "debridge",
      status: "pending",
      bridgeOrderId: orderId,
      note: "Relay private key is missing for deBridge execution",
      quote,
    };
  }

  const account = privateKeyToAccount(relayPk);
  const wallet = createWalletClient({
    account,
    chain: monadMainnet,
    transport: http(getMonadRpcUrl()),
  });

  const txHash = await wallet.sendTransaction({
    account,
    chain: monadMainnet,
    to: tx.to as Address,
    data: tx.data as Hex,
    value: BigInt(tx.value || "0"),
  });

  return {
    provider: "debridge",
    status: "submitted",
    destinationAddress: params.recipientAddress,
    relayTxHash: txHash,
    bridgeOrderId: orderId,
    quote,
  };
}

export function isMainnetBridgeEnabled(): boolean {
  return MAINNET_BRIDGE_ENABLED;
}

export async function bridgeDepositToHyperliquidAgent(params: {
  hlAddress: Address;
  sourceToken: Address;
  sourceAmountRaw: bigint;
  sourceAmountRawLabel: string;
}): Promise<BridgeExecution> {
  const { hlAddress, sourceToken, sourceAmountRaw, sourceAmountRawLabel } = params;

  if (!MAINNET_BRIDGE_ENABLED) {
    return {
      provider: "none",
      status: "pending",
      destinationAddress: hlAddress,
      note: "Mainnet bridge is disabled",
    };
  }

  const sourceIsNative = sourceToken.toLowerCase() === "0x0000000000000000000000000000000000000000";
  const sourceIsStableErc20 = !sourceIsNative && isStableRelayToken(sourceToken);

  const tryHyperunit = async (): Promise<BridgeExecution> => {
    let protocolAddress: Address;
    try {
      protocolAddress = await getHyperunitDestinationAddress({
        sourceChain: HYPERUNIT_MONAD_CHAIN,
        destinationChain: HYPERUNIT_HYPERLIQUID_CHAIN,
        asset: HYPERUNIT_DEPOSIT_ASSET,
        destinationAddress: hlAddress,
      });
    } catch (error) {
      const known = await getKnownHyperunitProtocolAddress(hlAddress, HYPERUNIT_HYPERLIQUID_CHAIN);
      if (!known) throw error;
      protocolAddress = known;
    }

    if (!sourceIsNative) {
      return {
        provider: "hyperunit",
        status: "pending",
        destinationAddress: protocolAddress,
        note:
          "Hyperunit relay executor currently supports MON native deposits only; ERC20 deposit queued for deBridge fallback",
      };
    }

    const relayTxHash = await sendMonadNative(protocolAddress, sourceAmountRaw);
    let operationId: string | undefined;
    let operationState: string | undefined;
    try {
      const ops = await getHyperunitOperations(hlAddress);
      const match = (ops.operations || []).find((op) =>
        typeof op.sourceTxHash === "string" &&
        op.sourceTxHash.toLowerCase().includes(relayTxHash.toLowerCase())
      );
      operationId = match?.operationId;
      operationState = match?.state;
    } catch {
      // Keep successful relay submission even if operations endpoint is unavailable.
    }
    return {
      provider: "hyperunit",
      status: "submitted",
      destinationAddress: protocolAddress,
      relayTxHash,
      bridgeOrderId: operationId,
      note: operationState ? `Hyperunit operation state: ${operationState}` : undefined,
    };
  };

  const tryDebridge = async (): Promise<BridgeExecution> => {
    if (!hasDebridgeConfig()) {
      return {
        provider: "debridge",
        status: "pending",
        destinationAddress: hlAddress,
        note: "deBridge is not configured",
      };
    }

    const relayPk = getRelayMonadPrivateKey();
    if (!relayPk) {
      return {
        provider: "debridge",
        status: "pending",
        destinationAddress: hlAddress,
        note: "Relay private key is missing",
      };
    }

    const senderAddress = privateKeyToAccount(relayPk).address;
    return await tryExecuteDebridge({
      srcAmountRaw: sourceAmountRawLabel,
      senderAddress,
      recipientAddress: hlAddress,
    });
  };

  // Stablecoin ERC20 deposits are always routed via deBridge.
  if (sourceIsStableErc20) {
    try {
      return await tryDebridge();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        provider: "debridge",
        status: "failed",
        destinationAddress: hlAddress,
        note: `deBridge stablecoin route failed: ${errMsg.slice(0, 140)}`,
      };
    }
  }

  if (MAINNET_BRIDGE_PREFER_DEBRIDGE) {
    try {
      const deb = await tryDebridge();
      if (deb.status === "submitted") return deb;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[Bridge] deBridge deposit path failed: ${errMsg.slice(0, 160)}`);
    }
  }

  try {
    const hyperunit = await tryHyperunit();
    if (hyperunit.status === "submitted") {
      if (hasDebridgeConfig()) {
        try {
          const relayPk = getRelayMonadPrivateKey();
          if (relayPk) {
            const senderAddress = privateKeyToAccount(relayPk).address;
            const quote = await createDeBridgeOrderTx({
              srcAmountRaw: sourceAmountRawLabel,
              senderAddress,
              recipientAddress: hlAddress,
            });
            hyperunit.quote = quote.estimation || null;
            hyperunit.bridgeOrderId = quote.order?.orderId || quote.order?.id || quote.orderId;
          }
        } catch {
          // Keep Hyperunit success even if deBridge quote fails.
        }
      }
      return hyperunit;
    }

    try {
      const deb = await tryDebridge();
      if (deb.status === "submitted") return deb;
      if (hyperunit.status === "pending") {
        return {
          ...hyperunit,
          quote: deb.quote || hyperunit.quote || null,
          bridgeOrderId: deb.bridgeOrderId || hyperunit.bridgeOrderId,
          note: `${hyperunit.note || "Hyperunit pending"}; ${deb.note || "deBridge pending"}`,
        };
      }
      return deb;
    } catch (fallbackErr) {
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      return {
        ...hyperunit,
        status: "failed",
        note: `${hyperunit.note || "Hyperunit failed"}; deBridge error: ${fallbackMsg.slice(0, 140)}`,
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    try {
      const deb = await tryDebridge();
      if (deb.status === "submitted") return deb;
      const status: BridgeStatus = deb.status === "failed" ? "failed" : "pending";
      const provider: BridgeExecution["provider"] =
        deb.status === "failed" ? "none" : "hyperunit";
      return {
        ...deb,
        provider,
        status,
        note: `Hyperunit error: ${msg.slice(0, 140)}; ${deb.note || "deBridge pending"}`,
      };
    } catch (debErr) {
      const debMsg = debErr instanceof Error ? debErr.message : String(debErr);
      return {
        provider: "hyperunit",
        status: "pending",
        destinationAddress: hlAddress,
        note: `Hyperunit error: ${msg.slice(0, 140)}; deBridge error: ${debMsg.slice(0, 140)}; retrying`,
      };
    }
  }
}

export async function bridgeWithdrawalToMonadUser(params: {
  agentId: string;
  userAddress: Address;
  usdAmount: number;
}): Promise<BridgeExecution> {
  const { agentId, userAddress, usdAmount } = params;

  if (!MAINNET_BRIDGE_ENABLED) {
    return {
      provider: "none",
      status: "pending",
      destinationAddress: userAddress,
      note: "Mainnet bridge is disabled",
    };
  }

  try {
    const protocolAddress = await getHyperunitDestinationAddress({
      sourceChain: HYPERUNIT_HYPERLIQUID_CHAIN,
      destinationChain: HYPERUNIT_MONAD_CHAIN,
      asset: HYPERUNIT_WITHDRAW_ASSET,
      destinationAddress: userAddress,
    });

    const result = await sendUsdFromAgent(agentId, protocolAddress, usdAmount);
    const txHash = extractLikelyTxHash(result);

    return {
      provider: "hyperunit",
      status: "submitted",
      destinationAddress: protocolAddress,
      relayTxHash: txHash,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      provider: "hyperunit",
      status: "failed",
      destinationAddress: userAddress,
      note: `Withdrawal bridge failed: ${msg.slice(0, 160)}`,
    };
  }
}
