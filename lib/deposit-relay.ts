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

import { createPublicClient, http, parseAbiItem, type Address, formatEther } from "viem";
import { VAULT_ABI } from "./vault";
import { getAgent, updateAgent } from "./store";
import { provisionAgentWallet } from "./hyperliquid";
import { isMonadTestnet } from "./network";

// ============================================
// MON -> USDC price conversion
// ============================================

// Relay fee: percentage deducted from the converted USDC amount on mainnet
// Covers gas, bridge costs, and protocol margin. Set via env or default 1%.
const RELAY_FEE_BPS = parseInt(process.env.RELAY_FEE_BPS || "100", 10); // 100 bps = 1%

// Testnet: fixed rate (0.1 MON = $100 USDC)
const TESTNET_MON_TO_USDC = 1000;

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
async function monToUsdc(amountWei: bigint): Promise<{ usdValue: number; rate: number; fee: number }> {
  const monAmount = parseFloat(formatEther(amountWei));

  if (isMonadTestnet()) {
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

function getMonadChain() {
  return isMonadTestnet() ? monadTestnetChain : monadMainnetChain;
}

function getMonadClient() {
  const chain = getMonadChain();
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
  blockNumber: bigint;
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
}

// In-memory deposit ledger (persisted via store on important events)
const depositLedger: DepositRecord[] = [];
let lastProcessedBlock: bigint = BigInt(0);

// ============================================
// Event parsing
// ============================================

const DEPOSITED_EVENT = parseAbiItem(
  "event Deposited(bytes32 indexed agentId, address indexed user, address token, uint256 amount, uint256 shares)"
);

/** Reserved for future Withdrawn event parsing. */
export const WITHDRAWN_EVENT = parseAbiItem(
  "event Withdrawn(bytes32 indexed agentId, address indexed user, uint256 shares, uint256 monAmount)"
);

// ============================================
// Process a confirmed deposit transaction
// ============================================

/**
 * Called after a user's deposit tx is confirmed on Monad.
 * Parses the Deposited event, records shares, updates agent TVL.
 */
export async function processDepositTx(txHash: string): Promise<DepositRecord | null> {
  const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS as Address | undefined;
  if (!vaultAddress) return null;

  const client = getMonadClient();

  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    if (!receipt || receipt.status !== "success") {
      return null;
    }

    // Find Deposited event in logs
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== vaultAddress.toLowerCase()) continue;

      try {
        // Manually parse the Deposited event
        // Topic 0: event signature hash
        // Topic 1: agentId (indexed bytes32)
        // Topic 2: user (indexed address)
        // Data: token (address), amount (uint256), shares (uint256)
        if (log.topics.length >= 3 && log.data) {
          const agentIdBytes = log.topics[1];
          const userAddress = ("0x" + (log.topics[2] || "").slice(26)) as Address;

          // Decode data (token, amount, shares)
          const data = log.data.slice(2); // remove 0x
          const tokenAddress = ("0x" + data.slice(24, 64)) as Address;
          const amountHex = "0x" + data.slice(64, 128);
          const sharesHex = "0x" + data.slice(128, 192);

          const amount = BigInt(amountHex);
          const shares = BigInt(sharesHex);

          // Convert agentId from bytes32 to our hex string
          const agentIdHex = agentIdBytes ? agentIdBytes.replace(/^0x0+/, "") : "";

          // Convert MON to USDC: testnet uses fixed rate, mainnet uses live price minus fees
          const conversion = await monToUsdc(amount);
          const usdValue = conversion.usdValue;
          console.log(
            `[DepositRelay] ${parseFloat(formatEther(amount))} MON -> $${usdValue.toFixed(2)} USDC` +
            ` (rate=${conversion.rate}, fee=$${conversion.fee.toFixed(2)})`
          );

          const record: DepositRecord = {
            txHash,
            blockNumber: receipt.blockNumber,
            agentId: agentIdHex,
            user: userAddress,
            token: tokenAddress,
            amount: amount.toString(),
            shares: shares.toString(),
            usdValue,
            monRate: conversion.rate,
            relayFee: conversion.fee,
            timestamp: Date.now(),
            relayed: true,
          };

          // ========== Provision + Fund HL wallet 1:1 ==========
          // Create (or reuse) an HL testnet wallet for this agent,
          // then send equivalent USDC from the operator account.
          if (usdValue > 0) {
            try {
              console.log(`[DepositRelay] Provisioning HL wallet for agent ${agentIdHex} with $${usdValue}`);
              const hlResult = await provisionAgentWallet(agentIdHex, usdValue);
              record.hlWalletAddress = hlResult.address;
              record.hlFunded = hlResult.funded;
              record.hlFundedAmount = hlResult.fundedAmount;
              console.log(
                `[DepositRelay] HL wallet ${hlResult.address} ` +
                `funded=${hlResult.funded} amount=$${hlResult.fundedAmount}`
              );

              // Keep agent.hlAddress in sync with the actual provisioned wallet
              const currentAgent = await getAgent(agentIdHex);
              if (currentAgent && currentAgent.hlAddress !== hlResult.address) {
                await updateAgent(agentIdHex, { hlAddress: hlResult.address });
                console.log(`[DepositRelay] Updated agent hlAddress to ${hlResult.address}`);
              }
            } catch (hlErr) {
              console.error("[DepositRelay] HL wallet provision/fund failed:", hlErr);
              record.hlFunded = false;
            }
          }

          depositLedger.push(record);

          // Update agent TVL
          const agent = await getAgent(agentIdHex);
          if (agent) {
            await updateAgent(agentIdHex, {
              vaultTvlUsd: agent.vaultTvlUsd + usdValue,
              depositorCount: agent.depositorCount + 1,
            });
          }

          return record;
        }
      } catch {
        // Continue to next log
      }
    }

    return null;
  } catch (error) {
    console.error("[DepositRelay] Failed to process tx:", error);
    return null;
  }
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

      const logs = await client.getLogs({
        address: vaultAddress,
        event: DEPOSITED_EVENT,
        fromBlock: lastProcessedBlock + BigInt(1),
        toBlock: currentBlock,
      });

      for (const log of logs) {
        if (!log.transactionHash) continue;

        // Check if we already processed this
        if (depositLedger.some((d) => d.txHash === log.transactionHash)) continue;

        await processDepositTx(log.transactionHash);
        console.log(`[DepositRelay] Processed deposit tx: ${log.transactionHash}`);
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

export function getDepositsForAgent(agentId: string): DepositRecord[] {
  return depositLedger.filter((d) => d.agentId === agentId);
}

export function getDepositsForUser(user: Address): DepositRecord[] {
  return depositLedger.filter(
    (d) => d.user.toLowerCase() === user.toLowerCase()
  );
}

export function getTotalDepositedUsd(agentId: string): number {
  return depositLedger
    .filter((d) => d.agentId === agentId)
    .reduce((sum, d) => sum + d.usdValue, 0);
}

/**
 * Get user's share percentage for an agent
 */
export async function getUserSharePercent(
  agentId: string,
  user: Address
): Promise<number> {
  const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS as Address | undefined;
  if (!vaultAddress) return 0;

  const client = getMonadClient();

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
export async function getVaultTvlOnChain(agentId: string): Promise<number> {
  const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS as Address | undefined;
  if (!vaultAddress) return 0;

  const client = getMonadClient();

  try {
    const agentIdBytes = ("0x" + agentId.padStart(64, "0")) as `0x${string}`;

    const tvl = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: "totalDepositsUSD",
      args: [agentIdBytes],
    })) as bigint;

    return parseFloat(formatEther(tvl));
  } catch {
    return 0;
  }
}
