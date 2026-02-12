import { createPublicClient, formatEther, http, type Address } from "viem";
import { getHclawLockAddressIfSet } from "@/lib/env";
import { isMonadTestnet } from "@/lib/network";
import type { HclawLockPosition, HclawLockState, HclawLockTier } from "@/lib/types";
import { HCLAW_LOCK_ABI } from "@/lib/vault";

export const HCLAW_LOCK_DURATIONS = [30, 90, 180] as const;
export type MonadNetwork = "mainnet" | "testnet";
const LOCK_COMPAT_CACHE_TTL_MS = 60_000;
const LOCK_READ_PROBE_USER = "0x000000000000000000000000000000000000dEaD" as Address;
const lockCompatCache = new Map<
  string,
  {
    expiresAt: number;
    value: { deployed: boolean; compatible: boolean; reason?: string };
  }
>();

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

export function tierToBoostBps(tier: HclawLockTier): number {
  if (tier === 1) return 12_500;
  if (tier === 2) return 17_500;
  if (tier === 3) return 25_000;
  return 10_000;
}

export function tierToRebateBps(tier: HclawLockTier): number {
  if (tier === 1) return 1_500;
  if (tier === 2) return 3_500;
  if (tier === 3) return 5_500;
  return 0;
}

export function durationToTier(durationDays: number): HclawLockTier {
  if (durationDays >= 180) return 3;
  if (durationDays >= 90) return 2;
  if (durationDays >= 30) return 1;
  return 0;
}

export function previewPower(amount: number, durationDays: number): number {
  const tier = durationToTier(durationDays);
  const multiplier = tierToBoostBps(tier) / 10_000;
  return amount * multiplier;
}

export function getEmptyLockState(user: Address): HclawLockState {
  return {
    user,
    tier: 0,
    power: 0,
    boostBps: 10_000,
    rebateBps: 0,
    lockIds: [],
    positions: [],
  };
}

function formatOneLineError(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0];
  return String(error);
}

async function getLockCompatibility(
  network: MonadNetwork | undefined,
  address: Address
): Promise<{ deployed: boolean; compatible: boolean; reason?: string }> {
  const networkKey = network ?? (isMonadTestnet() ? "testnet" : "mainnet");
  const cacheKey = `${networkKey}:${address.toLowerCase()}`;
  const cached = lockCompatCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const client = getPublicClient(network);

  try {
    const code = await client.getCode({ address });
    if (!code || code === "0x" || code.length <= 2) {
      const value = { deployed: false, compatible: false, reason: "No contract code at address" };
      lockCompatCache.set(cacheKey, { value, expiresAt: Date.now() + LOCK_COMPAT_CACHE_TTL_MS });
      return value;
    }

    // Verify core read-only surface used by policy and lock actions.
    // Some deployed contracts may not expose lock-id enumeration.
    await Promise.all([
      client.readContract({
        address,
        abi: HCLAW_LOCK_ABI,
        functionName: "getUserTier",
        args: [LOCK_READ_PROBE_USER],
      }),
      client.readContract({
        address,
        abi: HCLAW_LOCK_ABI,
        functionName: "getUserPower",
        args: [LOCK_READ_PROBE_USER],
      }),
      client.readContract({
        address,
        abi: HCLAW_LOCK_ABI,
        functionName: "getUserLockIds",
        args: [LOCK_READ_PROBE_USER],
      }),
    ]);

    const value = { deployed: true, compatible: true };
    lockCompatCache.set(cacheKey, { value, expiresAt: Date.now() + LOCK_COMPAT_CACHE_TTL_MS });
    return value;
  } catch (error) {
    const value = { deployed: true, compatible: false, reason: formatOneLineError(error) };
    lockCompatCache.set(cacheKey, { value, expiresAt: Date.now() + LOCK_COMPAT_CACHE_TTL_MS });
    return value;
  }
}

export async function getLockContractStatus(network?: MonadNetwork): Promise<{
  address: Address | null;
  deployed: boolean;
  compatible: boolean;
  reason?: string;
}> {
  const address = getHclawLockAddressIfSet(network);
  if (!address) return { address: null, deployed: false, compatible: false, reason: "Address not configured" };

  const compatibility = await getLockCompatibility(network, address);
  return { address, ...compatibility };
}

