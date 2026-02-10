#!/usr/bin/env node
/**
 * Deploy Lit Actions to IPFS
 *
 * This script:
 * 1. Builds the trading Lit Action with configurable constraints
 * 2. Uploads to IPFS via Pinata (or web3.storage)
 * 3. Outputs the IPFS CID for use in production
 *
 * Prerequisites:
 * - PINATA_API_KEY and PINATA_API_SECRET in .env
 *   OR
 * - WEB3_STORAGE_TOKEN in .env
 *
 * Run with: node scripts/deploy-lit-actions.mjs
 */

import { config } from "dotenv";
import { createHash } from "crypto";
import https from "https";
import fs from "fs";
import path from "path";

// Load environment variables
config();

// ============================================
// Configuration
// ============================================

const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_API_SECRET = process.env.PINATA_API_SECRET;

// ============================================
// Trading Constraints Presets
// ============================================

const CONSTRAINT_PRESETS = {
  conservative: {
    maxPositionSizeUsd: 1000,
    allowedCoins: ["BTC", "ETH"],
    maxLeverage: 3,
    requireStopLoss: true,
    maxDailyTrades: 10,
    cooldownMs: 300000,
  },
  moderate: {
    maxPositionSizeUsd: 5000,
    allowedCoins: ["BTC", "ETH", "SOL", "ARB", "AVAX"],
    maxLeverage: 10,
    requireStopLoss: true,
    maxDailyTrades: 30,
    cooldownMs: 60000,
  },
  aggressive: {
    maxPositionSizeUsd: 20000,
    allowedCoins: ["BTC", "ETH", "SOL", "ARB", "AVAX", "DOGE", "MATIC", "LINK", "OP", "SUI", "APT", "INJ"],
    maxLeverage: 20,
    requireStopLoss: false,
    maxDailyTrades: 100,
    cooldownMs: 30000,
  },
};

// ============================================
// Lit Action Template
// ============================================

