import { NextResponse } from "next/server";
import { getAgent, updateAgent, deleteAgent, getTradeLogsForAgent } from "@/lib/store";
import { getAccountForAgent } from "@/lib/account-manager";
import { stopAgent } from "@/lib/agent-runner";
import { handleStatusChange, getLifecycleState } from "@/lib/agent-lifecycle";
import { getNetworkState } from "@/lib/network";

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

function parseNetwork(value: unknown): "testnet" | "mainnet" | undefined {
  if (value === "testnet" || value === "mainnet") return value;
  return undefined;
}

function getAgentDeploymentNetwork(agent: { autonomy?: { deploymentNetwork?: string } }): "testnet" | "mainnet" {
  const tagged = parseNetwork(agent.autonomy?.deploymentNetwork);
  // Legacy agents without a tag are treated as testnet to avoid leaking old test data into mainnet views.
  return tagged ?? "testnet";
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

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const agent = await getAgent(params.id);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const view = normalizeString(searchParams.get("view")) ?? "full";
    const requestedNetwork = parseNetwork(searchParams.get("network"));
    const currentNetwork = getNetworkState().monadTestnet ? "testnet" : "mainnet";
    const network = requestedNetwork ?? currentNetwork;
    const agentNetwork = getAgentDeploymentNetwork(agent);

    if (view === "summary") {
      if (agentNetwork !== network) {
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
      const isOwner = isOwnedByViewer(
        agent.telegram?.ownerPrivyId,
        agent.telegram?.ownerWalletAddress,
        viewerPrivyId,
        viewerWalletAddress
      );

      if (agent.status !== "active" && !isOwner) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
      }

      return NextResponse.json({
        agent: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          status: agent.status,
          createdAt: agent.createdAt,
          markets: agent.markets,
          maxLeverage: agent.maxLeverage,
          riskLevel: agent.riskLevel,
          totalPnl: agent.totalPnl,
          totalTrades: agent.totalTrades,
          winRate: agent.winRate,
          vaultTvlUsd: agent.vaultTvlUsd,
        },
        viewer: { isOwner },
      });
    }

    // Resolve hlAddress from account-manager (source of truth for HL wallet)
    const account = await getAccountForAgent(params.id);
    const resolvedAgent = { ...agent, hlAddress: account?.address ?? agent.hlAddress };

    const trades = await getTradeLogsForAgent(params.id);
    const lifecycle = getLifecycleState(params.id);

    return NextResponse.json({ agent: resolvedAgent, trades, lifecycle });
  } catch (error) {
    console.error("Get agent error:", error);
    return NextResponse.json(
      { error: "Failed to fetch agent" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    // Get current agent to check for status change
    const currentAgent = await getAgent(params.id);
    if (!currentAgent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const body = await request.json();
    const agent = await updateAgent(params.id, body);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // If status changed, trigger lifecycle management
    if (body.status && body.status !== currentAgent.status) {
      console.log(`[Agent ${params.id}] Status changed: ${currentAgent.status} -> ${body.status}`);
      try {
        await handleStatusChange(params.id, body.status);
      } catch (lifecycleError) {
        console.error(`[Agent ${params.id}] Lifecycle change failed:`, lifecycleError);
        // Don't fail the update if lifecycle fails
      }
    }

    const lifecycle = getLifecycleState(params.id);
    return NextResponse.json({ agent, lifecycle });
  } catch (error) {
    console.error("Update agent error:", error);
    return NextResponse.json(
      { error: "Failed to update agent" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    // Stop the agent runner if it's running
    try {
      await stopAgent(params.id);
    } catch {
      // Agent runner might not be running, that's OK
    }

    const deleted = await deleteAgent(params.id);
    if (!deleted) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, message: "Agent deleted" });
  } catch (error) {
    console.error("Delete agent error:", error);
    return NextResponse.json(
      { error: "Failed to delete agent" },
      { status: 500 }
    );
  }
}
