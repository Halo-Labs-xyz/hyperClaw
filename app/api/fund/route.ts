import { NextResponse } from "next/server";
import {
  depositToVault,
  withdrawFromVault,
  getAccountState,
  isTestnet,
  provisionAgentWallet,
  getAgentHlBalance,
  getAgentHlState,
  sendUsdToAgent,
} from "@/lib/hyperliquid";
import { getAccountForAgent } from "@/lib/account-manager";
import { verifyApiKey, unauthorizedResponse } from "@/lib/auth";
import { type Address } from "viem";
import { activateAgent, getLifecycleState } from "@/lib/agent-lifecycle";
import { getAgent, updateAgent } from "@/lib/store";

/**
 * POST /api/fund
 *
 * Fund an agent's Hyperliquid account.
 *
 * Actions:
 *   { action: "provision", agentId: "abc", amount: 100 }
 *     -> Creates HL wallet for agent + funds it with $amount USDC from operator
 *
 *   { action: "fund", agentId: "abc", amount: 50 }
 *     -> Sends $amount USDC to existing agent HL wallet from operator
 *
 *   { action: "agent-balance", agentId: "abc" }
 *     -> Returns agent's HL account balance
 *
 *   { action: "deposit", vaultAddress: "0x...", amount: 1000 }
 *     -> Deposit into HL native vault
 *
 *   { action: "withdraw", vaultAddress: "0x...", amount: 500 }
 *     -> Withdraw from HL native vault
 *
 *   { action: "balance", user: "0x..." }
 *     -> HL account balance for any address
 *
 *   { action: "status" }
 *     -> System status info
 */
