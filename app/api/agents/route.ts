import { NextResponse } from "next/server";
import { getAgents, createAgent } from "@/lib/store";
import { generateAgentWallet } from "@/lib/hyperliquid";
import { addAccount, getAccountForAgent } from "@/lib/account-manager";
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

    // Generate a dedicated Hyperliquid wallet for this agent
    // AND persist the key in account-manager so the runner can sign trades
    const { privateKey, address } = generateAgentWallet();

    // Create the agent record first to get its ID
    const agent = await createAgent(body, address);

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
        console.log(`[AgentCreate] HL wallet ${address} saved for agent ${agent.id}`);
      }
    } catch (err) {
      console.error("[AgentCreate] Failed to save HL key:", err);
      // Agent is created but key save failed — provisioning on deposit will still work
    }

    return NextResponse.json({ agent }, { status: 201 });
  } catch (error) {
    console.error("Create agent error:", error);
    return NextResponse.json(
      { error: "Failed to create agent" },
      { status: 500 }
    );
  }
}
