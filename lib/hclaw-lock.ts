import { createPublicClient, formatEther, http, type Address } from "viem";
import { getHclawLockAddressIfSet } from "@/lib/env";
import { isMonadTestnet } from "@/lib/network";
import type { HclawLockPosition, HclawLockState, HclawLockTier } from "@/lib/types";
import { HCLAW_LOCK_ABI } from "@/lib/vault";

export const HCLAW_LOCK_DURATIONS = [30, 90, 180] as const;
export type MonadNetwork = "mainnet" | "testnet";

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

export async function getLockContractStatus(network?: MonadNetwork): Promise<{
  address: Address | null;
  deployed: boolean;
}> {
  const address = getHclawLockAddressIfSet(network);
  if (!address) return { address: null, deployed: false };

  try {
    const client = getPublicClient(network);
    const code = await client.getCode({ address });
    return { address, deployed: Boolean(code && code !== "0x" && code.length > 2) };
  } catch {
    return { address, deployed: false };
  }
}

export async function getUserLockState(user: Address, network?: MonadNetwork): Promise<HclawLockState> {
  const lockAddress = getHclawLockAddressIfSet(network);
  if (!lockAddress) return getEmptyLockState(user);

  const client = getPublicClient(network);

  // Pre-check: does the lock contract have code deployed?
  try {
    const code = await client.getCode({ address: lockAddress });
    if (!code || code === "0x" || code.length <= 2) {
      // No contract deployed at this address – return empty without noisy logs
      return getEmptyLockState(user);
    }
  } catch {
    return getEmptyLockState(user);
  }

  try {
    const [tierRaw, powerRaw, lockIdsRaw] = await Promise.all([
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
      client.readContract({
        address: lockAddress,
        abi: HCLAW_LOCK_ABI,
        functionName: "getUserLockIds",
        args: [user],
      }) as Promise<bigint[]>,
    ]);

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
    const msg = error instanceof Error ? error.message.split("\n")[0] : String(error);
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
