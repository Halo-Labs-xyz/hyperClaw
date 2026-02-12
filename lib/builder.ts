/**
 * Hyperliquid Builder Code Integration
 * 
 * Builder codes allow HyperClaw to earn fees on trades executed through the platform.
 * Users must approve the builder fee once before trading.
 */

import { type Address, getAddress } from "viem";
import { getInfoClient } from "./hyperliquid";
import { isHlTestnet } from "./network";

// ============================================
// Config
// ============================================

export interface BuilderConfig {
  address: Address;
  feePoints: number; // in tenths of basis points (10 = 1bp = 0.1%)
}

let missingConfigWarned = false;
let invalidFeeWarned = false;

export function getBuilderConfig(opts: { logIfMissing?: boolean } = {}): BuilderConfig | null {
  const { logIfMissing = true } = opts;
  // Prefer server-only runtime vars to avoid build-time NEXT_PUBLIC inlining issues.
  // Fallback to NEXT_PUBLIC vars for compatibility with existing setups.
  const address = process.env.BUILDER_ADDRESS ?? process.env.NEXT_PUBLIC_BUILDER_ADDRESS;
  const feePoints = process.env.BUILDER_FEE ?? process.env.NEXT_PUBLIC_BUILDER_FEE;

  if (!address || !feePoints) {
    if (logIfMissing && !missingConfigWarned) {
      if (isHlTestnet()) {
        console.warn("[Builder] Builder codes not configured (testnet mode)");
      } else {
        console.error(
          "[Builder] Builder codes are required on mainnet. Set BUILDER_ADDRESS/BUILDER_FEE (or NEXT_PUBLIC_BUILDER_ADDRESS/NEXT_PUBLIC_BUILDER_FEE)."
        );
      }
      missingConfigWarned = true;
    }
    return null;
  }

  const parsedFeePoints = parseInt(feePoints, 10);
  if (!Number.isFinite(parsedFeePoints) || parsedFeePoints <= 0) {
    if (!invalidFeeWarned) {
      console.error(
        "[Builder] BUILDER_FEE (or NEXT_PUBLIC_BUILDER_FEE) must be a positive integer (tenths of basis points)."
      );
      invalidFeeWarned = true;
    }
    return null;
  }

  try {
    return {
      address: getAddress(address.toLowerCase()),
      feePoints: parsedFeePoints,
    };
  } catch {
    if (logIfMissing) {
      console.error("[Builder] BUILDER_ADDRESS is not a valid EVM address.");
    }
    return null;
  }
}

/**
 * Builder configuration is mandatory for mainnet trading to avoid silent
 * revenue loss from orders executing without builder params.
 */
export function assertBuilderConfiguredForTrading(): void {
  if (isHlTestnet()) return;
  const config = getBuilderConfig();
  if (!config) {
    throw new Error(
      "Builder codes are required for Hyperliquid mainnet. Configure BUILDER_ADDRESS/BUILDER_FEE (or NEXT_PUBLIC_BUILDER_ADDRESS/NEXT_PUBLIC_BUILDER_FEE)."
    );
  }
}

/**
 * Convert builder fee points to percentage string
 * @param points - Fee in tenths of basis points (10 = 1bp = 0.1%)
 * @returns Percentage string (e.g., "0.1%")
 */
export function builderPointsToPercent(points: number): string {
  // 1 point = 0.1 basis point = 0.01%
  return (points * 0.01).toString() + "%";
}

/**
 * Format builder parameter for Hyperliquid orders
 * @returns Builder parameter object or undefined if not configured
 */
export function getBuilderParam(): { b: string; f: number } | undefined {
  const config = getBuilderConfig();
  if (!config) return undefined;

  return {
    b: config.address.toLowerCase(),
    f: config.feePoints,
  };
}

// ============================================
// Builder Fee Approval
// ============================================

/**
 * Check if a user has approved the builder fee
 * @param user - User's address
 * @returns The approved max fee in points, or 0 if not approved
 */
export async function getMaxBuilderFee(user: Address): Promise<number> {
  const config = getBuilderConfig();
  if (!config) return 0;

  try {
    const info = getInfoClient();
    const response = await info.maxBuilderFee({
      user,
      builder: config.address,
    });
    return response as number;
  } catch (error) {
    console.error("[Builder] Failed to fetch max builder fee:", error);
    return 0;
  }
}

