/**
 * Lit Action v8: Secure Trading Execution
 *
 * This module contains the Lit Action code that runs on Lit Protocol's
 * decentralized network. The action enforces trading constraints at the
 * cryptographic signing layer - even if the backend is compromised,
 * the Lit Action will refuse to sign invalid orders.
 *
 * Key security properties:
 * - Immutable constraints (baked into IPFS-stored code)
 * - Threshold signing (>2/3 of Lit nodes must agree)
 * - No private key exposure (signing happens inside secure enclave)
 *
 * v8 Changes:
 * - Access params via jsParams.* (not globals)
 * - Use Lit.Actions.* namespace (preferred over LitActions.*)
 * - Use Web Crypto API for hashing (not ethers)
 */

import type { TradingConstraints } from "../lit-protocol";

// ============================================
// Lit Action Code Templates (v8)
// ============================================

/**
 * The core trading Lit Action code for v8
 *
 * This code is executed on Lit's network and has access to:
 * - Lit.Actions.signEcdsa() for PKP signing
 * - Lit.Actions.setResponse() to return data
 * - jsParams.* for all custom inputs (v8 change)
 * - pkpPublicKey passed via jsParams
 */
export const TRADING_LIT_ACTION_CODE_V8 = `
(async () => {
  try {
    // ========================================
    // Parse Parameters (v8: via jsParams)
    // ========================================
    
    // Constraints are injected at deployment time
    const CONSTRAINTS = jsParams.constraints;
    
    // Order params from the HyperClaw backend
    const order = JSON.parse(jsParams.orderParams);
    const pkpPublicKey = jsParams.pkpPublicKey;
    
    const errors = [];
    
    // ========================================
    // Validate Trading Constraints
    // ========================================
    
    // 1. Allowed coins whitelist
    if (!CONSTRAINTS.allowedCoins.includes(order.coin)) {
      errors.push(\`Coin '\${order.coin}' not allowed. Permitted: \${CONSTRAINTS.allowedCoins.join(", ")}\`);
    }
    
    // 2. Position size limit
    const positionValueUsd = parseFloat(order.size || 0) * parseFloat(order.price || 0);
    if (positionValueUsd > CONSTRAINTS.maxPositionSizeUsd) {
      errors.push(\`Position value $\${positionValueUsd.toFixed(2)} exceeds limit $\${CONSTRAINTS.maxPositionSizeUsd}\`);
    }
    
    // 3. Leverage limit
    if (order.leverage && order.leverage > CONSTRAINTS.maxLeverage) {
      errors.push(\`Leverage \${order.leverage}x exceeds limit \${CONSTRAINTS.maxLeverage}x\`);
    }
    
    // 4. Stop loss requirement (for non-reduce-only orders)
    if (CONSTRAINTS.requireStopLoss && !order.reduceOnly && !order.stopLoss) {
      errors.push("Stop loss is required for new positions");
    }
    
    // 5. Timestamp freshness (prevent replay attacks)
    const now = Date.now();
    const maxAge = 120000; // 2 minutes
    if (order.timestamp && Math.abs(now - order.timestamp) > maxAge) {
      errors.push("Order timestamp expired or invalid");
    }
    
    // ========================================
    // Return Error if Validation Failed
    // ========================================
    
    if (errors.length > 0) {
      Lit.Actions.setResponse({
        response: JSON.stringify({
          success: false,
          errors,
          constraints: CONSTRAINTS,
        }),
      });
      return;
    }
    
    // ========================================
    // Construct Order Message for Signing
    // ========================================
    
    const orderMessage = {
      ...order,
      validatedAt: Date.now(),
    };
    
    // Create hash using Web Crypto API (v8: no ethers available)
    const messageString = JSON.stringify(orderMessage, Object.keys(orderMessage).sort());
    const messageBytes = new TextEncoder().encode(messageString);
    const hashBuffer = await crypto.subtle.digest('SHA-256', messageBytes);
    const toSign = new Uint8Array(hashBuffer);
    
    // ========================================
    // Sign with PKP
    // ========================================
    
    const sigShare = await Lit.Actions.signEcdsa({
      toSign,
      publicKey: pkpPublicKey,
      sigName: "hyperliquidOrder",
    });
    
    // ========================================
    // Return Success Response
    // ========================================
    
    Lit.Actions.setResponse({
      response: JSON.stringify({
        success: true,
        orderMessage,
        signedAt: Date.now(),
      }),
    });
    
  } catch (error) {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        success: false,
        errors: [error.message || "Unknown error in Lit Action"],
      }),
    });
  }
})();
`;

// ============================================
// Lit Action Builder (v8)
// ============================================

