/**
 * Deposit Relay
 *
 * No bridge on deposit (fast path like testnet). Vault keeps custody on Monad;
 * operator pre-funds HL with USDC; relay credits agent HL wallet from operator.
 *
 * Deposit flow:
 * 1. User deposits MON (or other Monad asset) into Monad vault treasury.
 * 2. Vault keeps those assets on Monad as custody/backing.
 * 3. Relay gets fair-market value (oracle/feed), then operator funds the user's
 *    HL agent wallet with equivalent USDC directly (no bridge).
 * 4. Trading happens in USDC on HL without selling user deposit assets.
 *
 * Withdrawal (bridge used only here):
 * - If user is down: vault returns value of remaining HL USDC as MON/chosen
 *   asset at fair price (no bridge; settlement on Monad).
 * - If user is up: realize value on HL (perps → spot, swap USDC → MON/asset),
 *   then withdraw to user's Monad address via HyperUnit bridge.
 */

import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  formatEther,
  formatUnits,
  toEventSelector,
  zeroAddress,
} from "viem";
import { VAULT_ABI } from "./vault";
import { getAgent, updateAgent } from "./store";
import { getAgentHlState, provisionAgentWallet } from "./hyperliquid";
import { isMonadTestnet } from "./network";
import {
  bridgeWithdrawalToMonadUser,
  isMainnetBridgeEnabled,
} from "./mainnet-bridge";
import {
  type DepositRow,
  isSupabaseStoreEnabled,
  sbGetDepositByTxHash,
  sbGetDepositsForAgent,
  sbGetDepositsForUser,
  sbGetCursor,
  sbInsertDeposit,
  sbSetCursor,
} from "./supabase-store";
import { getUserCapContext } from "./hclaw-policy";
import type { HclawPointsActivityInput } from "./hclaw-points";
import { getVaultAddressIfDeployed } from "./env";
type MonadNetwork = "mainnet" | "testnet";

// ============================================
// MON -> USDC price conversion
// ============================================

// Relay fee: percentage deducted from the converted USDC amount on mainnet
// Covers gas, bridge costs, and protocol margin. Set via env or default 1%.
const RELAY_FEE_BPS = parseInt(process.env.RELAY_FEE_BPS || "100", 10); // 100 bps = 1%

// Testnet: fixed rate (0.1 MON = $100 USDC)
const TESTNET_MON_TO_USDC = 1000;

// On mainnet, only these ERC20 tokens are treated as $1 stables for
// relay funding unless running on testnet.
const RELAY_STABLE_TOKENS = new Set(
  (process.env.RELAY_STABLE_TOKENS || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
);

const ERC20_DECIMALS_ABI = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const tokenDecimalsCache = new Map<string, number>();

// Mainnet price cache
let monPriceCache: { price: number; timestamp: number } | null = null;
const PRICE_CACHE_TTL = 30_000; // 30 seconds

const MAINNET_MON_MIN_PRICE_USD = Number.parseFloat(
  // Default must not block legitimate prices. Keep a tiny floor to filter out zeros.
  process.env.MAINNET_MON_MIN_PRICE_USD || "0.0001"
);
const MAINNET_MON_MAX_PRICE_USD = Number.parseFloat(
  process.env.MAINNET_MON_MAX_PRICE_USD || "100000"
);
const MAINNET_MON_ORACLE_FEED_MAX_DRIFT_PCT = Number.parseFloat(
  process.env.MAINNET_MON_ORACLE_FEED_MAX_DRIFT_PCT || "35"
);
const MAINNET_MON_PRICE_OVERRIDE_USD = Number.parseFloat(
  process.env.MAINNET_MON_PRICE_OVERRIDE_USD || ""
);
const MAINNET_MON_PRICE_REQUIRE_MATCH = process.env.MAINNET_MON_PRICE_REQUIRE_MATCH === "true";

/**
 * Fetch the live MON/USD price from CoinGecko or a DEX aggregator.
 * Falls back to a secondary source if primary fails.
 */
async function fetchMonPrice(): Promise<number> {
  // Return cached if fresh
  if (monPriceCache && Date.now() - monPriceCache.timestamp < PRICE_CACHE_TTL) {
    return monPriceCache.price;
  }

  // Try CoinGecko first
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.monad?.usd) {
        const price = data.monad.usd;
        monPriceCache = { price, timestamp: Date.now() };
        return price;
      }
    }
  } catch {
    // Fall through to next source
  }

  // Try DeFiLlama
  try {
    const res = await fetch(
      "https://coins.llama.fi/prices/current/coingecko:monad",
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json();
      const coin = data?.coins?.["coingecko:monad"];
      if (coin?.price) {
        const price = coin.price;
        monPriceCache = { price, timestamp: Date.now() };
        return price;
      }
    }
  } catch {
    // Fall through
  }

  // Try Monad-native price from nad.fun or on-chain oracle
  // Fallback: use last cached price or a conservative estimate
  if (monPriceCache) {
    console.warn("[PriceFeed] Using stale MON price:", monPriceCache.price);
    return monPriceCache.price;
  }

  // Ultimate fallback — reject rather than use a wrong price
  throw new Error("Unable to fetch MON price. Deposit relay paused for safety.");
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isMonPriceWithinMainnetBounds(price: number): boolean {
  if (!isFinitePositive(price)) return false;
  if (Number.isFinite(MAINNET_MON_MIN_PRICE_USD) && price < MAINNET_MON_MIN_PRICE_USD) return false;
  if (Number.isFinite(MAINNET_MON_MAX_PRICE_USD) && price > MAINNET_MON_MAX_PRICE_USD) return false;
  return true;
}

function calculatePctDrift(a: number, b: number): number {
  const base = Math.max(Math.abs(a), Math.abs(b), Number.EPSILON);
  return (Math.abs(a - b) / base) * 100;
}

