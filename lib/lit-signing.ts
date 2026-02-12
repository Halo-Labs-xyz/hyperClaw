/**
 * Lit Protocol v8 Signing Integration
 *
 * Integrates Lit Protocol PKP signing with Hyperliquid trading.
 * This module bridges the gap between Lit's distributed signing
 * and Hyperliquid's order execution.
 *
 * Flow (v8):
 * 1. Order request comes in for an agent with PKP account
 * 2. Get auth context (replaces session sigs in v8)
 * 3. Execute the Lit Action with order params
 * 4. Lit Action validates constraints and signs if valid
 * 5. Get signature back and construct signed order
 * 6. Submit signed order to Hyperliquid
 */

import type { Address } from "viem";
import {
  getLitClient,
  executeLitAction,
  getOperatorAuthContext,
  generateTradingLitAction,
  type LitActionResult,
  DEFAULT_TRADING_CONSTRAINTS,
} from "./lit-protocol";
import { getPKPForAgent } from "./account-manager";
import type { PlaceOrderParams, PKPTradingConstraints } from "./types";

// ============================================
// Types
// ============================================

export interface PKPSigningResult {
  success: boolean;
  signature?: string;
  publicKey?: string;
  recid?: number;
  messageHash?: string;
  errors?: string[];
}

export interface PKPOrderResult {
  success: boolean;
  orderMessage?: Record<string, unknown>;
  signature?: {
    signature: string;
    publicKey: string;
    recid: number;
  };
  errors?: string[];
}

// ============================================
// PKP Order Signing
// ============================================

/**
 * Sign a Hyperliquid order using an agent's PKP (v8)
 *
 * This executes the Lit Action which:
 * 1. Validates trading constraints
 * 2. Signs the order if constraints pass
 * 3. Returns signature or error
 */
export async function signOrderWithPKP(
  agentId: string,
  orderParams: PlaceOrderParams,
  price: number
): Promise<PKPOrderResult> {
  // Get PKP info for this agent
  const pkpInfo = await getPKPForAgent(agentId);
  if (!pkpInfo) {
    return {
      success: false,
      errors: [`No PKP found for agent ${agentId}`],
    };
  }

  // Prepare order params for Lit Action (v8: pass via jsParams)
  const order = {
    coin: orderParams.coin,
    side: orderParams.side,
    size: orderParams.size.toString(),
    price: price.toString(),
    stopLoss: orderParams.triggerPrice?.toString(),
    reduceOnly: orderParams.reduceOnly || false,
    agentId,
    timestamp: Date.now(),
  };

  // Build or use existing Lit Action
  let litActionCode: string;
  if (pkpInfo.litActionCid) {
    // Use pre-deployed action via IPFS CID
    try {
      const result = await executeLitAction({
        ipfsId: pkpInfo.litActionCid,
        jsParams: {
          orderParams: JSON.stringify(order),
          pkpPublicKey: pkpInfo.publicKey,
        },
      });

      return processLitActionResult(result);
    } catch (error) {
      return {
        success: false,
        errors: [`Lit Action execution failed: ${error instanceof Error ? error.message : "Unknown error"}`],
      };
    }
  } else {
    // Build action inline with stored constraints
    const constraints = pkpInfo.constraints || getDefaultConstraints();
    litActionCode = generateTradingLitAction(constraints);

    try {
      const result = await executeLitAction({
        code: litActionCode,
        jsParams: {
          orderParams: JSON.stringify(order),
          pkpPublicKey: pkpInfo.publicKey,
        },
      });

      return processLitActionResult(result);
    } catch (error) {
      return {
        success: false,
        errors: [`Lit Action execution failed: ${error instanceof Error ? error.message : "Unknown error"}`],
      };
    }
  }
}

/**
 * Process Lit Action result into our standard format (v8)
 */
function processLitActionResult(result: LitActionResult): PKPOrderResult {
  if (!result.response) {
    return {
      success: false,
      errors: ["No response from Lit Action"],
    };
  }

  let parsed: { success: boolean; errors?: string[]; orderMessage?: Record<string, unknown> };
  try {
    parsed = JSON.parse(result.response);
  } catch {
    return {
      success: false,
      errors: ["Failed to parse Lit Action response"],
    };
  }

  if (!parsed.success) {
    return {
      success: false,
      errors: parsed.errors || ["Unknown error"],
    };
  }

  // Get signature from result
  const sig = result.signatures?.["hyperliquidOrder"];
  if (!sig) {
    return {
      success: false,
      errors: ["No signature in Lit Action result"],
    };
  }

  return {
    success: true,
    orderMessage: parsed.orderMessage,
    signature: {
      signature: sig.signature,
      publicKey: sig.publicKey,
      recid: sig.recid,
    },
  };
}

