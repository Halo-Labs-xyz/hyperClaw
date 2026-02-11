import { createPublicClient, formatEther, http, type Address } from "viem";
import {
  getHclawPolicyAddressIfSet,
  getVaultAddressIfDeployed,
} from "@/lib/env";
import { isMonadTestnet } from "@/lib/network";
import type { HclawCapContext, HclawLockTier } from "@/lib/types";
import { getUserLockState, tierToBoostBps, tierToRebateBps } from "@/lib/hclaw-lock";
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

function getMonadRpcUrl(): string {
  return isMonadTestnet() ? "https://testnet-rpc.monad.xyz" : "https://rpc.monad.xyz";
}

function getMonadChain() {
  return {
    id: isMonadTestnet() ? 10143 : 143,
    name: isMonadTestnet() ? "Monad Testnet" : "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [getMonadRpcUrl()] } },
  } as const;
}

function getPublicClient() {
  const chain = getMonadChain();
  return createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
}

async function readBaseCapFallback(): Promise<number> {
  const vaultAddress = getVaultAddressIfDeployed();
  if (!vaultAddress) return 100;

  try {
    const client = getPublicClient();
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

async function readPolicyFromChain(user: Address): Promise<PolicyRead> {
  const cacheKey = user.toLowerCase();
  const cached = policyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const policyAddress = getHclawPolicyAddressIfSet();
  const lockState = await getUserLockState(user);

  if (!policyAddress) {
    const baseCapUsd = await readBaseCapFallback();
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

  const client = getPublicClient();

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
    console.warn("[HCLAW] policy read fallback:", error);
    const baseCapUsd = await readBaseCapFallback();
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

async function readUserDepositsUsd(agentId: string, user: Address): Promise<number> {
  const vaultAddress = getVaultAddressIfDeployed();
  if (!vaultAddress) return 0;

  try {
    const client = getPublicClient();
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

export async function getUserCapContext(user: Address, agentId?: string): Promise<HclawCapContext> {
  const policy = await readPolicyFromChain(user);
  const depositedUsd = agentId ? await readUserDepositsUsd(agentId, user) : 0;

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

export async function getBaseCapUsd(): Promise<number> {
  const policyAddress = getHclawPolicyAddressIfSet();
  if (!policyAddress) return readBaseCapFallback();

  try {
    const client = getPublicClient();
    const baseCapRaw = (await client.readContract({
      address: policyAddress,
      abi: HCLAW_POLICY_ABI,
      functionName: "getBaseCapUsd",
    })) as bigint;
    return Number(formatEther(baseCapRaw));
  } catch {
    return readBaseCapFallback();
  }
}
