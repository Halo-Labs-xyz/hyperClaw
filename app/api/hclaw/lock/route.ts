import { NextResponse } from "next/server";
import { type Address, createPublicClient, http, parseUnits } from "viem";
import {
  buildLockWriteRequest,
  durationToTier,
  getLockContractStatus,
  getUserLockState,
  previewPower,
  tierToBoostBps,
  tierToRebateBps,
} from "@/lib/hclaw-lock";
import { getNetworkState } from "@/lib/network";
import { getHclawAddressIfSet } from "@/lib/env";
import { ERC20_ABI } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseUser(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  return trimmed as Address;
}

function parseDuration(value: unknown): 30 | 90 | 180 | null {
  const n = Number(value);
  if (n === 30 || n === 90 || n === 180) return n;
  return null;
}

function parseNetwork(value: unknown): "mainnet" | "testnet" | null {
  if (value === "mainnet" || value === "testnet") return value;
  return null;
}

function getMonadRpcUrl(network: "mainnet" | "testnet"): string {
  const mainnetRpc =
    process.env.MONAD_MAINNET_RPC_URL ||
    process.env.NEXT_PUBLIC_MONAD_MAINNET_RPC_URL ||
    "https://rpc.monad.xyz";
  const testnetRpc =
    process.env.MONAD_TESTNET_RPC_URL ||
    process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL ||
    "https://testnet-rpc.monad.xyz";
  return network === "testnet" ? testnetRpc : mainnetRpc;
}

async function getTokenDecimals(network: "mainnet" | "testnet", token: Address | null): Promise<number> {
  if (!token) return 18;
  try {
    const client = createPublicClient({
      chain: {
        id: network === "testnet" ? 10143 : 143,
        name: network === "testnet" ? "Monad Testnet" : "Monad",
        nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
        rpcUrls: { default: { http: [getMonadRpcUrl(network)] } },
      },
      transport: http(getMonadRpcUrl(network)),
    });
    const decimals = (await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "decimals",
    })) as number;
    if (!Number.isFinite(decimals) || decimals <= 0 || decimals > 36) return 18;
    return decimals;
  } catch {
    return 18;
  }
}

function serializeArg(arg: unknown): unknown {
  if (typeof arg === "bigint") return arg.toString();
  if (Array.isArray(arg)) return arg.map((item) => serializeArg(item));
  return arg;
}

function serializeTxRequest(
  tx: ReturnType<typeof buildLockWriteRequest>
) {
  if (!tx) return null;
  return {
    ...tx,
    args: tx.args.map((arg) => serializeArg(arg)),
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const user = parseUser(searchParams.get("user"));
    const network =
      parseNetwork(searchParams.get("network")) ??
      (getNetworkState().monadTestnet ? "testnet" : "mainnet");

    if (!user) {
      const contract = await getLockContractStatus(network);
      return NextResponse.json({
        configured: false,
        network,
        contract,
        durations: [30, 90, 180],
        labels: {
          30: "Locked HCLAW (30d)",
          90: "Locked HCLAW (90d)",
          180: "Locked HCLAW (180d)",
        },
      });
    }

    const lock = await getUserLockState(user, network);
    const contract = await getLockContractStatus(network);

    return NextResponse.json({
      configured: true,
      network,
      contract,
      lock,
    });
  } catch (error) {
    console.error("[HCLAW lock] GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch lock state" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = typeof body?.action === "string" ? body.action : "preview";
    const network =
      parseNetwork(body?.network) ??
      (getNetworkState().monadTestnet ? "testnet" : "mainnet");

    if (action === "preview") {
      const amount = Number(body?.amount ?? 0);
      const durationDays = parseDuration(body?.durationDays);
      if (!durationDays || amount <= 0) {
        return NextResponse.json(
          { error: "amount > 0 and durationDays in [30,90,180] required" },
          { status: 400 }
        );
      }

      const tier = durationToTier(durationDays);
      return NextResponse.json({
        action,
        preview: {
          durationDays,
          tier,
          power: previewPower(amount, durationDays),
          boostBps: tierToBoostBps(tier),
          rebateBps: tierToRebateBps(tier),
        },
        network,
      });
    }

    if (action === "buildTx") {
      const txAction = body?.txAction;
      if (txAction === "lock") {
        const durationDays = parseDuration(body?.durationDays);
        const amount = Number(body?.amount ?? 0);
        if (!durationDays || amount <= 0) {
          return NextResponse.json(
            { error: "amount > 0 and durationDays in [30,90,180] required" },
            { status: 400 }
          );
        }

        const token = getHclawAddressIfSet(network);
        const decimals = await getTokenDecimals(network, token);

        const req = buildLockWriteRequest({
          action: "lock",
          amountWei: parseUnits(String(amount), decimals),
          durationDays,
        }, network);
        return NextResponse.json({ network, token, decimals, tx: serializeTxRequest(req) });
      }

      if (txAction === "extendLock") {
        const durationDays = parseDuration(body?.durationDays);
        const lockId = typeof body?.lockId === "string" || typeof body?.lockId === "number"
          ? BigInt(body.lockId)
          : null;
        if (!durationDays || lockId === null) {
          return NextResponse.json({ error: "lockId and durationDays are required" }, { status: 400 });
        }

        const req = buildLockWriteRequest({
          action: "extendLock",
          lockId,
          durationDays,
        }, network);
        return NextResponse.json({ network, tx: serializeTxRequest(req) });
      }

      if (txAction === "increaseLock") {
        const lockId = typeof body?.lockId === "string" || typeof body?.lockId === "number"
          ? BigInt(body.lockId)
          : null;
        const amount = Number(body?.amount ?? 0);
        if (lockId === null || amount <= 0) {
          return NextResponse.json({ error: "lockId and amount > 0 are required" }, { status: 400 });
        }

        const token = getHclawAddressIfSet(network);
        const decimals = await getTokenDecimals(network, token);

        const req = buildLockWriteRequest({
          action: "increaseLock",
          lockId,
          amountWei: parseUnits(String(amount), decimals),
        }, network);
        return NextResponse.json({ network, token, decimals, tx: serializeTxRequest(req) });
      }

      if (txAction === "unlock") {
        const lockId = typeof body?.lockId === "string" || typeof body?.lockId === "number"
          ? BigInt(body.lockId)
          : null;
        if (lockId === null) {
          return NextResponse.json({ error: "lockId is required" }, { status: 400 });
        }

        const req = buildLockWriteRequest({ action: "unlock", lockId }, network);
        return NextResponse.json({ network, tx: serializeTxRequest(req) });
      }

      return NextResponse.json({ error: "Unsupported txAction" }, { status: 400 });
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    console.error("[HCLAW lock] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process lock request" },
      { status: 500 }
    );
  }
}
