import { NextResponse } from "next/server";
import { getAgents, createAgent, updateAgent } from "@/lib/store";
import { generateAgentWallet, provisionPKPWallet } from "@/lib/hyperliquid";
import { addAccount, getAccountForAgent, addPKPAccount } from "@/lib/account-manager";
import { getTotalDepositedUsd } from "@/lib/deposit-relay";
import { type Agent, type AgentConfig } from "@/lib/types";
import { getNetworkState } from "@/lib/network";
import { ensureAgentOnchainAttestation } from "@/lib/agent-attestation";

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

async function finalizeCreatedAgentResponse(
  agent: Agent,
  extras: Record<string, unknown> = {}
) {
  try {
    const attestationResult = await ensureAgentOnchainAttestation(agent.id, {
      reason: "agent_create",
    });

    return NextResponse.json(
      {
        agent: attestationResult.agent,
        ...extras,
        attestation: attestationResult.attestation,
      },
      { status: 201 }
    );
  } catch (attestationError) {
    console.error(`[AgentCreate] Attestation failed for ${agent.id}; pausing agent`, attestationError);
    try {
      await updateAgent(agent.id, { status: "paused" });
    } catch (pauseError) {
      console.error(`[AgentCreate] Failed to pause unattested agent ${agent.id}:`, pauseError);
    }
    throw attestationError;
  }
}

