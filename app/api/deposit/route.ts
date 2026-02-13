import { NextResponse } from "next/server";
import {
  processVaultTx,
  getDepositsForAgent,
  getDepositsForUser,
  getUserSharePercent,
  getVaultTvlOnChain,
} from "@/lib/deposit-relay";
import { type Address } from "viem";
import { getUserCapContext } from "@/lib/hclaw-policy";
import { getVaultAddressIfDeployed } from "@/lib/env";

type MonadNetwork = "mainnet" | "testnet";

function parseNetwork(value: unknown): MonadNetwork | undefined {
  if (value === "mainnet" || value === "testnet") return value;
  return undefined;
}

function summarizeVaultConfig() {
  const mainnet = getVaultAddressIfDeployed("mainnet");
  const testnet = getVaultAddressIfDeployed("testnet");
  const fallback = getVaultAddressIfDeployed();
  return { mainnet, testnet, fallback };
}

/**
 * POST /api/deposit
 *
 * Confirm a Monad vault transaction (deposit or withdrawal).
 * Called by the frontend after tx confirmation to sync relay/accounting.
 *
 * Body: { txHash: string }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.txHash || typeof body.txHash !== "string") {
      return NextResponse.json(
        { error: "txHash required" },
        { status: 400 }
      );
    }

    if (!/^0x[a-fA-F0-9]{64}$/.test(body.txHash)) {
      return NextResponse.json(
        { error: "txHash must be a 0x-prefixed 32-byte hash" },
        { status: 400 }
      );
    }

    const result = await processVaultTx(body.txHash, { network: parseNetwork(body.network) });

    if (!result) {
      return NextResponse.json(
        {
          success: false,
          code: "NO_VAULT_EVENT",
          error: "No vault event found in transaction",
          detail: {
            txHash: body.txHash,
            requestedNetwork: parseNetwork(body.network) ?? null,
            vaultConfig: summarizeVaultConfig(),
          },
        },
        { status: 200 }
      );
    }

    if (result.eventType === "withdrawal") {
      return NextResponse.json({
        success: true,
        eventType: "withdrawal",
        withdrawal: {
          agentId: result.withdrawal.agentId,
          user: result.withdrawal.user,
          shares: result.withdrawal.shares,
          monAmount: result.withdrawal.monAmount,
          settlementUsd: result.withdrawal.settlementUsd ?? null,
          vaultUsdValue: result.withdrawal.vaultUsdValue ?? null,
          hlAccountValueUsd: result.withdrawal.hlAccountValueUsd ?? null,
          sharePercent: result.withdrawal.sharePercent ?? null,
          pnlUsd: result.withdrawal.pnlUsd ?? null,
          pnlStatus: result.withdrawal.pnlStatus ?? null,
          settlementMode: result.withdrawal.settlementMode ?? null,
          txHash: result.withdrawal.txHash,
          relayed: result.withdrawal.relayed,
          bridgeProvider: result.withdrawal.bridgeProvider ?? null,
          bridgeStatus: result.withdrawal.bridgeStatus ?? null,
          bridgeDestination: result.withdrawal.bridgeDestination ?? null,
          bridgeTxHash: result.withdrawal.bridgeTxHash ?? null,
          bridgeOrderId: result.withdrawal.bridgeOrderId ?? null,
          bridgeNote: result.withdrawal.bridgeNote ?? null,
        },
      });
    }

    const record = result.deposit;
    const capContext =
      record.userCapUsd !== undefined
        ? {
            tier: record.lockTier ?? 0,
            boostBps: record.boostBps ?? 10_000,
            rebateBps: record.rebateBps ?? 0,
            boostedCapUsd: record.userCapUsd ?? 0,
            capRemainingUsd: record.userCapRemainingUsd ?? 0,
          }
        : await getUserCapContext(
            record.user,
            record.agentId,
            parseNetwork(body.network)
          );

    return NextResponse.json({
      success: true,
      eventType: "deposit",
      deposit: {
        agentId: record.agentId,
        user: record.user,
        token: record.token,
        amount: record.amount,
        shares: record.shares,
        usdValue: record.usdValue,
        monRate: record.monRate,
        relayFee: record.relayFee,
        txHash: record.txHash,
        hlWalletAddress: record.hlWalletAddress || null,
        hlFunded: record.hlFunded || false,
        hlFundedAmount: record.hlFundedAmount || 0,
        bridgeProvider: record.bridgeProvider ?? null,
        bridgeStatus: record.bridgeStatus ?? null,
        bridgeDestination: record.bridgeDestination ?? null,
        bridgeTxHash: record.bridgeTxHash ?? null,
        bridgeOrderId: record.bridgeOrderId ?? null,
        bridgeNote: record.bridgeNote ?? null,
        lockTier: capContext.tier,
        boostBps: capContext.boostBps,
        rebateBps: capContext.rebateBps,
        userCapUsd: capContext.boostedCapUsd,
        userCapRemainingUsd: capContext.capRemainingUsd,
        pointsActivity: record.pointsActivity ?? null,
      },
    });
  } catch (error) {
    console.error("Deposit confirmation error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process deposit" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/deposit
 *
 * Query deposit info.
 *
 * Params:
 *   ?agentId=xxx - Get deposits for an agent
 *   ?user=0x... - Get deposits for a user
 *   ?agentId=xxx&user=0x... - Get user's share percent in agent vault
 *   ?agentId=xxx&tvl=true - Get on-chain TVL for agent
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agentId");
  const user = searchParams.get("user") as Address | null;
  const tvl = searchParams.get("tvl");
  const network = parseNetwork(searchParams.get("network"));

  try {
    // TVL query
    if (agentId && tvl === "true") {
      const tvlUsd = await getVaultTvlOnChain(agentId, network);
      return NextResponse.json({ agentId, tvlUsd });
    }

    // Share percent query
    if (agentId && user) {
      const sharePercent = await getUserSharePercent(agentId, user, network);
      const userDeposits = await getDepositsForUser(user);
      const deposits = userDeposits.filter(
        (d) => d.agentId === agentId
      );
      return NextResponse.json({
        agentId,
        user,
        sharePercent,
        deposits,
      });
    }

    // Agent deposits
    if (agentId) {
      const deposits = await getDepositsForAgent(agentId);
      const tvlUsd = await getVaultTvlOnChain(agentId, network);
      return NextResponse.json({ agentId, tvlUsd, deposits });
    }

    // User deposits
    if (user) {
      const deposits = await getDepositsForUser(user);
      return NextResponse.json({ user, deposits });
    }

    return NextResponse.json(
      { error: "Provide agentId or user param" },
      { status: 400 }
    );
  } catch (error) {
    console.error("Deposit query error:", error);
    return NextResponse.json(
      { error: "Failed to query deposits" },
      { status: 500 }
    );
  }
}
