import { NextResponse } from "next/server";
import {
  processDepositTx,
  getDepositsForAgent,
  getDepositsForUser,
  getUserSharePercent,
  getVaultTvlOnChain,
} from "@/lib/deposit-relay";
import { type Address } from "viem";

/**
 * POST /api/deposit
 *
 * Confirm a Monad vault deposit transaction.
 * Called by the frontend after the user's deposit tx is confirmed on-chain.
 *
 * Body: { txHash: string }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.txHash) {
      return NextResponse.json(
        { error: "txHash required" },
        { status: 400 }
      );
    }

    const record = await processDepositTx(body.txHash);

    if (!record) {
      return NextResponse.json(
        { error: "No deposit event found in transaction" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
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

  try {
    // TVL query
    if (agentId && tvl === "true") {
      const tvlUsd = await getVaultTvlOnChain(agentId);
      return NextResponse.json({ agentId, tvlUsd });
    }

    // Share percent query
    if (agentId && user) {
      const sharePercent = await getUserSharePercent(agentId, user);
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
      const tvlUsd = await getVaultTvlOnChain(agentId);
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
