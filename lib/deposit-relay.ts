/**
 * Deposit Relay
 *
 * Bridges Monad vault deposits to Hyperliquid trading capital.
 *
 * Flow:
 * 1. User deposits MON/ERC20 on Monad -> HyperclawVault emits Deposited event
 * 2. Relay detects event via polling (or called after tx confirmation)
 * 3. Relay records the deposit in the agent's share ledger
 * 4. Agent's HL account is pre-funded (testnet: via faucet, mainnet: operator-funded)
 * 5. Relay tracks proportional allocation per depositor
 *
 * For the hackathon demo:
 * - Monad deposits track ownership shares
 * - HL testnet account is pre-funded with test USDC
 * - The relay maps shares to proportional trading capital
 * - No actual cross-chain bridge (that's a production concern)
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
import { provisionAgentWallet } from "./hyperliquid";
import { isMonadTestnet } from "./network";
import {
  bridgeDepositToHyperliquidAgent,
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

/**
 * Convert MON amount (in wei) to USDC value, applying network-specific logic.
 *
 * Testnet: Fixed rate (1 MON = $1000 USDC)
 * Mainnet: Live MON/USD price minus relay fee
 */
async function monToUsdc(
  amountWei: bigint,
  network?: MonadNetwork
): Promise<{ usdValue: number; rate: number; fee: number }> {
  const monAmount = parseFloat(formatEther(amountWei));
  const useTestnet = network ? network === "testnet" : isMonadTestnet();

  if (useTestnet) {
    const usdValue = monAmount * TESTNET_MON_TO_USDC;
    return { usdValue, rate: TESTNET_MON_TO_USDC, fee: 0 };
  }

  // Mainnet: live price
  const monPrice = await fetchMonPrice();
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

async function erc20ToUsdc(
  token: Address,
  amount: bigint,
  client = getMonadClient(),
  network?: MonadNetwork
): Promise<{ usdValue: number; rate: number; fee: number }> {
  const lower = token.toLowerCase();
  const useTestnet = network ? network === "testnet" : isMonadTestnet();
  if (!useTestnet) {
    if (RELAY_STABLE_TOKENS.size === 0) {
      throw new Error(
        "RELAY_STABLE_TOKENS is required on mainnet for ERC20 relay pricing"
      );
    }
    if (!RELAY_STABLE_TOKENS.has(lower)) {
      throw new Error(`ERC20 token ${token} is not in RELAY_STABLE_TOKENS`);
    }
  }

  const decimals = await getTokenDecimals(token, client);
  const usdValue = parseFloat(formatUnits(amount, decimals));
  return { usdValue: normalizeUsd(Math.max(0, usdValue)), rate: 1, fee: 0 };
}

async function tokenAmountToUsdc(
  token: Address,
  amount: bigint,
  client = getMonadClient(),
  network?: MonadNetwork
): Promise<{ usdValue: number; rate: number; fee: number }> {
  if (token.toLowerCase() === zeroAddress) {
    const mon = await monToUsdc(amount, network);
    return { ...mon, usdValue: normalizeUsd(mon.usdValue) };
  }
  return erc20ToUsdc(token, amount, client, network);
}

// ============================================
// Monad chain config
// ============================================

const monadTestnetChain = {
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet-rpc.monad.xyz"] },
  },
} as const;

const monadMainnetChain = {
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.monad.xyz"] },
  },
} as const;