/**
 * Check if user has sufficient builder fee approval
 * @param user - User's address
 * @returns true if approved fee >= required fee
 */
export async function hasBuilderApproval(user: Address): Promise<boolean> {
  const config = getBuilderConfig();
  if (!config) return true; // If builder not configured, no approval needed

  const maxFee = await getMaxBuilderFee(user);
  return maxFee >= config.feePoints;
}

// ============================================
// Builder Fee Stats
// ============================================

/**
 * Get builder's accumulated fees and referral state
 * @returns Builder's referral state including total fees earned
 */
export async function getBuilderStats(): Promise<{
  totalFees: string;
  claimableFees: string;
} | null> {
  const config = getBuilderConfig();
  if (!config) return null;

  try {
    const info = getInfoClient();
    const referralState = await info.referral({
      user: config.address,
    }) as any;

    return {
      totalFees: referralState?.builderFees || "0",
      claimableFees: referralState?.builderFees || "0",
    };
  } catch (error) {
    console.error("[Builder] Failed to fetch builder stats:", error);
    return null;
  }
}

// ============================================
// EIP-712 Typed Data for Approval
// ============================================

/**
 * Get the EIP-712 typed data for builder fee approval
 * Used for signing the approval transaction
 */
export function getApproveBuilderFeeTypedData(
  chainId: number,
  nonce: number
): {
  domain: any;
  types: any;
  primaryType: string;
  message: any;
} {
  const config = getBuilderConfig();
  if (!config) throw new Error("Builder not configured");

  const maxFeeRate = builderPointsToPercent(config.feePoints);
  const hyperliquidChain = process.env.NEXT_PUBLIC_HYPERLIQUID_TESTNET === "true" 
    ? "Testnet" 
    : "Mainnet";

  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: {
      "HyperliquidTransaction:ApproveBuilderFee": [
        { name: "hyperliquidChain", type: "string" },
        { name: "maxFeeRate", type: "string" },
        { name: "builder", type: "address" },
        { name: "nonce", type: "uint64" },
      ],
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
    primaryType: "HyperliquidTransaction:ApproveBuilderFee",
    message: {
      type: "approveBuilderFee",
      hyperliquidChain,
      maxFeeRate,
      builder: config.address,
      nonce,
    },
  };
}

// ============================================
// Auto-Approval (Vincent-style)
// ============================================

/**
 * Precheck if builder code approval is needed
 * Returns true if approval is needed, false if already approved
 * 
 * @param user - User's Hyperliquid address
 * @returns true if approval needed, false if already approved
 */
export async function needsBuilderApproval(user: Address): Promise<boolean> {
  const config = getBuilderConfig();
  if (!config) {
    // No builder configured, no approval needed
    return false;
  }

  try {
    const maxFee = await getMaxBuilderFee(user);
    // Need approval if current approval is less than required
    return maxFee < config.feePoints;
  } catch (error) {
    console.error("[Builder] Failed to check approval status:", error);
    // Assume approval needed on error
    return true;
  }
}

/**
 * Automatically approve builder code for an agent wallet
 * Called during agent provisioning or first trade (Vincent-style)
 * 
 * Supports both traditional and PKP wallets.
 * 
 * @param agentAddress - Agent's Hyperliquid address
 * @param agentPrivateKey - Agent's private key for signing (traditional only)
 * @param agentId - Agent ID (required for PKP signing)
 * @returns true if approved successfully, false otherwise
 */