export async function getUserLockState(user: Address, network?: MonadNetwork): Promise<HclawLockState> {
  const status = await getLockContractStatus(network);
  if (!status.address || !status.deployed || !status.compatible) {
    return getEmptyLockState(user);
  }
  const lockAddress = status.address;
  const client = getPublicClient(network);

  try {
    const [tierRaw, powerRaw] = await Promise.all([
      client.readContract({
        address: lockAddress,
        abi: HCLAW_LOCK_ABI,
        functionName: "getUserTier",
        args: [user],
      }) as Promise<number>,
      client.readContract({
        address: lockAddress,
        abi: HCLAW_LOCK_ABI,
        functionName: "getUserPower",
        args: [user],
      }) as Promise<bigint>,
    ]);

    let lockIdsRaw: bigint[] = [];
    try {
      lockIdsRaw = (await client.readContract({
        address: lockAddress,
        abi: HCLAW_LOCK_ABI,
        functionName: "getUserLockIds",
        args: [user],
      })) as bigint[];
    } catch (error) {
      const msg = formatOneLineError(error);
      console.warn(`[HCLAW] getUserLockIds unavailable for ${user.slice(0, 10)}…: ${msg}`);
    }

    const positionsRaw = await Promise.all(
      lockIdsRaw.map(async (id) => {
        try {
          const row = (await client.readContract({
            address: lockAddress,
            abi: HCLAW_LOCK_ABI,
            functionName: "locks",
            args: [id],
          })) as readonly [bigint, Address, bigint, bigint, bigint, number, number, boolean];

          const endTsMs = Number(row[4]) * 1000;
          return {
            lockId: row[0].toString(),
            amount: Number(formatEther(row[2])),
            startTs: Number(row[3]) * 1000,
            endTs: endTsMs,
            durationDays: Number(row[5]),
            multiplierBps: Number(row[6]),
            unlocked: Boolean(row[7]),
            remainingMs: Math.max(0, endTsMs - Date.now()),
          } satisfies HclawLockPosition;
        } catch {
          return null;
        }
      })
    );

    const tier = Math.max(0, Math.min(3, Number(tierRaw))) as HclawLockTier;
    const positions = positionsRaw
      .filter((p): p is HclawLockPosition => Boolean(p))
      .sort((a, b) => a.endTs - b.endTs);

    return {
      user,
      tier,
      power: Number(formatEther(powerRaw)),
      boostBps: tierToBoostBps(tier),
      rebateBps: tierToRebateBps(tier),
      lockIds: lockIdsRaw.map((id) => id.toString()),
      positions,
    };
  } catch (error) {
    const msg = formatOneLineError(error);
    console.warn(`[HCLAW] getUserLockState fallback for ${user.slice(0, 10)}…: ${msg}`);
    return getEmptyLockState(user);
  }
}

export function buildLockWriteRequest(
  params:
  | { action: "lock"; amountWei: bigint; durationDays: 30 | 90 | 180 }
  | { action: "extendLock"; lockId: bigint; durationDays: 30 | 90 | 180 }
  | { action: "increaseLock"; lockId: bigint; amountWei: bigint }
  | { action: "unlock"; lockId: bigint },
  network?: MonadNetwork
):
  | { address: Address; abi: typeof HCLAW_LOCK_ABI; functionName: string; args: readonly unknown[] }
  | null {
  const lockAddress = getHclawLockAddressIfSet(network);
  if (!lockAddress) return null;

  if (params.action === "lock") {
    return {
      address: lockAddress,
      abi: HCLAW_LOCK_ABI,
      functionName: "lock",
      args: [params.amountWei, params.durationDays],
    };
  }

  if (params.action === "extendLock") {
    return {
      address: lockAddress,
      abi: HCLAW_LOCK_ABI,
      functionName: "extendLock",
      args: [params.lockId, params.durationDays],
    };
  }

  if (params.action === "increaseLock") {
    return {
      address: lockAddress,
      abi: HCLAW_LOCK_ABI,
      functionName: "increaseLock",
      args: [params.lockId, params.amountWei],
    };
  }

  return {
    address: lockAddress,
    abi: HCLAW_LOCK_ABI,
    functionName: "unlock",
    args: [params.lockId],
  };
}
