import { createHash, randomUUID } from "crypto";
import { NextResponse } from "next/server";
import {
  depositToVault,
  withdrawFromVault,
  getAccountState,
  getSpotState,
  disableUnifiedAccountForOperator,
  isTestnet,
  provisionAgentWallet,
  getAgentHlBalance,
  getAgentHlState,
  sendUsdToAgent,
} from "@/lib/hyperliquid";
import { getAccountForAgent } from "@/lib/account-manager";
import { verifyApiKey, unauthorizedResponse } from "@/lib/auth";
import { type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activateAgent, getLifecycleState } from "@/lib/agent-lifecycle";
import { getAgent, updateAgent } from "@/lib/store";
import { getVaultAddressIfDeployed } from "@/lib/env";
import {
  recordMirroredExecutionAttribution,
  summarizeMirroredExecutionAttributions,
  type MirroredExecutionAttribution,
} from "@/lib/agentic-vault";
import type { CopytradeProviderAttribution } from "@/lib/vault";

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

type BridgeRun = {
  intent?: unknown;
  execution?: unknown;
  verification?: unknown;
  settlement?: unknown;
  updated_at: string;
};

type BridgeState = {
  runs: Map<string, BridgeRun>;
  receipt_to_intent: Map<string, string>;
  verification_to_intent: Map<string, string>;
  settlement_to_intent: Map<string, string>;
};

