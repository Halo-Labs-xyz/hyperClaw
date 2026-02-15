/**
 * POST /api/agents/[id]/lifi-transfer-spot-to-perps
 *
 * Transfer USDC from agent's Hyperliquid spot account to perps margin.
 * Use after a LI.FI bridge completes — funds land in spot; this moves them to perps for trading.
 *
 * Body: { amount: number } — USD amount (1 = $1)
 *
 * Requires agent ownership (same as bridge-fund).
 */
import { NextResponse } from "next/server";
import { getAgent } from "@/lib/store";
import { transferSpotToPerps } from "@/lib/hyperliquid";
import { getAccountForAgent, isPKPAccount, getPrivateKeyForAgent } from "@/lib/account-manager";

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAddress(value: unknown): `0x${string}` | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return undefined;
  return trimmed.toLowerCase() as `0x${string}`;
}

function isOwnedByViewer(
  ownerPrivyId: string | undefined,
  ownerWalletAddress: string | undefined,
  viewerPrivyId: string | undefined,
  viewerWalletAddress: string | undefined
): boolean {
  if (viewerPrivyId && ownerPrivyId && ownerPrivyId === viewerPrivyId) return true;
  if (
    viewerWalletAddress &&
    ownerWalletAddress &&
    ownerWalletAddress.toLowerCase() === viewerWalletAddress.toLowerCase()
  )
    return true;
  return false;
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const agent = await getAgent(params.id);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const viewerPrivyId = normalizeString(
      request.headers.get("x-owner-privy-id") ?? request.headers.get("x-privy-user-id")
    );
    const viewerWalletAddress = normalizeAddress(
      request.headers.get("x-owner-wallet-address") ?? request.headers.get("x-wallet-address")
    );

    if (
      !isOwnedByViewer(
        agent.telegram?.ownerPrivyId,
        agent.telegram?.ownerWalletAddress,
        viewerPrivyId,
        viewerWalletAddress
      )
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const amount = typeof body.amount === "number" ? body.amount : parseFloat(String(body.amount ?? "0"));
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { error: "amount must be a positive number" },
        { status: 400 }
      );
    }

    const account = await getAccountForAgent(params.id);
    if (!account) {
      return NextResponse.json(
        { error: "Agent has no HL wallet — provision first via deposit" },
        { status: 400 }
      );
    }

    const { getExchangeClientForPKP, getExchangeClientForAgent } = await import("@/lib/hyperliquid");
    let client;
    if (await isPKPAccount(params.id)) {
      client = await getExchangeClientForPKP(params.id);
    } else {
      const pk = await getPrivateKeyForAgent(params.id);
      client = pk ? getExchangeClientForAgent(pk) : null;
    }

    if (!client) {
      return NextResponse.json(
        { error: "Could not get agent exchange client" },
        { status: 500 }
      );
    }

    const result = await transferSpotToPerps(amount, client);
    return NextResponse.json({
      success: true,
      amount,
      result,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg.slice(0, 220) }, { status: 500 });
  }
}
