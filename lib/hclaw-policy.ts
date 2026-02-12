import { createPublicClient, formatEther, http, type Address } from "viem";
import {
  getHclawPolicyAddressIfSet,
  getVaultAddressIfDeployed,
} from "@/lib/env";
import { isMonadTestnet } from "@/lib/network";
import type { HclawCapContext, HclawLockTier } from "@/lib/types";
import { getUserLockState, tierToBoostBps, tierToRebateBps, type MonadNetwork } from "@/lib/hclaw-lock";
import { agentIdToBytes32, HCLAW_POLICY_ABI, VAULT_ABI } from "@/lib/vault";

interface PolicyRead {
  baseCapUsd: number;
  boostedCapUsd: number;
  boostBps: number;
  rebateBps: number;
  tier: HclawLockTier;
  power: number;
}

const POLICY_CACHE_TTL_MS = 15_000;
const policyCache = new Map<string, { expiresAt: number; value: PolicyRead }>();
const POLICY_COMPAT_CACHE_TTL_MS = 60_000;
const policyCompatCache = new Map<string, { expiresAt: number; value: boolean }>();

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

function getMonadChain(network?: MonadNetwork) {
  const testnet = network ? network === "testnet" : isMonadTestnet();
  return {
    id: testnet ? 10143 : 143,
    name: testnet ? "Monad Testnet" : "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [getMonadRpcUrl(network)] } },
  } as const;
}

function getPublicClient(network?: MonadNetwork) {
  const chain = getMonadChain(network);
  return createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
}

function oneLineError(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0];
  return String(error);
}

async function isPolicyCompatible(
  client: ReturnType<typeof getPublicClient>,
  policyAddress: Address,
  network?: MonadNetwork
): Promise<boolean> {
  const networkKey = network ?? (isMonadTestnet() ? "testnet" : "mainnet");
  const cacheKey = `${networkKey}:${policyAddress.toLowerCase()}`;
  const cached = policyCompatCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    await client.readContract({
      address: policyAddress,
      abi: HCLAW_POLICY_ABI,
      functionName: "getBaseCapUsd",
    });
    policyCompatCache.set(cacheKey, { value: true, expiresAt: Date.now() + POLICY_COMPAT_CACHE_TTL_MS });
    return true;
  } catch {
    policyCompatCache.set(cacheKey, { value: false, expiresAt: Date.now() + POLICY_COMPAT_CACHE_TTL_MS });
    return false;
  }
}

async function readBaseCapFallback(network?: MonadNetwork): Promise<number> {
  const vaultAddress = getVaultAddressIfDeployed(network);
  if (!vaultAddress) return 100;

  try {
    const client = getPublicClient(network);
    const baseCapRaw = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: "getMaxDepositUSD",
    })) as bigint;
    return Number(formatEther(baseCapRaw));
  } catch {
    return 100;
  }
}