/**
 * Convert MON amount (in wei) to USDC value, applying network-specific logic.
 *
 * Testnet: Fixed rate (1 MON = $1000 USDC)
 * Mainnet: Vault oracle price when available, otherwise external feed, minus relay fee
 */
async function monToUsdc(
  amountWei: bigint,
  network?: MonadNetwork,
  client = getMonadClient(network),
  vaultAddress?: Address
): Promise<{ usdValue: number; rate: number; fee: number }> {
  const monAmount = parseFloat(formatEther(amountWei));
  const useTestnet = network ? network === "testnet" : isMonadTestnet();

  if (useTestnet) {
    const usdValue = monAmount * TESTNET_MON_TO_USDC;
    return { usdValue, rate: TESTNET_MON_TO_USDC, fee: 0 };
  }

  // Mainnet: explicit override > reconciled oracle/feed.
  const overridePrice = isFinitePositive(MAINNET_MON_PRICE_OVERRIDE_USD)
    ? MAINNET_MON_PRICE_OVERRIDE_USD
    : null;

  if (overridePrice !== null) {
    if (!isMonPriceWithinMainnetBounds(overridePrice)) {
      throw new Error(
        `MAINNET_MON_PRICE_OVERRIDE_USD=${overridePrice} is outside bounds ` +
          `[${MAINNET_MON_MIN_PRICE_USD}, ${MAINNET_MON_MAX_PRICE_USD}]`
      );
    }
    const grossUsdc = monAmount * overridePrice;
    const fee = grossUsdc * (RELAY_FEE_BPS / 10000);
    const usdValue = grossUsdc - fee;
    return { usdValue: Math.max(0, usdValue), rate: overridePrice, fee };
  }

  // Mainnet: reconcile on-chain oracle with external feed to avoid bad $1 pricing.
  const oracleCandidate = await getVaultOracleTokenPriceUsd(zeroAddress, client, vaultAddress);
  let feedCandidate: number | null = null;
  try {
    feedCandidate = await fetchMonPrice();
  } catch (err) {
    // Do not hard-fail deposits when the on-chain oracle is available.
    // External feeds can be flaky/rate-limited in production environments.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[PriceFeed] External MON price fetch failed: ${msg.slice(0, 160)}`);
    feedCandidate = null;
  }
  const oraclePrice = isFinitePositive(oracleCandidate ?? NaN) ? Number(oracleCandidate) : null;
  const feedPrice = isFinitePositive(feedCandidate ?? NaN) ? Number(feedCandidate) : null;

  // Apply bounds per-candidate so a single bad source doesn't block deposits.
  const oracleBounded =
    oraclePrice !== null && isMonPriceWithinMainnetBounds(oraclePrice) ? oraclePrice : null;
  const feedBounded =
    feedPrice !== null && isMonPriceWithinMainnetBounds(feedPrice) ? feedPrice : null;

  let monPrice: number | null = null;

  if (oracleBounded !== null && feedBounded !== null) {
    const driftPct = calculatePctDrift(oracleBounded, feedBounded);
    if (
      Number.isFinite(MAINNET_MON_ORACLE_FEED_MAX_DRIFT_PCT) &&
      driftPct > MAINNET_MON_ORACLE_FEED_MAX_DRIFT_PCT
    ) {
      const msg = `MON price mismatch (oracle=${oracleBounded}, feed=${feedBounded}, drift=${driftPct.toFixed(2)}%)`;
      if (MAINNET_MON_PRICE_REQUIRE_MATCH) {
        throw new Error(msg);
      }
      console.warn(`[PriceFeed] ${msg}. Continuing with vault oracle price.`);
    }
    // Prefer the vault oracle when the two sources are consistent.
    monPrice = oracleBounded;
  } else {
    monPrice = oracleBounded ?? feedBounded;
  }

  if (monPrice === null) {
    throw new Error(
      `Invalid mainnet MON price (oracle=${oraclePrice ?? "n/a"}, feed=${feedPrice ?? "n/a"}) ` +
        `outside bounds [${MAINNET_MON_MIN_PRICE_USD}, ${MAINNET_MON_MAX_PRICE_USD}]`
    );
  }

  const grossUsdc = monAmount * monPrice;
  const fee = grossUsdc * (RELAY_FEE_BPS / 10000);
  const usdValue = grossUsdc - fee;

  return { usdValue: Math.max(0, usdValue), rate: monPrice, fee };
}

async function getTokenDecimals(token: Address, client = getMonadClient()): Promise<number> {
  const key = token.toLowerCase();
  const cached = tokenDecimalsCache.get(key);
  if (cached !== undefined) return cached;

  const decimals = (await client.readContract({
    address: token,
    abi: ERC20_DECIMALS_ABI,
    functionName: "decimals",
  })) as number;

  tokenDecimalsCache.set(key, decimals);
  return decimals;
}

function normalizeUsd(usd: number): number {
  // Keep up to 6 decimals so funding + persisted ledger stay deterministic.
  return parseFloat(usd.toFixed(6));
}

const vaultOraclePriceCache = new Map<string, { price: number; updatedAtSec: number; cachedAtMs: number }>();
const VAULT_ORACLE_CACHE_TTL_MS = 20_000;