// ============================================
// Direct PKP Signing (for pre-constructed messages)
// ============================================

/**
 * Sign a raw message hash using PKP (v8)
 *
 * Use this when you've already constructed the exact message
 * that needs to be signed (e.g., for Hyperliquid's specific format).
 */
export async function signMessageWithPKP(
  agentId: string,
  messageHash: string
): Promise<PKPSigningResult> {
  const pkpInfo = await getPKPForAgent(agentId);
  if (!pkpInfo) {
    return {
      success: false,
      errors: [`No PKP found for agent ${agentId}`],
    };
  }

  try {
    const client = await getLitClient();

    // Convert hex string to Uint8Array
    const toSign = new Uint8Array(
      messageHash.startsWith('0x') 
        ? Buffer.from(messageHash.slice(2), 'hex')
        : Buffer.from(messageHash, 'hex')
    );

    // v8: Use chain-specific pkpSign API
    const result = await client.chain.ethereum.pkpSign({
      pubKey: pkpInfo.publicKey,
      toSign,
      authContext: await getOperatorAuthContext(),
    });

    const resultWithRecovery = result as {
      signature: string;
      recid?: number;
      recoveryId?: number;
    };

    return {
      success: true,
      signature: resultWithRecovery.signature,
      publicKey: pkpInfo.publicKey,
      recid: resultWithRecovery.recid ?? resultWithRecovery.recoveryId ?? 0,
      messageHash,
    };
  } catch (error) {
    return {
      success: false,
      errors: [error instanceof Error ? error.message : "Unknown error"],
    };
  }
}

// ============================================
// PKP Account Provisioning
// ============================================

/**
 * Provision a new PKP account for an agent
 *
 * This creates:
 * 1. A new PKP (distributed wallet)
 * 2. Adds it to the account manager
 * 3. Optionally sets up a Lit Action with constraints
 */
