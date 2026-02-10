import { NextResponse } from "next/server";
import { getAgents, createAgent } from "@/lib/store";
import { generateAgentWallet, provisionPKPWallet } from "@/lib/hyperliquid";
import { addAccount, getAccountForAgent, addPKPAccount } from "@/lib/account-manager";
import { type AgentConfig } from "@/lib/types";

export async function GET() {
  try {
    const agents = await getAgents();
    return NextResponse.json({ agents });
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
    const body = (await request.json()) as AgentConfig;

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
          
          await addAccount({
            alias: `agent-${agent.id.slice(0, 8)}`,
            privateKey,
            agentId: agent.id,
            isDefault: false,
          });
          
          console.log(`[AgentCreate] Traditional wallet ${address} saved for agent ${agent.id}`);
          return NextResponse.json({ agent }, { status: 201 });
        }
        
        address = pkpResult.address;
        console.log(`[AgentCreate] PKP wallet ${address} created (token: ${pkpResult.pkpTokenId})`);
        
      } catch (pkpError) {
        console.error("[AgentCreate] PKP error:", pkpError);
        // Fallback to traditional
        const { privateKey, address: tradAddress } = generateAgentWallet();
        address = tradAddress;
        
        const agent = await createAgent(body, address as `0x${string}`);
        
        await addAccount({
          alias: `agent-${agent.id.slice(0, 8)}`,
          privateKey,
          agentId: agent.id,
          isDefault: false,
        });
        
        console.log(`[AgentCreate] Traditional wallet ${address} saved (PKP failed)`);
        return NextResponse.json({ agent }, { status: 201 });
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
      
      return NextResponse.json({ agent }, { status: 201 });
    }

    // If we get here, PKP was successful - create agent with PKP address
    const agent = await createAgent(body, address as `0x${string}`);
    
    // Update the PKP account to link to the real agent ID
    if (agentIdTemp) {
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
    }

    return NextResponse.json({ 
      agent,
      walletType: "pkp",
      address,
    }, { status: 201 });
    
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
