/**
 * Mainnet bridge — LI.FI only.
 *
 * Hyperunit and deBridge have been removed. Users bridge directly via LI.FI
 * (Deposit tab "Bridge via LI.FI" flow). The relay provisions the agent's HL
 * wallet so LI.FI can use it as toAddress; the agent key handles spot→perps
 * transfer after funds arrive.
 *
 * This file provides stub exports for compatibility with deposit-relay.
 */

import type { Address, Hex } from "viem";

export type BridgeStatus = "submitted" | "pending" | "failed";

export interface BridgeExecution {
  provider: "lifi" | "none";
  status: BridgeStatus;
  destinationAddress?: Address;
  relayTxHash?: Hex;
  bridgeOrderId?: string;
  note?: string;
}

/**
 * Always false — we no longer use operator-funded bridge (Hyperunit/deBridge).
 * Users bridge via LI.FI directly.
 */
export function isMainnetBridgeEnabled(): boolean {
  return false;
}

/**
 * No-op. Users bridge via LI.FI to the agent's HL address.
 */
export async function bridgeDepositToHyperliquidAgent(_params: {
  hlAddress: Address;
  sourceToken: Address;
  sourceAmountRaw: bigint;
  sourceAmountRawLabel: string;
}): Promise<BridgeExecution> {
  return {
    provider: "none",
    status: "pending",
    note: "Bridge via LI.FI in the Deposit tab",
  };
}

/**
 * No-op. Withdrawals return MON from vault; no automatic USDC bridge to Monad.
 */
export async function bridgeWithdrawalToMonadUser(_params: {
  agentId: string;
  userAddress: Address;
  usdAmount: number;
}): Promise<BridgeExecution> {
  return {
    provider: "none",
    status: "pending",
    note: "Withdrawal returns MON from vault",
  };
}