async function getVaultOracleTokenPriceUsd(
  token: Address,
  client = getMonadClient(),
  vaultAddress?: Address
): Promise<number | null> {
  if (!vaultAddress) return null;

  const key = `${vaultAddress.toLowerCase()}:${token.toLowerCase()}`;
  const cached = vaultOraclePriceCache.get(key);
  if (cached && Date.now() - cached.cachedAtMs < VAULT_ORACLE_CACHE_TTL_MS) {
    return cached.price;
  }

  try {
    const [rawPrice, maxPriceAgeRaw] = await Promise.all([
      client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "tokenPrices",
        args: [token],
      }) as Promise<[bigint, bigint]>,
      client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "maxPriceAge",
      }) as Promise<bigint>,
    ]);

    const usdPriceE18 = rawPrice[0];
    const updatedAtSec = Number(rawPrice[1]);
    const maxPriceAgeSec = Number(maxPriceAgeRaw);
    if (!Number.isFinite(updatedAtSec) || !Number.isFinite(maxPriceAgeSec)) return null;
    if (usdPriceE18 <= BigInt(0) || updatedAtSec <= 0) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (maxPriceAgeSec > 0 && nowSec - updatedAtSec > maxPriceAgeSec) {
      return null;
    }

    const price = Number(formatUnits(usdPriceE18, 18));
    if (!Number.isFinite(price) || price <= 0) return null;

    vaultOraclePriceCache.set(key, { price, updatedAtSec, cachedAtMs: Date.now() });
    return price;
  } catch {
    return null;
  }
}

async function erc20ToUsdc(
  token: Address,
  amount: bigint,
  client = getMonadClient(),
  network?: MonadNetwork,
  vaultAddress?: Address
): Promise<{ usdValue: number; rate: number; fee: number }> {
  const lower = token.toLowerCase();
  const useTestnet = network ? network === "testnet" : isMonadTestnet();
  const decimals = await getTokenDecimals(token, client);
  const tokenAmount = parseFloat(formatUnits(amount, decimals));
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
    return { usdValue: 0, rate: 0, fee: 0 };
  }

  if (RELAY_STABLE_TOKENS.has(lower)) {
    return { usdValue: normalizeUsd(tokenAmount), rate: 1, fee: 0 };
  }

  const oraclePrice = await getVaultOracleTokenPriceUsd(token, client, vaultAddress);
  if (oraclePrice && oraclePrice > 0) {
    return {
      usdValue: normalizeUsd(tokenAmount * oraclePrice),
      rate: oraclePrice,
      fee: 0,
    };
  }

  if (useTestnet) {
    // Testnet fallback keeps local testing unblocked when no oracle price is set.
    return { usdValue: normalizeUsd(tokenAmount), rate: 1, fee: 0 };
  }

  throw new Error(
    `ERC20 token ${token} requires a vault oracle price or RELAY_STABLE_TOKENS allowlist entry`
  );
}

async function tokenAmountToUsdc(
  token: Address,
  amount: bigint,
  client = getMonadClient(),
  network?: MonadNetwork,
  vaultAddress?: Address
): Promise<{ usdValue: number; rate: number; fee: number }> {
  if (token.toLowerCase() === zeroAddress) {
    const mon = await monToUsdc(amount, network, client, vaultAddress);
    return { ...mon, usdValue: normalizeUsd(mon.usdValue) };
  }
  return erc20ToUsdc(token, amount, client, network, vaultAddress);
}

// ============================================
// Monad chain config
// ============================================

function getMonadRpcUrl(network?: MonadNetwork): string {
  const mainnetRpc =
    process.env.MONAD_MAINNET_RPC_URL ||
    process.env.NEXT_PUBLIC_MONAD_MAINNET_RPC_URL ||
    "https://rpc.monad.xyz";
  const testnetRpc =
    process.env.MONAD_TESTNET_RPC_URL ||
    process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL ||
    "https://testnet-rpc.monad.xyz";
  if (network) {
    return network === "testnet" ? testnetRpc : mainnetRpc;
  }
  return isMonadTestnet() ? testnetRpc : mainnetRpc;
}

function getVaultAddress(network?: MonadNetwork): Address | undefined {
  const selectedNetwork = network ?? (isMonadTestnet() ? "testnet" : "mainnet");
  const resolvedForNetwork = getVaultAddressIfDeployed(selectedNetwork);

  const mainnetCandidates = [
    process.env.MONAD_MAINNET_VAULT_ADDRESS,
    process.env.NEXT_PUBLIC_MONAD_MAINNET_VAULT_ADDRESS,
    process.env.NEXT_PUBLIC_VAULT_ADDRESS_MAINNET,
  ];
  const testnetCandidates = [
    process.env.MONAD_TESTNET_VAULT_ADDRESS,
    process.env.NEXT_PUBLIC_MONAD_TESTNET_VAULT_ADDRESS,
    process.env.NEXT_PUBLIC_VAULT_ADDRESS_TESTNET,
  ];

  const preferred =
    selectedNetwork === "mainnet"
      ? [resolvedForNetwork, ...mainnetCandidates]
      : [resolvedForNetwork, ...testnetCandidates];
  const fallback = process.env.NEXT_PUBLIC_VAULT_ADDRESS;
  const alternates = selectedNetwork === "mainnet" ? testnetCandidates : mainnetCandidates;
  const seen = new Set<string>();
  const candidates = [...preferred, ...alternates, fallback]
    .filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && /^0x[a-fA-F0-9]{40}$/.test(candidate.trim())
    )
    .map((candidate) => candidate.trim())
    .filter((candidate) => {
      const key = candidate.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }) as Address[];

  return candidates[0];
}