/**
 * Build a complete Lit Action with embedded constraints (v8)
 *
 * @param constraints - Trading constraints to enforce
 * @returns Complete Lit Action code string
 */
export function buildTradingLitAction(constraints: TradingConstraints): string {
  return `
/**
 * HyperClaw Trading Lit Action (v8 Format)
 * Generated: ${new Date().toISOString()}
 * 
 * This action enforces trading constraints at the cryptographic layer.
 * Once deployed to IPFS, these constraints are IMMUTABLE.
 */

(async () => {
  try {
    // ========================================
    // Immutable Trading Constraints
    // ========================================
    const CONSTRAINTS = ${JSON.stringify(constraints, null, 2)};
    
    // ========================================
    // Parse Order Parameters (v8: via jsParams)
    // ========================================
    const order = JSON.parse(jsParams.orderParams);
    const pkpPublicKey = jsParams.pkpPublicKey;
    const errors = [];
    
    // ========================================
    // Validate Trading Constraints
    // ========================================
    
    // 1. Allowed coins
    if (!CONSTRAINTS.allowedCoins.includes(order.coin)) {
      errors.push(\`Coin '\${order.coin}' not allowed\`);
    }
    
    // 2. Position size
    const positionValueUsd = parseFloat(order.size || 0) * parseFloat(order.price || 0);
    if (positionValueUsd > CONSTRAINTS.maxPositionSizeUsd) {
      errors.push(\`Position $\${positionValueUsd.toFixed(2)} exceeds max $\${CONSTRAINTS.maxPositionSizeUsd}\`);
    }
    
    // 3. Leverage
    if (order.leverage && order.leverage > CONSTRAINTS.maxLeverage) {
      errors.push(\`Leverage \${order.leverage}x exceeds max \${CONSTRAINTS.maxLeverage}x\`);
    }
    
    // 4. Stop loss requirement
    if (CONSTRAINTS.requireStopLoss && !order.reduceOnly && !order.stopLoss) {
      errors.push("Stop loss required");
    }
    
    // 5. Timestamp freshness
    const now = Date.now();
    if (order.timestamp && Math.abs(now - order.timestamp) > 120000) {
      errors.push("Order timestamp expired");
    }
    
    // Return errors if validation failed
    if (errors.length > 0) {
      Lit.Actions.setResponse({
        response: JSON.stringify({ success: false, errors, constraints: CONSTRAINTS }),
      });
      return;
    }
    
    // ========================================
    // Sign the Order
    // ========================================
    
    const messageString = JSON.stringify(order, Object.keys(order).sort());
    const messageBytes = new TextEncoder().encode(messageString);
    const hashBuffer = await crypto.subtle.digest('SHA-256', messageBytes);
    const toSign = new Uint8Array(hashBuffer);
    
    const sigShare = await Lit.Actions.signEcdsa({
      toSign,
      publicKey: pkpPublicKey,
      sigName: "hyperliquidOrder",
    });
    
    Lit.Actions.setResponse({
      response: JSON.stringify({
        success: true,
        orderMessage: order,
        signedAt: Date.now(),
      }),
    });
    
  } catch (error) {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        success: false,
        errors: [error.message || "Unknown error"],
      }),
    });
  }
})();
`;
}

// ============================================
// Pre-built Action Templates (v8)
// ============================================

/**
 * Conservative trading action - low risk, strict limits
 */
export const CONSERVATIVE_TRADING_ACTION = buildTradingLitAction({
  maxPositionSizeUsd: 1000,
  allowedCoins: ["BTC", "ETH"],
  maxLeverage: 3,
  requireStopLoss: true,
  maxDailyTrades: 10,
  cooldownMs: 300000, // 5 minutes
});

/**
 * Moderate trading action - balanced risk/reward
 */
export const MODERATE_TRADING_ACTION = buildTradingLitAction({
  maxPositionSizeUsd: 5000,
  allowedCoins: ["BTC", "ETH", "SOL", "ARB", "AVAX"],
  maxLeverage: 10,
  requireStopLoss: true,
  maxDailyTrades: 30,
  cooldownMs: 60000, // 1 minute
});

/**
 * Aggressive trading action - higher risk tolerance
 */
export const AGGRESSIVE_TRADING_ACTION = buildTradingLitAction({
  maxPositionSizeUsd: 20000,
  allowedCoins: ["BTC", "ETH", "SOL", "ARB", "AVAX", "DOGE", "MATIC", "LINK", "OP", "SUI"],
  maxLeverage: 20,
  requireStopLoss: false,
  maxDailyTrades: 100,
  cooldownMs: 30000, // 30 seconds
});