export async function GET(request: Request) {
  try {
    const agents = await getAgents();
    const { searchParams } = new URL(request.url);
    const view = normalizeString(searchParams.get("view")) ?? "full";
    const scope = normalizeString(searchParams.get("scope")) ?? "all";
    const requestedNetwork = parseNetwork(searchParams.get("network"));
    const currentNetwork = getNetworkState().monadTestnet ? "testnet" : "mainnet";
    const network = requestedNetwork ?? currentNetwork;
    const networkScopedAgents = agents.filter((a) => getAgentDeploymentNetwork(a) === network);
    const withDepositTvl = await Promise.all(
      networkScopedAgents.map(async (agent) => {
        try {
          const totalDepositedUsd = await getTotalDepositedUsd(agent.id);
          return { ...agent, vaultTvlUsd: totalDepositedUsd };
        } catch {
          return agent;
        }
      })
    );

    if (view === "explore") {
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

      const active = withDepositTvl.filter((a) => a.status === "active");
      const owned = withDepositTvl.filter((a) =>
        isOwnedByViewer(
          a.telegram?.ownerPrivyId,
          a.telegram?.ownerWalletAddress,
          viewerPrivyId,
          viewerWalletAddress
        )
      );
      const scoped = scope === "owned" ? owned : active;

      return NextResponse.json({
        agents: scoped.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          status: a.status,
          markets: a.markets,
          riskLevel: a.riskLevel,
          vaultTvlUsd: a.vaultTvlUsd,
        })),
      });
    }

    // Enrich each agent's hlAddress from account-manager (source of truth for HL wallet)
    const { getAccountForAgent } = await import("@/lib/account-manager");
    const enriched = await Promise.all(
      withDepositTvl.map(async (a) => {
        const account = await getAccountForAgent(a.id);
        const resolvedAddress = account?.address ?? a.hlAddress;
        return { ...a, hlAddress: resolvedAddress };
      })
    );
    return NextResponse.json({ agents: enriched });
  } catch (error) {
    console.error("Get agents error:", error);
    return NextResponse.json(
      { error: "Failed to fetch agents" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AgentConfig & {
      ownerWalletAddress?: string;
      network?: string;
    };

    // Normalize creator identity from payload and fallback headers.
    // This guarantees ownership metadata is attached across all create entrypoints.
    const ownerPrivyId =
      normalizeString(body.ownerPrivyId) ??
      normalizeString(
        request.headers.get("x-owner-privy-id") ??
        request.headers.get("x-privy-user-id")
      );
    const ownerWalletAddress =
      normalizeAddress(body.ownerWalletAddress) ??
      normalizeAddress(
        request.headers.get("x-owner-wallet-address") ??
        request.headers.get("x-wallet-address")
      );

    if (ownerPrivyId) {
      body.ownerPrivyId = ownerPrivyId;
    } else {
      delete body.ownerPrivyId;
    }

    if (ownerWalletAddress) {
      body.ownerWalletAddress = ownerWalletAddress;
    } else {
      delete body.ownerWalletAddress;
    }

    // Validate
    if (!body.name || !body.markets?.length) {
      return NextResponse.json(
        { error: "name and markets are required" },
        { status: 400 }
      );
    }

    // Ensure autonomy config with defaults
    if (!body.autonomy) {
      body.autonomy = {
        mode: "semi",
        aggressiveness: 50,
        maxTradesPerDay: 10,
        approvalTimeoutMs: 300000,
      };
    }
    const requestedNetwork =
      parseNetwork(body.network) ??
      parseNetwork(new URL(request.url).searchParams.get("network"));
    body.autonomy.deploymentNetwork =
      requestedNetwork ?? (getNetworkState().monadTestnet ? "testnet" : "mainnet");

    // Determine wallet mode: PKP or traditional
    const usePKP = process.env.USE_LIT_PKP === "true";
    let address: string;
    let agentIdTemp: string | null = null;

    if (usePKP) {
      // Use Lit Protocol PKP for secure distributed key management
      console.log("[AgentCreate] Creating PKP wallet...");
      
      // Generate temp agent ID to create PKP
      agentIdTemp = Math.random().toString(36).substring(7);
      
      try {
        const pkpResult = await provisionPKPWallet(agentIdTemp, {
          maxPositionSizeUsd: body.riskLevel === "conservative" ? 1000 : 
                              body.riskLevel === "aggressive" ? 20000 : 5000,
          allowedCoins: body.markets,
          maxLeverage: body.maxLeverage,
          requireStopLoss: body.stopLossPercent > 0,
        });
        
        if (!pkpResult) {
          console.warn("[AgentCreate] PKP creation failed, falling back to traditional");
          // Fallback to traditional
          const { privateKey, address: tradAddress } = generateAgentWallet();
          address = tradAddress;
          
          // Create agent and save key
          const agent = await createAgent(body, address as `0x${string}`);
          
          try {
            await addAccount({
              alias: `agent-${agent.id.slice(0, 8)}`,
              privateKey,
              agentId: agent.id,
              isDefault: false,
            });
          } catch (addAccountError) {
            console.error("[AgentCreate] Failed to persist fallback traditional key:", addAccountError);
          }
          
          console.log(`[AgentCreate] Traditional wallet ${address} saved for agent ${agent.id}`);
          return await finalizeCreatedAgentResponse(agent);
        }
        
        address = pkpResult.address;
        console.log(`[AgentCreate] PKP wallet ${address} created (token: ${pkpResult.pkpTokenId})`);
        
      } catch (pkpError) {
        console.error("[AgentCreate] PKP error:", pkpError);
        // Fallback to traditional
        const { privateKey, address: tradAddress } = generateAgentWallet();
        address = tradAddress;
        
        const agent = await createAgent(body, address as `0x${string}`);
        
        try {
          await addAccount({
            alias: `agent-${agent.id.slice(0, 8)}`,
            privateKey,
            agentId: agent.id,
            isDefault: false,
          });
        } catch (addAccountError) {
          console.error("[AgentCreate] Failed to persist traditional key after PKP error:", addAccountError);
        }
        
        console.log(`[AgentCreate] Traditional wallet ${address} saved (PKP failed)`);
        return await finalizeCreatedAgentResponse(agent);
      }
    } else {
      // Traditional: generate local wallet with encrypted private key
      const { privateKey, address: tradAddress } = generateAgentWallet();
      address = tradAddress;
      
      // Create the agent record first to get its ID
      const agent = await createAgent(body, address as `0x${string}`);

      // Store the HL key encrypted, linked to this agent
      try {
        const existing = await getAccountForAgent(agent.id);
        if (!existing) {
          await addAccount({
            alias: `agent-${agent.id.slice(0, 8)}`,
            privateKey,
            agentId: agent.id,
            isDefault: false,
          });
          console.log(`[AgentCreate] Traditional HL wallet ${address} saved for agent ${agent.id}`);
        }
      } catch (err) {
        console.error("[AgentCreate] Failed to save HL key:", err);
      }
      
      return await finalizeCreatedAgentResponse(agent);
    }

    // If we get here, PKP was successful - create agent with PKP address
    const agent = await createAgent(body, address as `0x${string}`);
    
    // Update the PKP account to link to the real agent ID
    if (agentIdTemp) {
      try {
        const { getAccountForAgent } = await import("@/lib/account-manager");
        const tempAccount = await getAccountForAgent(agentIdTemp);
        if (tempAccount && tempAccount.pkp) {
          // Re-add with correct agent ID
          await addPKPAccount({
            alias: `pkp-agent-${agent.id.slice(0, 8)}`,
            agentId: agent.id,
            pkpTokenId: tempAccount.pkp.tokenId,
            pkpPublicKey: tempAccount.pkp.publicKey,
            pkpEthAddress: tempAccount.pkp.ethAddress,
            constraints: tempAccount.pkp.constraints,
            litActionCid: tempAccount.pkp.litActionCid,
          });
          
          // Remove temp account
          const { removeAccount } = await import("@/lib/account-manager");
          await removeAccount(tempAccount.alias);
          
          console.log(`[AgentCreate] PKP account linked to agent ${agent.id}`);
        }
      } catch (linkPkpError) {
        // Agent is already created. Do not fail the request on post-create account-linking errors.
        console.error(`[AgentCreate] PKP post-create account link failed for agent ${agent.id}:`, linkPkpError);
      }
    }

    return await finalizeCreatedAgentResponse(agent, {
      walletType: "pkp",
      address,
    });
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Create agent error:", message, error);
    return NextResponse.json(
      {
        error: "Failed to create agent",
        detail: process.env.NODE_ENV === "development" ? message : undefined,
      },
      { status: 500 }
    );
  }
}