function getVaultAddressCandidates(network?: MonadNetwork): Address[] {
  const selectedNetwork = network ?? (isMonadTestnet() ? "testnet" : "mainnet");
  const resolvedForNetwork = getVaultAddressIfDeployed(selectedNetwork);

  const mainnetCandidates = [
    process.env.MONAD_MAINNET_VAULT_ADDRESS,
    process.env.NEXT_PUBLIC_MONAD_MAINNET_VAULT_ADDRESS,
    process.env.NEXT_PUBLIC_VAULT_ADDRESS_MAINNET,
  ];
  const testnetCandidates = [
    process.env.MONAD_TESTNET_VAULT_ADDRESS,
    process.env.NEXT_PUBLIC_MONAD_TESTNET_VAULT_ADDRESS,
    process.env.NEXT_PUBLIC_VAULT_ADDRESS_TESTNET,
  ];
  const preferred =
    selectedNetwork === "mainnet"
      ? [resolvedForNetwork, ...mainnetCandidates]
      : [resolvedForNetwork, ...testnetCandidates];
  const alternates = selectedNetwork === "mainnet" ? testnetCandidates : mainnetCandidates;
  const fallback = process.env.NEXT_PUBLIC_VAULT_ADDRESS;

  const seen = new Set<string>();
  return [...preferred, ...alternates, fallback]
    .filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && /^0x[a-fA-F0-9]{40}$/.test(candidate.trim())
    )
    .map((candidate) => candidate.trim() as Address)
    .filter((candidate) => {
      const key = candidate.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getMonadChain(network?: MonadNetwork) {
  const testnet = network ? network === "testnet" : isMonadTestnet();
  return {
    id: testnet ? 10143 : 143,
    name: testnet ? "Monad Testnet" : "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: {
      default: { http: [getMonadRpcUrl(network)] },
    },
  } as const;
}

function getMonadClient(network?: MonadNetwork) {
  const chain = getMonadChain(network);
  return createPublicClient({
    chain,
    transport: http(chain.rpcUrls.default.http[0]),
  });
}

// ============================================
// Deposit tracking (in-memory + file sync)
// ============================================

interface DepositRecord {
  txHash: string;
  blockNumber: string;
  agentId: string;
  user: Address;
  token: Address;
  amount: string;
  shares: string;
  usdValue: number;
  monRate: number;
  relayFee: number;
  timestamp: number;
  relayed: boolean;
  hlWalletAddress?: string;
  hlFunded?: boolean;
  hlFundedAmount?: number;
  bridgeProvider?: "hyperunit" | "debridge" | "none";
  bridgeStatus?: "submitted" | "pending" | "failed";
  bridgeDestination?: Address;
  bridgeTxHash?: string;
  bridgeOrderId?: string;
  bridgeNote?: string;
  lockTier?: number;
  boostBps?: number;
  rebateBps?: number;
  userCapUsd?: number;
  userCapRemainingUsd?: number;
  pointsActivity?: HclawPointsActivityInput;
}

interface WithdrawalRecord {
  txHash: string;
  blockNumber: string;
  agentId: string;
  user: Address;
  shares: string;
  monAmount: string;
  timestamp: number;
  relayed: boolean;
  settlementUsd?: number;
  vaultUsdValue?: number;
  hlAccountValueUsd?: number;
  sharePercent?: number;
  pnlUsd?: number;
  pnlStatus?: "profit" | "loss" | "flat";
  settlementMode?: "hl_share_equity" | "vault_value_fallback";
  bridgeProvider?: "hyperunit" | "debridge" | "none";
  bridgeStatus?: "submitted" | "pending" | "failed";
  bridgeDestination?: Address;
  bridgeTxHash?: string;
  bridgeOrderId?: string;
  bridgeNote?: string;
}

type VaultTxRecord =
  | { eventType: "deposit"; deposit: DepositRecord }
  | { eventType: "withdrawal"; withdrawal: WithdrawalRecord };

// In-memory deposit ledger (persisted via store on important events)
const depositLedger: DepositRecord[] = [];
const processedVaultTxs = new Set<string>();
let lastProcessedBlock: bigint = BigInt(0);

function toDepositRow(record: DepositRecord): DepositRow {
  return {
    tx_hash: record.txHash,
    block_number: record.blockNumber,
    agent_id: record.agentId,
    user_address: record.user.toLowerCase(),
    token_address: record.token.toLowerCase(),
    amount: record.amount,
    shares: record.shares,
    usd_value: record.usdValue,
    mon_rate: record.monRate,
    relay_fee: record.relayFee,
    timestamp: record.timestamp,
    relayed: record.relayed,
    hl_wallet_address: record.hlWalletAddress ?? null,
    hl_funded: record.hlFunded ?? null,
    hl_funded_amount: record.hlFundedAmount ?? null,
  };
}

function fromDepositRow(row: DepositRow): DepositRecord {
  return {
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    agentId: row.agent_id,
    user: row.user_address as Address,
    token: row.token_address as Address,
    amount: row.amount,
    shares: row.shares,
    usdValue: row.usd_value,
    monRate: row.mon_rate,
    relayFee: row.relay_fee,
    timestamp: row.timestamp,
    relayed: row.relayed,
    hlWalletAddress: row.hl_wallet_address ?? undefined,
    hlFunded: row.hl_funded ?? undefined,
    hlFundedAmount: row.hl_funded_amount ?? undefined,
  };
}

function upsertLocalDeposit(record: DepositRecord): void {
  const idx = depositLedger.findIndex((d) => d.txHash === record.txHash);
  if (idx >= 0) {
    depositLedger[idx] = record;
  } else {
    depositLedger.push(record);
  }
}

export function toPointsActivityFromDeposit(record: DepositRecord): HclawPointsActivityInput {
  return {
    userAddress: record.user.toLowerCase(),
    lockPower: record.boostBps ? record.usdValue * (record.boostBps / 10_000) : 0,
    lpVolumeUsd: record.usdValue,
    referralVolumeUsd: 0,
    questCount: 0,
    heldMs: 24 * 60 * 60 * 1000,
    selfTradeVolumeUsd: 0,
    sybilScore: 0,
  };
}

function vaultTxCursorKey(txHash: string): string {
  return `vault_tx:${txHash.toLowerCase()}`;
}

async function hasProcessedVaultTx(txHash: string): Promise<boolean> {
  const normalized = txHash.toLowerCase();
  if (processedVaultTxs.has(normalized)) return true;

  if (isSupabaseStoreEnabled()) {
    const cursor = await sbGetCursor(vaultTxCursorKey(normalized));
    if (cursor) {
      processedVaultTxs.add(normalized);
      return true;
    }

    const existing = await sbGetDepositByTxHash(txHash);
    // If funding failed, allow retrigger from the frontend with the same tx.
    if (existing && existing.hl_funded !== false) {
      processedVaultTxs.add(normalized);
      return true;
    }
    return false;
  }
  return depositLedger.some((d) => d.txHash.toLowerCase() === normalized);
}

async function markVaultTxProcessed(txHash: string): Promise<void> {
  const normalized = txHash.toLowerCase();
  processedVaultTxs.add(normalized);
  if (isSupabaseStoreEnabled()) {
    await sbSetCursor(vaultTxCursorKey(normalized), "1");
  }
}

function bytes32ToAgentId(agentIdBytes: Hex): string {
  const hex = agentIdBytes.replace(/^0x/, "").toLowerCase();
  const trimmed = hex.replace(/^0+/, "");
  if (!trimmed) return "0000000000000000";
  if (trimmed.length <= 16) return trimmed.padStart(16, "0");
  return trimmed;
}

// ============================================
// Event parsing
// ============================================

const DEPOSITED_EVENT = parseAbiItem(
  "event Deposited(bytes32 indexed agentId, address indexed user, address token, uint256 amount, uint256 shares)"
);
const DEPOSITED_TOPIC = toEventSelector(DEPOSITED_EVENT);

/** Reserved for future Withdrawn event parsing. */
export const WITHDRAWN_EVENT = parseAbiItem(
  "event Withdrawn(bytes32 indexed agentId, address indexed user, uint256 shares, uint256 monAmount)"
);
const WITHDRAWN_TOPIC = toEventSelector(WITHDRAWN_EVENT);
const WITHDRAWAL_ASSET_EVENT = parseAbiItem(
  "event WithdrawalAsset(bytes32 indexed agentId, address indexed user, address token, uint256 amount)"
);
const WITHDRAWAL_ASSET_TOPIC = toEventSelector(WITHDRAWAL_ASSET_EVENT);

// ============================================
// Process a confirmed deposit transaction
// ============================================

/**
 * Called after a user's Monad vault tx is confirmed.
 * Parses Deposited/Withdrawn events, updates relay ledger, and reconciles agent TVL.
 */
export async function processVaultTx(
  txHash: string,
  options?: { network?: MonadNetwork }
): Promise<VaultTxRecord | null> {
  const alreadyProcessed = await hasProcessedVaultTx(txHash);
  if (alreadyProcessed) {
    if (isSupabaseStoreEnabled()) {
      const row = await sbGetDepositByTxHash(txHash);
      if (row) return { eventType: "deposit", deposit: fromDepositRow(row) };
    } else {
      const existing = depositLedger.find((d) => d.txHash === txHash);
      if (existing) return { eventType: "deposit", deposit: existing };
    }
    // No persisted deposit record found; continue and parse receipt so
    // callers can still get withdrawal confirmation details.
  }

  try {
    const preferred = options?.network;
    const networks: MonadNetwork[] = preferred
      ? [preferred, preferred === "testnet" ? "mainnet" : "testnet"]
      : [isMonadTestnet() ? "testnet" : "mainnet", isMonadTestnet() ? "mainnet" : "testnet"];

    let activeNetwork: MonadNetwork | null = null;
    let receipt: any = null;

    for (const network of networks) {
      const candidateClient = getMonadClient(network);
      try {
        const candidateReceipt = await candidateClient.getTransactionReceipt({
          hash: txHash as `0x${string}`,
        });
        if (candidateReceipt?.status === "success") {
          activeNetwork = network;
          receipt = candidateReceipt;
          break;
        }
      } catch {
        // Keep trying alternate network.
      }
    }

    if (!receipt || receipt.status !== "success") {
      return null;
    }
    const client = getMonadClient(activeNetwork ?? undefined);
    const configuredVaultAddresses = new Set(
      getVaultAddressCandidates(activeNetwork ?? options?.network).map((addr) => addr.toLowerCase())
    );
    let warnedOnUnconfiguredVault = false;

    for (const log of receipt.logs) {
      try {
        const topic0 = log.topics[0];
        if (!topic0 || !log.data || log.topics.length < 3) continue;
        if (topic0 !== DEPOSITED_TOPIC && topic0 !== WITHDRAWN_TOPIC) continue;

        const eventVaultAddress = log.address as Address;
        const isConfiguredVault =
          configuredVaultAddresses.size === 0 ||
          configuredVaultAddresses.has(eventVaultAddress.toLowerCase());

        if (!isConfiguredVault && !warnedOnUnconfiguredVault) {
          warnedOnUnconfiguredVault = true;
          console.warn(
            `[DepositRelay] Vault event in tx ${txHash} came from ${eventVaultAddress},` +
              " which is not in configured vault addresses. Parsing event anyway."
          );
        }

        if (topic0 === DEPOSITED_TOPIC) {
          const agentIdBytes = log.topics[1] as Hex;
          const userAddress = ("0x" + (log.topics[2] || "").slice(26)) as Address;
          const data = log.data.slice(2);
          if (data.length < 192) continue;

          const tokenAddress = ("0x" + data.slice(24, 64)) as Address;
          const amount = BigInt("0x" + data.slice(64, 128));
          const shares = BigInt("0x" + data.slice(128, 192));
          const agentIdHex = bytes32ToAgentId(agentIdBytes);

          const conversion = await tokenAmountToUsdc(
            tokenAddress,
            amount,
            client,
            activeNetwork ?? undefined,
            eventVaultAddress
          );
          const usdValue = conversion.usdValue;
          const amountLabel =
            tokenAddress.toLowerCase() === zeroAddress
              ? `${parseFloat(formatEther(amount))} MON`
              : `${parseFloat(formatUnits(amount, await getTokenDecimals(tokenAddress, client)))} ${tokenAddress.slice(0, 6)}...`;

          console.log(
            `[DepositRelay] ${amountLabel} -> $${usdValue.toFixed(2)} USDC` +
              ` (rate=${conversion.rate}, fee=$${conversion.fee.toFixed(2)})`
          );

          const agent = await getAgent(agentIdHex);
          const priorUserDeposits = await getDepositsForUser(userAddress);
          const isNewDepositor = !priorUserDeposits.some((d) => d.agentId === agentIdHex);
          let capContext:
            | {
                tier: number;
                boostBps: number;
                rebateBps: number;
                boostedCapUsd: number;
                capRemainingUsd: number;
              }
            | undefined;
          try {
            capContext = await getUserCapContext(
              userAddress,
              agentIdHex,
              activeNetwork ?? undefined
            );
          } catch {
            capContext = undefined;
          }

          const record: DepositRecord = {
            txHash,
            blockNumber: receipt.blockNumber.toString(),
            agentId: agentIdHex,
            user: userAddress,
            token: tokenAddress,
            amount: amount.toString(),
            shares: shares.toString(),
            usdValue,
            monRate: conversion.rate,
            relayFee: conversion.fee,
            timestamp: Date.now(),
            relayed: false,
            lockTier: capContext?.tier,
            boostBps: capContext?.boostBps,
            rebateBps: capContext?.rebateBps,
            userCapUsd: capContext?.boostedCapUsd,
            userCapRemainingUsd: capContext?.capRemainingUsd,
          };
          record.pointsActivity = toPointsActivityFromDeposit(record);

          if (alreadyProcessed) {
            return { eventType: "deposit", deposit: record };
          }

          let shouldRetryFunding = false;

          if (!agent) {
            console.error(
              `[DepositRelay] Unknown agent ${agentIdHex} in deposit tx ${txHash} — skipping HL funding`
            );
            record.hlFunded = false;
          } else if (usdValue > 0) {
            try {
              console.log(
                `[DepositRelay] Operator funding for agent ${agentIdHex} with $${usdValue.toFixed(2)} USDC`
              );
              const hlResult = await provisionAgentWallet(agentIdHex, usdValue);
              record.hlWalletAddress = hlResult.address;
              record.hlFunded = hlResult.funded;
              record.hlFundedAmount = hlResult.fundedAmount;
              record.relayed = !!hlResult.funded;
              // No bridge on deposit: operator HL wallet funds agent directly for fast deposits.
              record.bridgeProvider = "none";
              record.bridgeStatus = undefined;
              record.bridgeDestination = undefined;
              record.bridgeTxHash = undefined;
              record.bridgeOrderId = undefined;
              record.bridgeNote =
                "No bridge on deposit; funded directly from pre-funded operator HL USDC.";

              console.log(
                `[DepositRelay] HL wallet ${hlResult.address} funded=${hlResult.funded} amount=$${hlResult.fundedAmount}`
              );

              if (agent.hlAddress !== hlResult.address) {
                await updateAgent(agentIdHex, { hlAddress: hlResult.address });
                console.log(`[DepositRelay] Updated agent hlAddress to ${hlResult.address}`);
              }

              shouldRetryFunding = !hlResult.funded;
            } catch (hlErr) {
              const hlMsg = hlErr instanceof Error ? hlErr.message : String(hlErr);
              shouldRetryFunding = true;
              if (hlMsg.toLowerCase().includes("timeout")) {
                console.warn(
                  `[DepositRelay] HL funding timeout for ${agentIdHex} — same tx can be retried`
                );
              } else {
                console.error(
                  `[DepositRelay] HL wallet provision/fund failed: ${hlMsg.slice(0, 150)}`
                );
              }
              record.hlFunded = false;
              record.relayed = false;
            }
          }

          upsertLocalDeposit(record);
          if (isSupabaseStoreEnabled()) {
            await sbInsertDeposit(toDepositRow(record));
          }

          if (agent) {
            const tvlUsd = await getVaultTvlOnChain(agentIdHex, activeNetwork ?? undefined);
            await updateAgent(agentIdHex, {
              vaultTvlUsd: tvlUsd,
              depositorCount: agent.depositorCount + (isNewDepositor ? 1 : 0),
            });
          }

          if (!shouldRetryFunding) {
            await markVaultTxProcessed(txHash);
          }

          return { eventType: "deposit", deposit: record };
        }

        if (topic0 === WITHDRAWN_TOPIC) {
          const agentIdBytes = log.topics[1] as Hex;
          const userAddress = ("0x" + (log.topics[2] || "").slice(26)) as Address;
          const data = log.data.slice(2);
          if (data.length < 128) continue;

          const shares = BigInt("0x" + data.slice(0, 64));
          const monAmount = BigInt("0x" + data.slice(64, 128));
          const agentIdHex = bytes32ToAgentId(agentIdBytes);

          const withdrawal: WithdrawalRecord = {
            txHash,
            blockNumber: receipt.blockNumber.toString(),
            agentId: agentIdHex,
            user: userAddress,
            shares: shares.toString(),
            monAmount: monAmount.toString(),
            timestamp: Date.now(),
            relayed: false,
          };

          if (alreadyProcessed) {
            return { eventType: "withdrawal", withdrawal };
          }

          let shouldRetryWithdrawalRelay = false;
          const agentIdBytesForRead = ("0x" + agentIdHex.padStart(64, "0")) as `0x${string}`;
          let postTotalShares: bigint | null = null;

          try {
            postTotalShares = (await client.readContract({
              address: eventVaultAddress,
              abi: VAULT_ABI,
              functionName: "totalShares",
              args: [agentIdBytesForRead],
            })) as bigint;
          } catch {
            postTotalShares = null;
          }

          const agent = await getAgent(agentIdHex);
          if (agent) {
            const tvlUsd = await getVaultTvlOnChain(agentIdHex, activeNetwork ?? undefined);
            let depositorCount = agent.depositorCount;

            try {
              const remainingShares = (await client.readContract({
                address: eventVaultAddress,
                abi: VAULT_ABI,
                functionName: "userShares",
                args: [agentIdBytesForRead, userAddress],
              })) as bigint;
              if (remainingShares === BigInt(0) && depositorCount > 0) {
                depositorCount -= 1;
              }
            } catch {
              // Keep current count if user share read fails.
            }

            await updateAgent(agentIdHex, {
              vaultTvlUsd: tvlUsd,
              depositorCount,
            });
          }

          const isMainnet = (activeNetwork ?? (isMonadTestnet() ? "testnet" : "mainnet")) === "mainnet";
          const shareFraction = (() => {
            if (shares <= BigInt(0)) return 0;
            if (postTotalShares === null) return 0;
            const totalBefore = postTotalShares + shares;
            if (totalBefore <= BigInt(0)) return 0;
            const scaled = (shares * BigInt(1_000_000)) / totalBefore;
            return Number(scaled) / 1_000_000;
          })();
          withdrawal.sharePercent = parseFloat((shareFraction * 100).toFixed(4));

          let vaultUsdValue = 0;
          try {
            const monConversion = await tokenAmountToUsdc(
              zeroAddress,
              monAmount,
              client,
              activeNetwork ?? undefined,
              eventVaultAddress
            );
            vaultUsdValue += monConversion.usdValue;

            for (const receiptLog of receipt.logs) {
              const receiptTopics = receiptLog.topics as string[] | undefined;
              const receiptTopic0 = receiptTopics?.[0];
              if (receiptTopic0 !== WITHDRAWAL_ASSET_TOPIC) continue;
              if (!receiptLog.data || !receiptTopics || receiptTopics.length < 3) continue;
              if ((receiptTopics[1] || "").toLowerCase() !== agentIdBytes.toLowerCase()) continue;
              const indexedUser = ("0x" + (receiptTopics[2] || "").slice(26)).toLowerCase();
              if (indexedUser !== userAddress.toLowerCase()) continue;

              const raw = receiptLog.data.slice(2);
              if (raw.length < 128) continue;
              const token = ("0x" + raw.slice(24, 64)) as Address;
              const tokenAmount = BigInt("0x" + raw.slice(64, 128));
              if (tokenAmount <= BigInt(0)) continue;
              const tokenConversion = await tokenAmountToUsdc(
                token,
                tokenAmount,
                client,
                activeNetwork ?? undefined,
                eventVaultAddress
              );
              vaultUsdValue += tokenConversion.usdValue;
            }
          } catch (vaultValErr) {
            const msg = vaultValErr instanceof Error ? vaultValErr.message : String(vaultValErr);
            console.warn(`[DepositRelay] Withdrawal vault USD valuation failed: ${msg.slice(0, 140)}`);
          }
          withdrawal.vaultUsdValue = normalizeUsd(Math.max(0, vaultUsdValue));

          let settlementUsd = withdrawal.vaultUsdValue;
          withdrawal.settlementMode = "vault_value_fallback";
          if (shareFraction > 0) {
            try {
              const hlState = await getAgentHlState(agentIdHex);
              const hlAccountValueUsd = parseFloat(hlState?.accountValue || "0");
              if (Number.isFinite(hlAccountValueUsd) && hlAccountValueUsd >= 0) {
                withdrawal.hlAccountValueUsd = normalizeUsd(hlAccountValueUsd);
                settlementUsd = normalizeUsd(hlAccountValueUsd * shareFraction);
                withdrawal.settlementMode = "hl_share_equity";
              }
            } catch (hlStateErr) {
              const msg = hlStateErr instanceof Error ? hlStateErr.message : String(hlStateErr);
              console.warn(`[DepositRelay] Withdrawal HL state valuation failed: ${msg.slice(0, 140)}`);
            }
          }
          settlementUsd = normalizeUsd(Math.max(0, settlementUsd));
          withdrawal.settlementUsd = settlementUsd;

          const pnlUsd = normalizeUsd(settlementUsd - (withdrawal.vaultUsdValue || 0));
          withdrawal.pnlUsd = pnlUsd;
          withdrawal.pnlStatus = pnlUsd > 0.01 ? "profit" : pnlUsd < -0.01 ? "loss" : "flat";

          if (isMainnet && isMainnetBridgeEnabled() && settlementUsd > 0) {
            try {
              const bridge = await bridgeWithdrawalToMonadUser({
                agentId: agentIdHex,
                userAddress,
                usdAmount: settlementUsd,
              });

              withdrawal.bridgeProvider = bridge.provider;
              withdrawal.bridgeStatus = bridge.status;
              withdrawal.bridgeDestination = bridge.destinationAddress;
              withdrawal.bridgeTxHash = bridge.relayTxHash;
              withdrawal.bridgeOrderId = bridge.bridgeOrderId;
              withdrawal.bridgeNote = bridge.note;
              withdrawal.relayed = bridge.status === "submitted";

              if (bridge.status !== "submitted") {
                shouldRetryWithdrawalRelay = true;
              }

              console.log(
                `[DepositRelay] Withdrawal bridge provider=${bridge.provider} status=${bridge.status}` +
                  ` settlement=$${settlementUsd.toFixed(2)}` +
                  (bridge.relayTxHash ? ` tx=${bridge.relayTxHash}` : "") +
                  (bridge.note ? ` note=${bridge.note}` : "")
              );
            } catch (withdrawBridgeErr) {
              const msg =
                withdrawBridgeErr instanceof Error
                  ? withdrawBridgeErr.message
                  : String(withdrawBridgeErr);
              shouldRetryWithdrawalRelay = true;
              withdrawal.bridgeProvider = "none";
              withdrawal.bridgeStatus = "failed";
              withdrawal.bridgeNote = msg.slice(0, 180);
              withdrawal.relayed = false;
              console.error(`[DepositRelay] Withdrawal bridge failed: ${msg.slice(0, 180)}`);
            }
          } else {
            // Testnet and non-bridge paths do not need an outbound HL transfer.
            withdrawal.relayed = true;
          }

          if (!shouldRetryWithdrawalRelay) {
            await markVaultTxProcessed(txHash);
          }
          return { eventType: "withdrawal", withdrawal };
        }
      } catch (eventError) {
        console.error("[DepositRelay] Event parse failed:", eventError);
      }
    }

    return null;
  } catch (error) {
    console.error("[DepositRelay] Failed to process tx:", error);
    return null;
  }
}

/**
 * Backward-compatible wrapper used by older callsites that only expect deposits.
 */
export async function processDepositTx(txHash: string): Promise<DepositRecord | null> {
  const result = await processVaultTx(txHash);
  return result?.eventType === "deposit" ? result.deposit : null;
}

// ============================================
// Poll for new deposits (background mode)
// ============================================

let pollInterval: ReturnType<typeof setInterval> | null = null;

export async function startDepositPoller(intervalMs: number = 10_000): Promise<void> {
  if (pollInterval) return; // Already running

  const vaultAddress = getVaultAddress();
  if (!vaultAddress) {
    console.warn("[DepositRelay] No VAULT_ADDRESS configured, poller not started");
    return;
  }

  const client = getMonadClient();

  // Start from recent block
  try {
    const currentBlock = await client.getBlockNumber();
    lastProcessedBlock = currentBlock - BigInt(100); // Look back 100 blocks on start
    if (lastProcessedBlock < BigInt(0)) lastProcessedBlock = BigInt(0);
  } catch {
    lastProcessedBlock = BigInt(0);
  }

  console.log(`[DepositRelay] Starting poller from block ${lastProcessedBlock}`);

  pollInterval = setInterval(async () => {
    try {
      const currentBlock = await client.getBlockNumber();
      if (currentBlock <= lastProcessedBlock) return;

      const [depositLogs, withdrawalLogs] = await Promise.all([
        client.getLogs({
          address: vaultAddress,
          event: DEPOSITED_EVENT,
          fromBlock: lastProcessedBlock + BigInt(1),
          toBlock: currentBlock,
        }),
        client.getLogs({
          address: vaultAddress,
          event: WITHDRAWN_EVENT,
          fromBlock: lastProcessedBlock + BigInt(1),
          toBlock: currentBlock,
        }),
      ]);

      const txHashes = new Set<string>();
      for (const log of [...depositLogs, ...withdrawalLogs]) {
        if (log.transactionHash) txHashes.add(log.transactionHash);
      }

      for (const txHash of Array.from(txHashes)) {
        if (await hasProcessedVaultTx(txHash)) continue;
        await processVaultTx(txHash);
        console.log(`[DepositRelay] Processed vault tx: ${txHash}`);
      }

      lastProcessedBlock = currentBlock;
    } catch (error) {
      console.error("[DepositRelay] Poll error:", error);
    }
  }, intervalMs);
}

export function stopDepositPoller(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// ============================================
// Query functions
// ============================================

export async function getDepositsForAgent(agentId: string): Promise<DepositRecord[]> {
  if (isSupabaseStoreEnabled()) {
    const rows = await sbGetDepositsForAgent(agentId);
    return rows.map(fromDepositRow);
  }
  return depositLedger.filter((d) => d.agentId === agentId);
}

export async function getDepositsForUser(user: Address): Promise<DepositRecord[]> {
  if (isSupabaseStoreEnabled()) {
    const rows = await sbGetDepositsForUser(user);
    return rows.map(fromDepositRow);
  }
  return depositLedger.filter(
    (d) => d.user.toLowerCase() === user.toLowerCase()
  );
}

export async function getTotalDepositedUsd(agentId: string): Promise<number> {
  const deposits = await getDepositsForAgent(agentId);
  return deposits.reduce((sum, d) => sum + d.usdValue, 0);
}

/**
 * Get user's share percentage for an agent
 */
export async function getUserSharePercent(
  agentId: string,
  user: Address,
  network?: MonadNetwork
): Promise<number> {
  const vaultAddress = getVaultAddress(network);
  if (!vaultAddress) return 0;

  const client = getMonadClient(network);

  try {
    const agentIdBytes = ("0x" + agentId.padStart(64, "0")) as `0x${string}`;

    const [userShares, totalShares] = await Promise.all([
      client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "userShares",
        args: [agentIdBytes, user],
      }) as Promise<bigint>,
      client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "totalShares",
        args: [agentIdBytes],
      }) as Promise<bigint>,
    ]);

    if (totalShares === BigInt(0)) return 0;
    return Number((userShares * BigInt(10000)) / totalShares) / 100;
  } catch {
    return 0;
  }
}

/**
 * Read vault TVL for an agent from on-chain
 */
export async function getVaultTvlOnChain(agentId: string, network?: MonadNetwork): Promise<number> {
  const vaultAddress = getVaultAddress(network);
  if (!vaultAddress) return 0;

  const client = getMonadClient(network);

  try {
    const agentIdBytes = ("0x" + agentId.padStart(64, "0")) as `0x${string}`;

    const tvl = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: "getVaultTVL",
      args: [agentIdBytes],
    })) as bigint;

    return parseFloat(formatEther(tvl));
  } catch {
    return 0;
  }
}