export async function provisionPKPForAgent(
  agentId: string,
  constraints?: Partial<PKPTradingConstraints>
): Promise<{
  success: boolean;
  address?: Address;
  pkpTokenId?: string;
  error?: string;
}> {
  try {
    const { mintPKP } = await import("./lit-protocol");
    const { addPKPAccount } = await import("./account-manager");

    // Mint new PKP (v8 API)
    const pkp = await mintPKP();

    // Merge with default constraints
    const finalConstraints: PKPTradingConstraints = {
      ...getDefaultConstraints(),
      ...constraints,
    };

    // Add to account manager
    await addPKPAccount({
      alias: `pkp-agent-${agentId.slice(0, 8)}`,
      agentId,
      pkpTokenId: pkp.tokenId,
      pkpPublicKey: pkp.publicKey,
      pkpEthAddress: pkp.ethAddress,
      constraints: finalConstraints,
    });

    console.log(`[LitSigning] Provisioned PKP ${pkp.ethAddress} for agent ${agentId}`);

    return {
      success: true,
      address: pkp.ethAddress,
      pkpTokenId: pkp.tokenId,
    };
  } catch (error) {
    console.error(`[LitSigning] Failed to provision PKP:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// ============================================
// Helpers
// ============================================

/**
 * Get default trading constraints
 */
function getDefaultConstraints(): PKPTradingConstraints {
  return {
    ...DEFAULT_TRADING_CONSTRAINTS,
  };
}

/**
 * Check if an agent has a PKP account
 */
export async function agentHasPKP(agentId: string): Promise<boolean> {
  const pkpInfo = await getPKPForAgent(agentId);
  return pkpInfo !== null;
}

/**
 * Get the signing method for an agent (PKP or traditional)
 */
export async function getAgentSigningMethod(
  agentId: string
): Promise<"pkp" | "traditional" | "none"> {
  const { getAccountForAgent, isPKPAccount } = await import("./account-manager");
  
  const account = await getAccountForAgent(agentId);
  if (!account) return "none";
  
  if (await isPKPAccount(agentId)) return "pkp";
  
  return account.encryptedKey ? "traditional" : "none";
}

// ============================================
// PKP Builder Approval
// ============================================

/**
 * Sign builder fee approval using PKP
 * Used for auto-approving builder codes with PKP wallets
 */
export async function signBuilderApprovalWithPKP(
  agentId: string
): Promise<{
  success: boolean;
  signature?: { r: string; s: string; v: number };
  action?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const pkpInfo = await getPKPForAgent(agentId);
    if (!pkpInfo) {
      return { success: false, error: "No PKP found for agent" };
    }

    // Import builder config
    const { getBuilderConfig, builderPointsToPercent } = await import("./builder");
    const config = getBuilderConfig();
    
    if (!config) {
      return { success: false, error: "Builder not configured" };
    }

    const { isTestnet } = await import("./hyperliquid");
    const nonce = Date.now();
    const maxFeeRate = builderPointsToPercent(config.feePoints);
    const hyperliquidChain = isTestnet() ? "Testnet" : "Mainnet";

    const action = {
      type: "approveBuilderFee" as const,
      hyperliquidChain,
      maxFeeRate,
      builder: config.address,
      nonce,
    };

    // Create Lit Action to sign builder approval
    const litActionCode = `
(async () => {
  const { action, pkpPublicKey } = jsParams;
  
  try {
    const actionObj = JSON.parse(action);
    
    // Create EIP-712 typed data hash for builder approval
    const domain = {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 421614,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    };
    
    const types = {
      "HyperliquidTransaction:ApproveBuilderFee": [
        { name: "hyperliquidChain", type: "string" },
        { name: "maxFeeRate", type: "string" },
        { name: "builder", type: "address" },
        { name: "nonce", type: "uint64" },
      ],
    };
    
    // Sign with PKP
    const sigShare = await Lit.Actions.signEcdsa({
      toSign: ethers.utils.arrayify(
        ethers.utils._TypedDataEncoder.hash(domain, types, actionObj)
      ),
      publicKey: pkpPublicKey,
      sigName: "builderApproval",
    });
    
    Lit.Actions.setResponse({ 
      response: JSON.stringify({ success: true })
    });
  } catch (err) {
    Lit.Actions.setResponse({ 
      response: JSON.stringify({ 
        success: false, 
        error: err.message || String(err)
      })
    });
  }
})();
`;

    const result = await executeLitAction({
      code: litActionCode,
      jsParams: {
        action: JSON.stringify(action),
        pkpPublicKey: pkpInfo.publicKey,
      },
    });

    if (!result.response) {
      return { success: false, error: "No response from Lit Action" };
    }

    const parsed = JSON.parse(result.response);
    if (!parsed.success) {
      return { success: false, error: parsed.error || "PKP signing failed" };
    }

    const sig = result.signatures?.["builderApproval"];
    if (!sig) {
      return { success: false, error: "No signature in Lit Action result" };
    }

    return {
      success: true,
      action,
      signature: {
        r: `0x${sig.signature.slice(0, 64)}`,
        s: `0x${sig.signature.slice(64, 128)}`,
        v: sig.recid + 27,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================
// PKP Order Execution (High-Level)
// ============================================

/**
 * Execute a Hyperliquid order using PKP signing.
 * This is the high-level interface for agent trading with PKP accounts.
 * 
 * Mirrors the signature of hyperliquid.executeOrder() so it's a drop-in replacement
 * for the agent runner and other trading flows.
 * 
 * Flow:
 * 1. Construct Hyperliquid order action (same format as SDK)
 * 2. Get PKP to sign the action via Lit Protocol
 * 3. Submit signed order directly to Hyperliquid API
 * 
 * @param agentId - Agent ID with PKP account
 * @param orderParams - Standard PlaceOrderParams from types.ts
 * @returns Promise resolving to Hyperliquid's order response (same as ExchangeClient.order())
 */
export async function executeOrderWithPKP(
  agentId: string,
  orderParams: PlaceOrderParams
): Promise<unknown> {
  const { getExchangeClientForPKP, executeOrder } = await import("./hyperliquid");
  const exchange = await getExchangeClientForPKP(agentId);
  // Skip builder for agent/API wallets—Hyperliquid requires main-wallet sign for builder approval.
  return executeOrder(orderParams, exchange, { skipBuilder: true });
}
