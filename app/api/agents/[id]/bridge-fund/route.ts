import { NextResponse } from "next/server";
import { parseEther, zeroAddress } from "viem";
import { getAgent, updateAgent } from "@/lib/store";
import { provisionAgentWallet } from "@/lib/hyperliquid";
import { bridgeDepositToHyperliquidAgent, isMainnetBridgeEnabled } from "@/lib/mainnet-bridge";

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
  ) return true;
  return false;
}

function parseMonAmount(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value.toString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+(\.\d{1,18})?$/.test(trimmed)) return undefined;
    if (Number(trimmed) <= 0) return undefined;
    return trimmed;
  }
  return undefined;
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    if (process.env.ENABLE_EMERGENCY_BRIDGE_FUND !== "true") {
      return NextResponse.json(
        { error: "Emergency bridge funding is disabled" },
        { status: 403 }
      );
    }

    if (!isMainnetBridgeEnabled()) {
      return NextResponse.json(
        { error: "Mainnet bridge is disabled" },
        { status: 400 }
      );
    }

    const agent = await getAgent(params.id);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const viewerPrivyId =
      normalizeString(
        request.headers.get("x-owner-privy-id") ??
          request.headers.get("x-privy-user-id")
      );
    const viewerWalletAddress =
      normalizeAddress(
        request.headers.get("x-owner-wallet-address") ??
          request.headers.get("x-wallet-address")
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
    const monAmount = parseMonAmount(body.monAmount);
    if (!monAmount) {
      return NextResponse.json(
        { error: "monAmount must be a positive MON amount" },
        { status: 400 }
      );
    }

    const wallet = await provisionAgentWallet(params.id, 0);
    if (agent.hlAddress !== wallet.address) {
      await updateAgent(params.id, { hlAddress: wallet.address });
    }

    const bridge = await bridgeDepositToHyperliquidAgent({
      hlAddress: wallet.address,
      sourceToken: zeroAddress,
      sourceAmountRaw: parseEther(monAmount),
      sourceAmountRawLabel: parseEther(monAmount).toString(),
    });

    return NextResponse.json({
      success: bridge.status === "submitted",
      agentId: params.id,
      hlAddress: wallet.address,
      monAmount,
      bridgeProvider: bridge.provider,
      bridgeStatus: bridge.status,
      bridgeDestination: bridge.destinationAddress ?? null,
      bridgeTxHash: bridge.relayTxHash ?? null,
      bridgeOrderId: bridge.bridgeOrderId ?? null,
      bridgeNote: bridge.note ?? null,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: msg.slice(0, 220) },
      { status: 500 }
    );
  }
}