export async function autoApproveBuilderCode(
  agentAddress: Address,
  agentPrivateKey?: string,
  agentId?: string
): Promise<{ success: boolean; alreadyApproved?: boolean; error?: string }> {
  const config = getBuilderConfig();
  if (!config) {
    return { success: false, error: "Builder not configured" };
  }

  try {
    // Precheck: Is approval already in place?
    const needsApproval = await needsBuilderApproval(agentAddress);
    
    if (!needsApproval) {
      console.log(`[Builder] Agent ${agentAddress} already has builder approval`);
      return { success: true, alreadyApproved: true };
    }

    console.log(`[Builder] Auto-approving builder code for agent ${agentAddress}`);

    // Determine signing method
    let isPKP = false;
    if (agentId) {
      const { isPKPAccount } = await import("./account-manager");
      isPKP = await isPKPAccount(agentId);
    }

    if (isPKP && agentId) {
      // Use PKP signing for builder approval
      return await autoApproveBuilderCodeWithPKP(agentId, agentAddress);
    } else if (agentPrivateKey) {
      // Use traditional signing
      return await autoApproveBuilderCodeTraditional(agentAddress, agentPrivateKey);
    } else {
      return {
        success: false,
        error: "No signing method available (need privateKey or agentId for PKP)",
      };
    }
  } catch (error) {
    console.error("[Builder] Auto-approval failed:", error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : "Unknown error" 
    };
  }
}

/**
 * Auto-approve builder code using traditional wallet signing
 */
async function autoApproveBuilderCodeTraditional(
  agentAddress: Address,
  agentPrivateKey: string
): Promise<{ success: boolean; alreadyApproved?: boolean; error?: string }> {
  const config = getBuilderConfig();
  if (!config) {
    return { success: false, error: "Builder not configured" };
  }

  try {
    // Import dynamically to avoid circular deps
    const { getExchangeClientForAgent } = await import("./hyperliquid");
    const exchange = getExchangeClientForAgent(agentPrivateKey);

    const maxFeeRate = builderPointsToPercent(config.feePoints);

    // Submit approval via exchange client
    await exchange.approveBuilderFee({
      builder: config.address,
      maxFeeRate,
    });

    console.log(`[Builder] Traditional auto-approval successful for ${agentAddress}`);
    return { success: true };
  } catch (error) {
    console.error("[Builder] Traditional auto-approval failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Auto-approve builder code using PKP signing
 */
async function autoApproveBuilderCodeWithPKP(
  agentId: string,
  agentAddress: Address
): Promise<{ success: boolean; alreadyApproved?: boolean; error?: string }> {
  try {
    console.log(`[Builder] Using PKP signing for builder approval`);
    
    const { signBuilderApprovalWithPKP } = await import("./lit-signing");
    const result = await signBuilderApprovalWithPKP(agentId);

    if (!result.success || !result.signature || !result.action) {
      return {
        success: false,
        error: result.error || "PKP signing failed",
      };
    }

    // Submit signed approval to Hyperliquid
    const { getInfoClient } = await import("./hyperliquid");
    const info = getInfoClient();
    const infoWithCustom = info as unknown as {
      custom: (payload: Record<string, unknown>) => Promise<unknown>;
    };
    
    // Submit via custom endpoint
    await infoWithCustom.custom({
      action: result.action,
      nonce: result.action.nonce,
      signature: result.signature,
    });

    console.log(`[Builder] PKP auto-approval successful for ${agentAddress}`);
    return { success: true };
  } catch (error) {
    console.error("[Builder] PKP auto-approval failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Check and auto-approve builder code if needed before executing a trade
 * Returns true if approved (or already approved), false if approval failed
 * 
 * Supports both traditional and PKP wallets.
 * 
 * @param agentAddress - Agent's address
 * @param agentPrivateKey - Agent's private key (optional, for traditional wallets)
 * @param agentId - Agent ID (optional, for PKP wallets)
 * @returns true if ready to trade, false if approval failed
 */
export async function ensureBuilderApproval(
  agentAddress: Address,
  agentPrivateKey?: string,
  agentId?: string
): Promise<boolean> {
  const config = getBuilderConfig();
  if (!config) {
    // No builder configured, proceed without approval
    return true;
  }

  try {
    const needsApproval = await needsBuilderApproval(agentAddress);
    
    if (!needsApproval) {
      // Already approved
      return true;
    }

    // Auto-approve
    console.log(`[Builder] First trade for ${agentAddress}, auto-approving builder code`);
    const result = await autoApproveBuilderCode(agentAddress, agentPrivateKey, agentId);
    
    return result.success;
  } catch (error) {
    console.error("[Builder] Failed to ensure builder approval:", error);
    // Don't block trades if approval check fails
    return true;
  }
}
