import { NextResponse } from "next/server";
import { getAgent, updateAgent, getTradeLogsForAgent } from "@/lib/store";
import { getAccountForAgent, encrypt } from "@/lib/account-manager";
import { getTotalDepositedUsd } from "@/lib/deposit-relay";
import { stopAgent } from "@/lib/agent-runner";
import { handleStatusChange, getLifecycleState } from "@/lib/agent-lifecycle";
import { getNetworkState } from "@/lib/network";
import type { TradeLog } from "@/lib/types";

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

/** Strip encrypted key from agent before returning to client. */
function sanitizeAgentForResponse<T extends { aiApiKey?: { provider: string; encryptedKey?: string } }>(agent: T): T {
  if (!agent?.aiApiKey) return agent;
  return {
    ...agent,
    aiApiKey: { provider: agent.aiApiKey.provider },
  } as T;
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
    const baseAgent = await getAgent(params.id);
    const agent =
      baseAgent &&
      ({ ...baseAgent, vaultTvlUsd: await getTotalDepositedUsd(baseAgent.id).catch(() => baseAgent.vaultTvlUsd) });
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

    // Resolve hlAddress from account-manager (source of truth for HL wallet).
    // This backend can fail independently (e.g., S3 credentials), so degrade gracefully.
    let resolvedAgent = agent;
    try {
      const account = await getAccountForAgent(params.id);
      resolvedAgent = { ...agent, hlAddress: account?.address ?? agent.hlAddress };
    } catch (accountError) {
      console.warn(`[Agent ${params.id}] Failed to resolve HL account:`, accountError);
    }

    // Trade history backend can also fail independently; return agent details with empty trades.
    let trades: TradeLog[] = [];
    try {
      trades = await getTradeLogsForAgent(params.id);
    } catch (tradesError) {
      console.warn(`[Agent ${params.id}] Failed to load trade logs:`, tradesError);
    }
    const lifecycle = getLifecycleState(params.id);

    return NextResponse.json({
      agent: sanitizeAgentForResponse(resolvedAgent),
      trades,
      lifecycle,
    });
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

    const body = await request.json() as Record<string, unknown>;

    // Process aiApiKey: encrypt raw value before storing, or clear when null
    const updates = { ...body } as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(body, "aiApiKey")) {
      const raw = body.aiApiKey as { provider?: string; value?: string } | null | undefined;
      if (raw && typeof raw === "object" && raw.provider && raw.value) {
        const provider = raw.provider === "openai" ? "openai" : "anthropic";
        try {
          updates.aiApiKey = { provider, encryptedKey: encrypt(raw.value.trim()) };
        } catch (e) {
          console.error(`[Agent ${params.id}] Failed to encrypt AI API key:`, e);
          return NextResponse.json({ error: "Failed to save API key" }, { status: 500 });
        }
      } else {
        updates.aiApiKey = undefined;
      }
    }

    const agent = await updateAgent(params.id, updates);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // If status changed, trigger lifecycle management
    const newStatus = body.status as "active" | "paused" | "stopped" | undefined;
    if (newStatus && ["active", "paused", "stopped"].includes(newStatus) && newStatus !== currentAgent.status) {
      console.log(`[Agent ${params.id}] Status changed: ${currentAgent.status} -> ${newStatus}`);
      try {
        await handleStatusChange(params.id, newStatus);
      } catch (lifecycleError) {
        console.error(`[Agent ${params.id}] Lifecycle change failed:`, lifecycleError);
        if (newStatus === "active") {
          try {
            await updateAgent(params.id, { status: currentAgent.status });
          } catch (revertError) {
            console.error(`[Agent ${params.id}] Failed to revert status after activation error:`, revertError);
          }

          return NextResponse.json(
            {
              error: "Failed to activate agent because lifecycle registration failed",
              detail:
                lifecycleError instanceof Error
                  ? lifecycleError.message
                  : "Unknown lifecycle activation error",
            },
            { status: 409 }
          );
        }
      }
    }

    const lifecycle = getLifecycleState(params.id);
    return NextResponse.json({
      agent: sanitizeAgentForResponse(agent),
      lifecycle,
    });
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
    const currentAgent = await getAgent(params.id);
    if (!currentAgent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Soft-delete behavior: pause instead of deleting so history/config remain accessible.
    if (currentAgent.status !== "paused") {
      try {
        await stopAgent(params.id);
      } catch {
        // runner may already be stopped
      }
      await updateAgent(params.id, { status: "paused" });
      try {
        await handleStatusChange(params.id, "paused");
      } catch {
        // status was updated; lifecycle catch-up can happen on next cycle
      }
    }

    return NextResponse.json({
      success: true,
      message: "Agent paused. Delete is disabled to preserve agent data.",
    });
  } catch (error) {
    console.error("Delete agent error:", error);
    return NextResponse.json(
      { error: "Failed to delete agent" },
      { status: 500 }
    );
  }
}