export async function POST(request: Request) {
  if (!verifyApiKey(request)) return unauthorizedResponse();
  try {
    const body = await request.json();
    const action = body.action || "status";

    switch (action) {
      // ========== New: Provision agent wallet + fund + activate ==========
      case "provision": {
        if (!body.agentId) {
          return NextResponse.json(
            { error: "agentId required" },
            { status: 400 }
          );
        }
        const amount = body.amount || 0;
        const result = await provisionAgentWallet(body.agentId, amount);
        
        // Auto-activate the agent if funded and autoActivate is not false
        let lifecycleState = null;
        if (result.funded && body.autoActivate !== false) {
          try {
            // Set agent to active status
            await updateAgent(body.agentId, { status: "active" });
            // Start the runner and register with AIP
            lifecycleState = await activateAgent(body.agentId);
            console.log(`[Fund] Agent ${body.agentId} auto-activated after provisioning`);
          } catch (activateError) {
            console.error(`[Fund] Failed to auto-activate agent:`, activateError);
          }
        }
        
        return NextResponse.json({
          success: true,
          action: "provision",
          agentId: body.agentId,
          hlAddress: result.address,
          funded: result.funded,
          fundedAmount: result.fundedAmount,
          network: isTestnet() ? "testnet" : "mainnet",
          txResult: result.txResult,
          lifecycle: lifecycleState,
        });
      }

      // ========== New: Fund existing agent wallet + auto-activate ==========
      case "fund": {
        if (!body.agentId || !body.amount) {
          return NextResponse.json(
            { error: "agentId and amount required" },
            { status: 400 }
          );
        }
        const account = await getAccountForAgent(body.agentId);
        if (!account) {
          return NextResponse.json(
            { error: "Agent has no HL wallet. Use 'provision' first." },
            { status: 404 }
          );
        }
        const fundResult = await sendUsdToAgent(account.address, body.amount);
        
        // Auto-activate the agent if funded and autoActivate is not false
        let lifecycleState = null;
        const agent = await getAgent(body.agentId);
        if (agent && agent.status !== "active" && body.autoActivate !== false) {
          try {
            // Set agent to active status
            await updateAgent(body.agentId, { status: "active" });
            // Start the runner and register with AIP
            lifecycleState = await activateAgent(body.agentId);
            console.log(`[Fund] Agent ${body.agentId} auto-activated after funding`);
          } catch (activateError) {
            console.error(`[Fund] Failed to auto-activate agent:`, activateError);
          }
        } else if (agent?.status === "active") {
          // Already active, just get current state
          lifecycleState = getLifecycleState(body.agentId);
        }
        
        return NextResponse.json({
          success: true,
          action: "fund",
          agentId: body.agentId,
          hlAddress: account.address,
          amount: body.amount,
          network: isTestnet() ? "testnet" : "mainnet",
          txResult: fundResult,
          lifecycle: lifecycleState,
        });
      }

      // ========== New: Agent HL balance ==========
      case "agent-balance": {
        if (!body.agentId) {
          return NextResponse.json(
            { error: "agentId required" },
            { status: 400 }
          );
        }
        const balance = await getAgentHlBalance(body.agentId);
        if (!balance) {
          return NextResponse.json({
            agentId: body.agentId,
            hasWallet: false,
            network: isTestnet() ? "testnet" : "mainnet",
          });
        }
        return NextResponse.json({
          agentId: body.agentId,
          hasWallet: true,
          ...balance,
          network: isTestnet() ? "testnet" : "mainnet",
        });
      }

      // ========== Agent HL state with positions ==========
      case "agent-state": {
        if (!body.agentId) {
          return NextResponse.json(
            { error: "agentId required" },
            { status: 400 }
          );
        }
        const state = await getAgentHlState(body.agentId);
        if (!state) {
          return NextResponse.json({
            agentId: body.agentId,
            hasWallet: false,
            network: isTestnet() ? "testnet" : "mainnet",
          });
        }
        return NextResponse.json({
          agentId: body.agentId,
          hasWallet: true,
          ...state,
          network: isTestnet() ? "testnet" : "mainnet",
        });
      }

      // ========== HL native vault deposit ==========
      case "deposit": {
        if (!body.vaultAddress || !body.amount) {
          return NextResponse.json(
            { error: "vaultAddress and amount required" },
            { status: 400 }
          );
        }
        const result = await depositToVault(
          body.vaultAddress as Address,
          body.amount
        );
        return NextResponse.json({
          success: true,
          action: "deposit",
          vaultAddress: body.vaultAddress,
          amount: body.amount,
          result,
        });
      }

      // ========== HL native vault withdraw ==========
      case "withdraw": {
        if (!body.vaultAddress || !body.amount) {
          return NextResponse.json(
            { error: "vaultAddress and amount required" },
            { status: 400 }
          );
        }
        const result = await withdrawFromVault(
          body.vaultAddress as Address,
          body.amount
        );
        return NextResponse.json({
          success: true,
          action: "withdraw",
          vaultAddress: body.vaultAddress,
          amount: body.amount,
          result,
        });
      }

      // ========== Generic HL balance ==========
      case "balance": {
        const user = body.user as Address;
        if (!user) {
          return NextResponse.json(
            { error: "user address required" },
            { status: 400 }
          );
        }
        const state = await getAccountState(user);
        return NextResponse.json({
          user,
          accountValue: state.marginSummary?.accountValue || "0",
          availableBalance: state.withdrawable || "0",
          marginUsed: state.marginSummary?.totalMarginUsed || "0",
          network: isTestnet() ? "testnet" : "mainnet",
        });
      }

      // ========== System status ==========
      case "status": {
        return NextResponse.json({
          network: isTestnet() ? "testnet" : "mainnet",
          configured: !!process.env.HYPERLIQUID_PRIVATE_KEY &&
            process.env.HYPERLIQUID_PRIVATE_KEY !== "your_agent_private_key_hex",
          vaultAddress: process.env.NEXT_PUBLIC_VAULT_ADDRESS || null,
        });
      }

      // ========== Activate agent (start runner + register AIP) ==========
      case "activate": {
        if (!body.agentId) {
          return NextResponse.json(
            { error: "agentId required" },
            { status: 400 }
          );
        }
        
        const agentToActivate = await getAgent(body.agentId);
        if (!agentToActivate) {
          return NextResponse.json(
            { error: "Agent not found" },
            { status: 404 }
          );
        }
        
        // Check if agent has wallet with balance
        const agentBalance = await getAgentHlBalance(body.agentId);
        if (!agentBalance || parseFloat(agentBalance.accountValue || "0") < 1) {
          return NextResponse.json(
            { error: "Agent needs at least $1 balance to activate. Fund the agent first." },
            { status: 400 }
          );
        }
        
        // Update status if needed
        if (agentToActivate.status !== "active") {
          await updateAgent(body.agentId, { status: "active" });
        }
        
        // Activate lifecycle (start runner + register AIP)
        const lifecycleState = await activateAgent(body.agentId);
        
        return NextResponse.json({
          success: true,
          action: "activate",
          agentId: body.agentId,
          status: "active",
          lifecycle: lifecycleState,
          network: isTestnet() ? "testnet" : "mainnet",
        });
      }

      default:
        return NextResponse.json(
          { error: "Unknown action. Use: provision, fund, activate, agent-balance, agent-state, deposit, withdraw, balance, status" },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error("Fund API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Fund operation failed" },
      { status: 500 }
    );
  }
}