function getMonadChain(network?: MonadNetwork) {
  if (network) {
    return network === "testnet" ? monadTestnetChain : monadMainnetChain;
  }
  return isMonadTestnet() ? monadTestnetChain : monadMainnetChain;
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

  const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS as Address | undefined;
  if (!vaultAddress) return null;

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

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== vaultAddress.toLowerCase()) continue;

      try {
        const topic0 = log.topics[0];
        if (!topic0 || !log.data || log.topics.length < 3) continue;

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
            activeNetwork ?? undefined
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
              const isMainnet = (activeNetwork ?? (isMonadTestnet() ? "testnet" : "mainnet")) === "mainnet";

              if (isMainnet && isMainnetBridgeEnabled()) {
                console.log(
                  `[DepositRelay] Mainnet bridge funding for agent ${agentIdHex} ($${usdValue.toFixed(2)})`
                );
                const walletResult = await provisionAgentWallet(agentIdHex, 0);
                record.hlWalletAddress = walletResult.address;

                if (agent.hlAddress !== walletResult.address) {
                  await updateAgent(agentIdHex, { hlAddress: walletResult.address });
                  console.log(`[DepositRelay] Updated agent hlAddress to ${walletResult.address}`);
                }

                const bridge = await bridgeDepositToHyperliquidAgent({
                  hlAddress: walletResult.address,
                  sourceToken: tokenAddress,
                  sourceAmountRaw: amount,
                  sourceAmountRawLabel: amount.toString(),
                });

                record.bridgeProvider = bridge.provider;
                record.bridgeStatus = bridge.status;
                record.bridgeDestination = bridge.destinationAddress;
                record.bridgeTxHash = bridge.relayTxHash;
                record.bridgeOrderId = bridge.bridgeOrderId;
                record.bridgeNote = bridge.note;

                record.hlFunded = bridge.status === "submitted";
                record.hlFundedAmount = bridge.status === "submitted" ? usdValue : 0;
                record.relayed = bridge.status === "submitted";

                if (bridge.status !== "submitted") {
                  shouldRetryFunding = true;
                }

                console.log(
                  `[DepositRelay] Bridge provider=${bridge.provider} status=${bridge.status}` +
                    (bridge.relayTxHash ? ` tx=${bridge.relayTxHash}` : "") +
                    (bridge.note ? ` note=${bridge.note}` : "")
                );
              } else {
                console.log(
                  `[DepositRelay] Provisioning HL wallet for agent ${agentIdHex} with $${usdValue}`
                );
                const hlResult = await provisionAgentWallet(agentIdHex, usdValue);
                record.hlWalletAddress = hlResult.address;
                record.hlFunded = hlResult.funded;
                record.hlFundedAmount = hlResult.fundedAmount;
                record.relayed = !!hlResult.funded;
                console.log(
                  `[DepositRelay] HL wallet ${hlResult.address} funded=${hlResult.funded} amount=$${hlResult.fundedAmount}`
                );

                if (agent.hlAddress !== hlResult.address) {
                  await updateAgent(agentIdHex, { hlAddress: hlResult.address });
                  console.log(`[DepositRelay] Updated agent hlAddress to ${hlResult.address}`);
                }
              }
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

          const agent = await getAgent(agentIdHex);
          if (agent) {
            const tvlUsd = await getVaultTvlOnChain(agentIdHex, activeNetwork ?? undefined);
            let depositorCount = agent.depositorCount;

            try {
              const agentIdBytesForRead = ("0x" +
                agentIdHex.padStart(64, "0")) as `0x${string}`;
              const remainingShares = (await client.readContract({
                address: vaultAddress,
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
          if (isMainnet && isMainnetBridgeEnabled() && monAmount > BigInt(0)) {
            try {
              const conversion = await tokenAmountToUsdc(
                zeroAddress,
                monAmount,
                client,
                activeNetwork ?? undefined
              );

              if (conversion.usdValue > 0) {
                const bridge = await bridgeWithdrawalToMonadUser({
                  agentId: agentIdHex,
                  userAddress,
                  usdAmount: conversion.usdValue,
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
                    (bridge.relayTxHash ? ` tx=${bridge.relayTxHash}` : "") +
                    (bridge.note ? ` note=${bridge.note}` : "")
                );
              } else {
                withdrawal.relayed = true;
              }
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

  const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS as Address | undefined;
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
  const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS as Address | undefined;
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
  const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS as Address | undefined;
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
