import { NextResponse } from "next/server";
import { type Address, getAddress } from "viem";
import { getHclawState } from "@/lib/hclaw";
import { getUserCapContext } from "@/lib/hclaw-policy";
import { getUserLockState } from "@/lib/hclaw-lock";
import { getUserPointsSummary } from "@/lib/hclaw-points";
import { getClaimableSummary } from "@/lib/hclaw-rewards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseUser(value: string | null): Address | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  try {
    return getAddress(trimmed.toLowerCase());
  } catch {
    return null;
  }
}

function parseNetwork(value: string | null): "mainnet" | "testnet" | null {
  if (value === "mainnet" || value === "testnet") return value;
  return null;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const user = parseUser(searchParams.get("user"));
    const agentId = searchParams.get("agentId") ?? undefined;
    const defaultNetwork = process.env.NEXT_PUBLIC_MONAD_TESTNET === "true" ? "testnet" : "mainnet";
    const network = parseNetwork(searchParams.get("network")) ?? defaultNetwork;

    const state = await getHclawState(network, {
      userAddress: user ?? undefined,
      agentId,
    });

    if (!state) {
      return NextResponse.json(
        {
          configured: false,
          message: "HCLAW token address is not configured",
        },
        { status: 200 }
      );
    }

    if (!user) {
      return NextResponse.json({
        configured: true,
        state,
      });
    }

    const [capContext, lockState, points, claimable] = await Promise.all([
      getUserCapContext(user, agentId, network),
      getUserLockState(user, network),
      getUserPointsSummary(user),
      getClaimableSummary(user),
    ]);

    return NextResponse.json({
      configured: true,
      state,
      userContext: {
        cap: capContext,
        lock: lockState,
        points,
        claimable,
      },
    });
  } catch (error) {
    console.error("[HCLAW state] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch HCLAW state" },
      { status: 500 }
    );
  }
}