function getBridgeState(): BridgeState {
  const globals = globalThis as typeof globalThis & {
    __liquidclaw_bridge_state__?: BridgeState;
  };

  if (!globals.__liquidclaw_bridge_state__) {
    globals.__liquidclaw_bridge_state__ = {
      runs: new Map<string, BridgeRun>(),
      receipt_to_intent: new Map<string, string>(),
      verification_to_intent: new Map<string, string>(),
      settlement_to_intent: new Map<string, string>(),
    };
  }

  return globals.__liquidclaw_bridge_state__;
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isHash64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function parseProviderAttributions(value: unknown): CopytradeProviderAttribution[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item && typeof item === "object" ? item : null))
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => ({
      provider: {
        providerId:
          typeof item.provider_id === "string" ? item.provider_id.trim() : "",
        payoutAddress:
          typeof item.payout_address === "string" ? item.payout_address.trim() : "",
        displayName:
          typeof item.display_name === "string"
            ? item.display_name.trim()
            : undefined,
      },
      signalId: typeof item.signal_id === "string" ? item.signal_id.trim() : "",
      signalHash:
        typeof item.signal_hash === "string" ? item.signal_hash.trim() : "",
      attributionWeightBps:
        typeof item.attribution_weight_bps === "number"
          ? Math.max(0, Math.floor(item.attribution_weight_bps))
          : 0,
      feeSchedule: {
        fixedFeeBps:
          typeof item.fixed_fee_bps === "number"
            ? Math.max(0, Math.floor(item.fixed_fee_bps))
            : 0,
        performanceFeeBps:
          typeof item.performance_fee_bps === "number"
            ? Math.max(0, Math.floor(item.performance_fee_bps))
            : 0,
        maxFeeUsd:
          typeof item.max_fee_usd === "number"
            ? Math.max(0, item.max_fee_usd)
            : 0,
      },
    }))
    .filter(
      (item) =>
        item.provider.providerId.length > 0 &&
        item.signalId.length > 0 &&
        isHash64(item.signalHash) &&
        item.attributionWeightBps > 0
    );
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
              openPositions: state.positions.length,
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
            openPositions: 0,
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

      // ========== Operator HL balance (perp + spot) ==========
      case "operator-balance": {
        const pk = process.env.HYPERLIQUID_PRIVATE_KEY;
        if (!pk || pk === "your_operator_private_key_hex") {
          return NextResponse.json(
            { error: "HYPERLIQUID_PRIVATE_KEY not configured" },
            { status: 400 }
          );
        }

        const operatorAddress = privateKeyToAccount(pk as `0x${string}`).address as Address;

        try {
          const [perp, spot] = await Promise.all([
            getAccountState(operatorAddress),
            getSpotState(operatorAddress),
          ]);

          const balances = (spot as any)?.balances;
          const usdcRow =
            Array.isArray(balances)
              ? balances.find((b: any) => String(b?.coin || "").toUpperCase() === "USDC")
              : null;

          const spotUsdcTotal =
            usdcRow?.total ?? usdcRow?.balance ?? usdcRow?.available ?? usdcRow?.usdc ?? null;

          return NextResponse.json({
            operatorAddress,
            perp: {
              accountValue: perp.marginSummary?.accountValue || "0",
              availableBalance: perp.withdrawable || "0",
              marginUsed: perp.marginSummary?.totalMarginUsed || "0",
            },
            spot: {
              usdc: spotUsdcTotal ?? null,
              keys: Object.keys((spot as any) || {}),
            },
            network: isTestnet() ? "testnet" : "mainnet",
          });
        } catch (balError) {
          const msg = balError instanceof Error ? balError.message : String(balError);
          console.warn(`[Fund] operator-balance failed: ${msg.slice(0, 140)}`);
          return NextResponse.json({
            operatorAddress,
            perp: { accountValue: "0", availableBalance: "0", marginUsed: "0" },
            spot: { usdc: null, keys: [] as string[] },
            stale: true,
            error: msg.includes("timeout") ? "API timeout" : msg.slice(0, 140),
            network: isTestnet() ? "testnet" : "mainnet",
          });
        }
      }

      // ========== Disable unified account abstraction on operator ==========
      case "disable-unified": {
        try {
          const { operatorAddress, result } = await disableUnifiedAccountForOperator();
          return NextResponse.json({
            success: true,
            operatorAddress,
            abstraction: "disabled",
            result,
            network: isTestnet() ? "testnet" : "mainnet",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return NextResponse.json(
            { error: msg.slice(0, 200), network: isTestnet() ? "testnet" : "mainnet" },
            { status: 500 }
          );
        }
      }

      // ========== System status ==========
      case "status": {
        return NextResponse.json({
          network: isTestnet() ? "testnet" : "mainnet",
          configured: !!process.env.HYPERLIQUID_PRIVATE_KEY &&
            process.env.HYPERLIQUID_PRIVATE_KEY !== "your_agent_private_key_hex",
          vaultAddress: getVaultAddressIfDeployed(isTestnet() ? "testnet" : "mainnet"),
        });
      }

      // ========== WS-10 settlement receipt persistence ==========
      case "copytrade-settlement": {
        const intentId =
          typeof body.intent_id === "string" ? body.intent_id.trim() : "";
        const receiptId =
          typeof body.receipt_id === "string" ? body.receipt_id.trim() : "";
        const settlementId =
          typeof body.settlement_id === "string" && body.settlement_id.trim()
            ? body.settlement_id.trim()
            : `stl_${randomUUID()}`;
        const sourceSignalHash =
          typeof body.source_signal_hash === "string"
            ? body.source_signal_hash.trim()
            : "";
        const mirroredPnlUsd = parseUsdAmount(body.mirrored_pnl_usd) ?? 0;
        const revenueShareFeeUsd = parseUsdAmount(body.revenue_share_fee_usd) ?? 0;
        const providerAttributions = parseProviderAttributions(
          body.provider_attributions
        );

        if (!intentId || !receiptId || !isHash64(sourceSignalHash)) {
          return NextResponse.json(
            {
              error:
                "intent_id, receipt_id, and source_signal_hash (64-char lowercase hex) are required",
            },
            { status: 400 }
          );
        }

        const settledAt = new Date().toISOString();
        const settlementHash =
          typeof body.settlement_hash === "string" && isHash64(body.settlement_hash)
            ? body.settlement_hash
            : hashPayload({
                settlement_id: settlementId,
                intent_id: intentId,
                receipt_id: receiptId,
                source_signal_hash: sourceSignalHash,
                mirrored_pnl_usd: mirroredPnlUsd,
                revenue_share_fee_usd: revenueShareFeeUsd,
                provider_attributions: providerAttributions,
                settled_at: settledAt,
              });

        const attributionRecord: MirroredExecutionAttribution = {
          executionReceiptId: receiptId,
          settlementReceiptId: settlementId,
          sourceSignalHash,
          providerAttributions,
          mirroredPnlUsd,
          revenueShareFeeUsd,
          createdAt: Date.now(),
        };
        await recordMirroredExecutionAttribution(attributionRecord);

        const bridge = getBridgeState();
        const existing = bridge.runs.get(intentId);
        bridge.runs.set(intentId, {
          intent: existing?.intent,
          execution: existing?.execution,
          verification: existing?.verification,
          settlement: {
            settlement_id: settlementId,
            intent_id: intentId,
            receipt_id: receiptId,
            source_signal_hash: sourceSignalHash,
            settlement_hash: settlementHash,
            mirrored_pnl_usd: mirroredPnlUsd,
            revenue_share_fee_usd: revenueShareFeeUsd,
            provider_attributions: providerAttributions,
            settled_at: settledAt,
          },
          updated_at: settledAt,
        });
        bridge.settlement_to_intent.set(settlementId, intentId);

        return NextResponse.json({
          accepted: true,
          settlement: {
            settlement_id: settlementId,
            intent_id: intentId,
            receipt_id: receiptId,
            source_signal_hash: sourceSignalHash,
            settlement_hash: settlementHash,
            mirrored_pnl_usd: mirroredPnlUsd,
            revenue_share_fee_usd: revenueShareFeeUsd,
            provider_attributions: providerAttributions,
            settled_at: settledAt,
          },
        });
      }

      // ========== WS-10 mirrored PnL/fee attribution summary ==========
      case "copytrade-status": {
        const summary = await summarizeMirroredExecutionAttributions();
        return NextResponse.json({
          network: isTestnet() ? "testnet" : "mainnet",
          mirroredExecutions: summary.count,
          mirroredPnlUsd: summary.mirroredPnlUsd,
          revenueShareFeeUsd: summary.revenueShareFeeUsd,
          providerFeeById: summary.providerFeeById,
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
          { error: "Unknown action. Use: provision, fund, activate, agent-balance, agent-state, deposit, withdraw, balance, operator-balance, disable-unified, status" },
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