function buildTradingLitAction(constraints, agentDescription = "HyperClaw Trading Agent") {
  return `
/**
 * HyperClaw Trading Lit Action
 * 
 * ${agentDescription}
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
    // Parse Order Parameters
    // ========================================
    const order = JSON.parse(jsParams.orderParams);
    const errors = [];
    
    // ========================================
    // Constraint Validation
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
    
    // 4. Stop loss requirement
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
          constraints: {
            maxPositionSizeUsd: CONSTRAINTS.maxPositionSizeUsd,
            maxLeverage: CONSTRAINTS.maxLeverage,
            allowedCoins: CONSTRAINTS.allowedCoins,
          },
        }),
      });
      return;
    }
    
    // ========================================
    // Construct Order Message for Signing
    // ========================================
    
    const orderMessage = {
      asset: order.coin,
      isBuy: order.side === "buy" || order.side === "long",
      limitPx: order.price,
      sz: order.size,
      reduceOnly: order.reduceOnly || false,
      cloid: order.cloid || null,
      timestamp: order.timestamp || Date.now(),
      // Metadata
      agentId: order.agentId,
      nonce: order.nonce || Math.random().toString(36).slice(2),
    };
    
    // Create deterministic hash (v8: use Web Crypto API)
    const messageString = JSON.stringify(orderMessage, Object.keys(orderMessage).sort());
    const messageBytes = new TextEncoder().encode(messageString);
    const hashBuffer = await crypto.subtle.digest('SHA-256', messageBytes);
    const toSign = new Uint8Array(hashBuffer);
    
    // ========================================
    // Sign with PKP (v8: use jsParams.pkpPublicKey)
    // ========================================
    
    const sigShare = await Lit.Actions.signEcdsa({
      toSign,
      publicKey: jsParams.pkpPublicKey,
      sigName: "hyperliquidOrder",
    });
    
    // ========================================
    // Return Success
    // ========================================
    
    Lit.Actions.setResponse({
      response: JSON.stringify({
        success: true,
        orderMessage,
        messageHash,
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
}

// ============================================
// IPFS Upload via Pinata
// ============================================

async function uploadToPinata(content, name) {
  if (!PINATA_API_KEY || !PINATA_API_SECRET) {
    console.log("⚠️  Pinata credentials not found. Generating local hash only.");
    const hash = createHash("sha256").update(content).digest("hex");
    return { IpfsHash: `local_${hash.slice(0, 32)}`, isDryRun: true };
  }

  return new Promise((resolve, reject) => {
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="lit-action.js"',
      "Content-Type: application/javascript",
      "",
      content,
      `--${boundary}`,
      'Content-Disposition: form-data; name="pinataMetadata"',
      "Content-Type: application/json",
      "",
      JSON.stringify({ name }),
      `--${boundary}--`,
    ].join("\r\n");

    const options = {
      hostname: "api.pinata.cloud",
      port: 443,
      path: "/pinning/pinFileToIPFS",
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": Buffer.byteLength(body),
        pinata_api_key: PINATA_API_KEY,
        pinata_secret_api_key: PINATA_API_SECRET,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Pinata error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ============================================
// Main Deployment
// ============================================

async function deploy() {
  console.log("=".repeat(50));
  console.log("  Lit Action IPFS Deployment");
  console.log("=".repeat(50));
  console.log();

  const results = [];

  for (const [presetName, constraints] of Object.entries(CONSTRAINT_PRESETS)) {
    console.log(`\n📦 Building ${presetName} preset...`);
    console.log(`   Max Position: $${constraints.maxPositionSizeUsd}`);
    console.log(`   Max Leverage: ${constraints.maxLeverage}x`);
    console.log(`   Allowed Coins: ${constraints.allowedCoins.join(", ")}`);
    console.log(`   Stop Loss Required: ${constraints.requireStopLoss}`);

    const actionCode = buildTradingLitAction(
      constraints,
      `HyperClaw ${presetName.charAt(0).toUpperCase() + presetName.slice(1)} Trading Agent`
    );

    console.log(`   Code size: ${actionCode.length} bytes`);

    try {
      console.log(`   Uploading to IPFS...`);
      const result = await uploadToPinata(actionCode, `hyperclaw-lit-action-${presetName}`);

      if (result.isDryRun) {
        console.log(`   ⚠️  Dry run - local hash: ${result.IpfsHash}`);
      } else {
        console.log(`   ✅ Uploaded! CID: ${result.IpfsHash}`);
      }

      results.push({
        preset: presetName,
        cid: result.IpfsHash,
        constraints,
        isDryRun: result.isDryRun || false,
      });
    } catch (error) {
      console.log(`   ❌ Failed: ${error.message}`);
      results.push({
        preset: presetName,
        error: error.message,
      });
    }
  }

  // ============================================
  // Output Summary
  // ============================================

  console.log("\n" + "=".repeat(50));
  console.log("  Deployment Summary");
  console.log("=".repeat(50) + "\n");

  const outputConfig = {
    generatedAt: new Date().toISOString(),
    network: process.env.LIT_NETWORK || "datil-test",
    presets: {},
  };

  for (const result of results) {
    if (result.cid) {
      outputConfig.presets[result.preset] = {
        ipfsCid: result.cid,
        constraints: result.constraints,
      };
      console.log(`${result.preset}:`);
      console.log(`  CID: ${result.cid}`);
      console.log(`  Gateway: https://gateway.pinata.cloud/ipfs/${result.cid}`);
      console.log();
    }
  }

  // Save config file
  const configPath = path.join(process.cwd(), "lib", "lit-action-cids.json");
  fs.writeFileSync(configPath, JSON.stringify(outputConfig, null, 2));
  console.log(`📄 Config saved to: ${configPath}`);

  // Output env vars
  console.log("\n📋 Add to .env for production:\n");
  for (const result of results) {
    if (result.cid && !result.isDryRun) {
      console.log(`LIT_ACTION_CID_${result.preset.toUpperCase()}=${result.cid}`);
    }
  }

  console.log("\n✅ Done!");

  if (results.some((r) => r.isDryRun)) {
    console.log("\n⚠️  Some uploads were dry runs. To actually upload:");
    console.log("   1. Get Pinata API keys at https://pinata.cloud");
    console.log("   2. Add PINATA_API_KEY and PINATA_API_SECRET to .env");
    console.log("   3. Run this script again");
  }
}

// Run
deploy().catch(console.error);