async function readPolicyFromChain(user: Address, network?: MonadNetwork): Promise<PolicyRead> {
  const networkKey = network ?? (isMonadTestnet() ? "testnet" : "mainnet");
  const cacheKey = `${networkKey}:${user.toLowerCase()}`;
  const cached = policyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const policyAddress = getHclawPolicyAddressIfSet(network);
  const lockState = await getUserLockState(user, network);

  if (!policyAddress) {
    const baseCapUsd = await readBaseCapFallback(network);
    const boostedCapUsd = (baseCapUsd * lockState.boostBps) / 10_000;
    const fallbackValue: PolicyRead = {
      baseCapUsd,
      boostedCapUsd,
      boostBps: lockState.boostBps,
      rebateBps: lockState.rebateBps,
      tier: lockState.tier,
      power: lockState.power,
    };
    policyCache.set(cacheKey, { value: fallbackValue, expiresAt: Date.now() + POLICY_CACHE_TTL_MS });
    return fallbackValue;
  }

  const client = getPublicClient(network);

  // Pre-check: does the policy contract have code deployed?
  try {
    const code = await client.getCode({ address: policyAddress });
    if (!code || code === "0x" || code.length <= 2) {
      // No contract at this address – fall back silently
      const baseCapUsd = await readBaseCapFallback(network);
      const boostedCapUsd = (baseCapUsd * lockState.boostBps) / 10_000;
      const fallbackValue: PolicyRead = {
        baseCapUsd,
        boostedCapUsd,
        boostBps: lockState.boostBps,
        rebateBps: lockState.rebateBps,
        tier: lockState.tier,
        power: lockState.power,
      };
      policyCache.set(cacheKey, { value: fallbackValue, expiresAt: Date.now() + POLICY_CACHE_TTL_MS });
      return fallbackValue;
    }
  } catch {
    // getCode failed – continue to try the actual call anyway
  }

  if (!(await isPolicyCompatible(client, policyAddress, network))) {
    const baseCapUsd = await readBaseCapFallback(network);
    const tier = lockState.tier;
    const boostBps = tierToBoostBps(tier);
    const value: PolicyRead = {
      baseCapUsd,
      boostedCapUsd: (baseCapUsd * boostBps) / 10_000,
      boostBps,
      rebateBps: tierToRebateBps(tier),
      tier,
      power: lockState.power,
    };
    policyCache.set(cacheKey, { value, expiresAt: Date.now() + POLICY_CACHE_TTL_MS });
    return value;
  }

  try {
    const [baseCapRaw, userCapRaw, rebateBpsRaw, boostBpsRaw, tierRaw, powerRaw] = await Promise.all([
      client.readContract({
        address: policyAddress,
        abi: HCLAW_POLICY_ABI,
        functionName: "getBaseCapUsd",
      }) as Promise<bigint>,
      client.readContract({
        address: policyAddress,
        abi: HCLAW_POLICY_ABI,
        functionName: "getUserCapUsd",
        args: [user],
      }) as Promise<bigint>,
      client.readContract({
        address: policyAddress,
        abi: HCLAW_POLICY_ABI,
        functionName: "getUserRebateBps",
        args: [user],
      }) as Promise<number>,
      client.readContract({
        address: policyAddress,
        abi: HCLAW_POLICY_ABI,
        functionName: "getUserBoostBps",
        args: [user],
      }) as Promise<number>,
      client.readContract({
        address: policyAddress,
        abi: HCLAW_POLICY_ABI,
        functionName: "getUserTier",
        args: [user],
      }) as Promise<number>,
      client.readContract({
        address: policyAddress,
        abi: HCLAW_POLICY_ABI,
        functionName: "getUserPower",
        args: [user],
      }) as Promise<bigint>,
    ]);

    const value: PolicyRead = {
      baseCapUsd: Number(formatEther(baseCapRaw)),
      boostedCapUsd: Number(formatEther(userCapRaw)),
      rebateBps: Number(rebateBpsRaw),
      boostBps: Number(boostBpsRaw),
      tier: Math.max(0, Math.min(3, Number(tierRaw))) as HclawLockTier,
      power: Number(formatEther(powerRaw)),
    };

    policyCache.set(cacheKey, { value, expiresAt: Date.now() + POLICY_CACHE_TTL_MS });
    return value;
  } catch (error) {
    const msg = oneLineError(error);
    console.warn(`[HCLAW] policy read fallback: ${msg}`);
    const baseCapUsd = await readBaseCapFallback(network);
    const tier = lockState.tier;
    const boostBps = tierToBoostBps(tier);
    const value: PolicyRead = {
      baseCapUsd,
      boostedCapUsd: (baseCapUsd * boostBps) / 10_000,
      boostBps,
      rebateBps: tierToRebateBps(tier),
      tier,
      power: lockState.power,
    };
    policyCache.set(cacheKey, { value, expiresAt: Date.now() + POLICY_CACHE_TTL_MS });
    return value;
  }
}

async function readUserDepositsUsd(agentId: string, user: Address, network?: MonadNetwork): Promise<number> {
  const vaultAddress = getVaultAddressIfDeployed(network);
  if (!vaultAddress) return 0;

  try {
    const client = getPublicClient(network);
    const userDepositsRaw = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: "userDepositsUSD",
      args: [agentIdToBytes32(agentId), user],
    })) as bigint;
    return Number(formatEther(userDepositsRaw));
  } catch {
    return 0;
  }
}

export async function getUserCapContext(
  user: Address,
  agentId?: string,
  network?: MonadNetwork
): Promise<HclawCapContext> {
  const policy = await readPolicyFromChain(user, network);
  const depositedUsd = agentId ? await readUserDepositsUsd(agentId, user, network) : 0;

  return {
    user,
    baseCapUsd: policy.baseCapUsd,
    boostedCapUsd: policy.boostedCapUsd,
    capRemainingUsd: Math.max(0, policy.boostedCapUsd - depositedUsd),
    boostBps: policy.boostBps,
    rebateBps: policy.rebateBps,
    tier: policy.tier,
    power: policy.power,
  };
}

export async function getBaseCapUsd(network?: MonadNetwork): Promise<number> {
  const policyAddress = getHclawPolicyAddressIfSet(network);
  if (!policyAddress) return readBaseCapFallback(network);

  try {
    const client = getPublicClient(network);

    // Pre-check contract existence
    const code = await client.getCode({ address: policyAddress });
    if (!code || code === "0x" || code.length <= 2) return readBaseCapFallback(network);

    if (!(await isPolicyCompatible(client, policyAddress, network))) {
      return readBaseCapFallback(network);
    }

    const baseCapRaw = (await client.readContract({
      address: policyAddress,
      abi: HCLAW_POLICY_ABI,
      functionName: "getBaseCapUsd",
    })) as bigint;
    return Number(formatEther(baseCapRaw));
  } catch {
    return readBaseCapFallback(network);
  }
}
