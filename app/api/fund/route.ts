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

function parseUsdAmount(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return parseFloat(value.toFixed(6));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return parseFloat(parsed.toFixed(6));
  }
  return undefined;
}

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
  const sameOriginRequest = (() => {
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");
    if (!origin || !host) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  })();

  if (!sameOriginRequest && !verifyApiKey(request)) return unauthorizedResponse();
  try {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const action = typeof body.action === "string" ? body.action : "status";
    const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
    const autoActivate = body.autoActivate !== false;
    const vaultAddress =
      typeof body.vaultAddress === "string" ? (body.vaultAddress as Address) : undefined;
    const user = typeof body.user === "string" ? (body.user as Address) : undefined;
    const amount = parseUsdAmount(body.amount);

    switch (action) {
      // ========== New: Provision agent wallet + fund + activate ==========
      case "provision": {
        if (!agentId) {
          return NextResponse.json(
            { error: "agentId required" },
            { status: 400 }
          );
        }
        const fundingAmount = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
        const result = await provisionAgentWallet(agentId, fundingAmount);

        // Sync agent.hlAddress to the provisioned wallet (source of truth)
        await updateAgent(agentId, { hlAddress: result.address });
        
        // Auto-activate the agent if funded and autoActivate is not false
        let lifecycleState = null;
        if (result.funded && autoActivate) {
          try {
            // Set agent to active status
            await updateAgent(agentId, { status: "active" });
            // Start the runner and register with AIP
            lifecycleState = await activateAgent(agentId);
            console.log(`[Fund] Agent ${agentId} auto-activated after provisioning`);
          } catch (activateError) {
            console.error(`[Fund] Failed to auto-activate agent:`, activateError);
          }
        }
        
        return NextResponse.json({
          success: true,
          action: "provision",
          agentId,
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
        if (!agentId || amount === undefined || !Number.isFinite(amount)) {
          return NextResponse.json(
            { error: "agentId and amount required" },
            { status: 400 }
          );
        }
        const account = await getAccountForAgent(agentId);
        if (!account) {
          return NextResponse.json(
            { error: "Agent has no HL wallet. Use 'provision' first." },
            { status: 404 }
          );
        }
        const fundingAmount = amount;
        const fundResult = await sendUsdToAgent(account.address, fundingAmount);
        
        // Auto-activate the agent if funded and autoActivate is not false
        let lifecycleState = null;
        const agent = await getAgent(agentId);
        if (agent && agent.status !== "active" && autoActivate) {
          try {
            // Set agent to active status
            await updateAgent(agentId, { status: "active" });
            // Start the runner and register with AIP
            lifecycleState = await activateAgent(agentId);
            console.log(`[Fund] Agent ${agentId} auto-activated after funding`);
          } catch (activateError) {
            console.error(`[Fund] Failed to auto-activate agent:`, activateError);
          }
        } else if (agent?.status === "active") {
          // Already active, just get current state
          lifecycleState = getLifecycleState(agentId);
        }
        
        return NextResponse.json({
          success: true,
          action: "fund",
          agentId,
          hlAddress: account.address,
          amount: fundingAmount,
          network: isTestnet() ? "testnet" : "mainnet",
          txResult: fundResult,
          lifecycle: lifecycleState,
        });
      }

      // ========== New: Agent HL balance ==========
      case "agent-balance": {
        if (!agentId) {
          return NextResponse.json(
            { error: "agentId required" },
            { status: 400 }
          );
        }
        const includePnl = body.includePnl === true;
        try {
          // When includePnl, use full state for holistic PnL (realized + unrealized)
          if (includePnl) {
            const state = await getAgentHlState(agentId);
            if (!state) {
              return NextResponse.json({
                agentId,
                hasWallet: false,
                network: isTestnet() ? "testnet" : "mainnet",
              });
            }
            return NextResponse.json({
              agentId,
              hasWallet: true,
              address: state.address,
              accountValue: state.accountValue,
              availableBalance: state.availableBalance,
              marginUsed: state.marginUsed,
              totalPnl: state.totalPnl,
              realizedPnl: state.realizedPnl,
              totalUnrealizedPnl: state.totalUnrealizedPnl,
              network: isTestnet() ? "testnet" : "mainnet",
            });
          }
          const balance = await getAgentHlBalance(agentId);
          if (!balance) {
            return NextResponse.json({
              agentId,
              hasWallet: false,
              network: isTestnet() ? "testnet" : "mainnet",
            });
          }
          return NextResponse.json({
            agentId,
            hasWallet: true,
            ...balance,
            network: isTestnet() ? "testnet" : "mainnet",
          });
        } catch (balError) {
          const msg = balError instanceof Error ? balError.message : String(balError);
          console.warn(`[Fund] agent-balance for ${agentId} failed: ${msg.slice(0, 100)}`);
          const account = await getAccountForAgent(agentId);
          return NextResponse.json({
            agentId,
            hasWallet: !!account,
            address: account?.address || null,
            accountValue: "0",
            availableBalance: "0",
            marginUsed: "0",
            stale: true,
            network: isTestnet() ? "testnet" : "mainnet",
          });
        }
      }

      // ========== Agent HL state with positions ==========
      case "agent-state": {
        if (!agentId) {
          return NextResponse.json(
            { error: "agentId required" },
            { status: 400 }
          );
        }
        try {
          const state = await getAgentHlState(agentId);
          if (!state) {
            return NextResponse.json({
              agentId,
              hasWallet: false,
              network: isTestnet() ? "testnet" : "mainnet",
            });
          }
          return NextResponse.json({
            agentId,
            hasWallet: true,
            ...state,
            network: isTestnet() ? "testnet" : "mainnet",
          });
        } catch (stateError) {
          // Return partial data on timeout instead of 500
          const msg = stateError instanceof Error ? stateError.message : String(stateError);
          console.warn(`[Fund] agent-state for ${agentId} failed: ${msg.slice(0, 100)}`);
          
          // Try to at least get wallet address
          const account = await getAccountForAgent(agentId);
          return NextResponse.json({
            agentId,
            hasWallet: !!account,
            address: account?.address || null,
            accountValue: "0",
            availableBalance: "0",
            marginUsed: "0",
            totalUnrealizedPnl: 0,
            positions: [],
            stale: true,
            error: msg.includes("timeout") ? "API timeout - data may be stale" : msg.slice(0, 100),
            network: isTestnet() ? "testnet" : "mainnet",
          });
        }
      }

      // ========== HL native vault deposit ==========
      case "deposit": {
        if (!vaultAddress || amount === undefined || !Number.isFinite(amount)) {
          return NextResponse.json(
            { error: "vaultAddress and amount required" },
            { status: 400 }
          );
        }
        const depositAmount = amount;
        const result = await depositToVault(vaultAddress, depositAmount);
        return NextResponse.json({
          success: true,
          action: "deposit",
          vaultAddress,
          amount: depositAmount,
          result,
        });
      }

      // ========== HL native vault withdraw ==========
      case "withdraw": {
        if (!vaultAddress || amount === undefined || !Number.isFinite(amount)) {
          return NextResponse.json(
            { error: "vaultAddress and amount required" },
            { status: 400 }
          );
        }
        const withdrawAmount = amount;
        const result = await withdrawFromVault(vaultAddress, withdrawAmount);
        return NextResponse.json({
          success: true,
          action: "withdraw",
          vaultAddress,
          amount: withdrawAmount,
          result,
        });
      }

      // ========== Generic HL balance ==========
      case "balance": {
        if (!user) {
          return NextResponse.json(
            { error: "user address required" },
            { status: 400 }
          );
        }
        try {
          const state = await getAccountState(user);
          return NextResponse.json({
            user,
            accountValue: state.marginSummary?.accountValue || "0",
            availableBalance: state.withdrawable || "0",
            marginUsed: state.marginSummary?.totalMarginUsed || "0",
            network: isTestnet() ? "testnet" : "mainnet",
          });
        } catch (balError) {
          const msg = balError instanceof Error ? balError.message : String(balError);
          console.warn(`[Fund] balance for ${user} failed: ${msg.slice(0, 100)}`);
          return NextResponse.json({
            user,
            accountValue: "0",
            availableBalance: "0",
            marginUsed: "0",
            stale: true,
            error: msg.includes("timeout") ? "API timeout" : msg.slice(0, 100),
            network: isTestnet() ? "testnet" : "mainnet",
          });
        }
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
        if (!agentId) {
          return NextResponse.json(
            { error: "agentId required" },
            { status: 400 }
          );
        }
        
        const agentToActivate = await getAgent(agentId);
        if (!agentToActivate) {
          return NextResponse.json(
            { error: "Agent not found" },
            { status: 404 }
          );
        }
        
        // Check if agent has wallet with balance (allow activation even if API times out)
        let agentBalance;
        try {
          agentBalance = await getAgentHlBalance(agentId);
        } catch {
          console.warn(`[Fund] Balance check for ${agentId} timed out, proceeding with activation`);
        }
        if (agentBalance && parseFloat(agentBalance.accountValue || "0") < 1) {
          return NextResponse.json(
            { error: "Agent needs at least $1 balance to activate. Fund the agent first." },
            { status: 400 }
          );
        }
        
        // Update status if needed
        if (agentToActivate.status !== "active") {
          await updateAgent(agentId, { status: "active" });
        }
        
        // Activate lifecycle (start runner + register AIP)
        const lifecycleState = await activateAgent(agentId);
        
        return NextResponse.json({
          success: true,
          action: "activate",
          agentId,
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
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Fund] API error: ${msg.slice(0, 200)}`);
    return NextResponse.json(
      { error: msg.includes("timeout") ? "Hyperliquid API timeout" : "Fund operation failed" },
      { status: 500 }
    );
  }
}
