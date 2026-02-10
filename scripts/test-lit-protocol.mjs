#!/usr/bin/env node
/**
 * Lit Protocol v8 (Naga) Integration Test Script
 *
 * Tests the full flow:
 * 1. Connect to Lit Network (naga-dev / naga-test)
 * 2. Create auth context
 * 3. Mint a PKP
 * 4. Execute a Lit Action with trading constraints
 * 5. Verify constraint enforcement
 *
 * Run with: node scripts/test-lit-protocol.mjs
 */

import { config } from "dotenv";
import { createLitClient } from "@lit-protocol/lit-client";
import { nagaDev, nagaTest } from "@lit-protocol/networks";
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
import { privateKeyToAccount } from "viem/accounts";

// Load environment variables
config();

// ============================================
// Configuration
// ============================================

const LIT_NETWORK = process.env.LIT_NETWORK || "naga-dev";
const OPERATOR_PRIVATE_KEY = process.env.HYPERLIQUID_PRIVATE_KEY;

if (!OPERATOR_PRIVATE_KEY) {
  console.error("❌ HYPERLIQUID_PRIVATE_KEY not set in .env");
  process.exit(1);
}

// Get the network module based on config
function getNetwork() {
  switch (LIT_NETWORK) {
    case "naga-dev":
    case "datil-dev":
      return nagaDev;
    case "naga-test":
    case "datil-test":
      return nagaTest;
    default:
      return nagaDev;
  }
}

// ============================================
// Test Lit Action Code (v8 format)
// ============================================

const TEST_TRADING_ACTION = `
(async () => {
  try {
    // Trading constraints (immutable)
    const CONSTRAINTS = {
      maxPositionSizeUsd: 5000,
      allowedCoins: ["BTC", "ETH", "SOL"],
      maxLeverage: 10,
      requireStopLoss: true,
    };
    
    // In v8, params are accessed via jsParams object
    const order = JSON.parse(jsParams.orderParams);
    const errors = [];
    
    // Validate constraints
    if (!CONSTRAINTS.allowedCoins.includes(order.coin)) {
      errors.push("Coin not allowed: " + order.coin);
    }
    
    const positionValue = parseFloat(order.size) * parseFloat(order.price);
    if (positionValue > CONSTRAINTS.maxPositionSizeUsd) {
      errors.push("Position too large: $" + positionValue.toFixed(2));
    }
    
    if (order.leverage > CONSTRAINTS.maxLeverage) {
      errors.push("Leverage too high: " + order.leverage + "x");
    }
    
    if (CONSTRAINTS.requireStopLoss && !order.stopLoss) {
      errors.push("Stop loss required");
    }
    
    // If validation failed, return errors
    if (errors.length > 0) {
      Lit.Actions.setResponse({
        response: JSON.stringify({
          success: false,
          errors,
          order,
        }),
      });
      return;
    }
    
    // Validation passed - sign the order
    const messageToSign = JSON.stringify(order);
    const toSign = new TextEncoder().encode(messageToSign);
    const msgHash = await crypto.subtle.digest('SHA-256', toSign);
    const hashArray = new Uint8Array(msgHash);
    
    const sigShare = await Lit.Actions.signEcdsa({
      toSign: hashArray,
      publicKey: jsParams.pkpPublicKey,
      sigName: "orderSig",
    });
    
    Lit.Actions.setResponse({
      response: JSON.stringify({
        success: true,
        order,
        signed: true,
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

// ============================================
// Helper Functions
// ============================================

function log(emoji, message, data = null) {
  console.log(`${emoji} ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function logSection(title) {
  console.log("\n" + "=".repeat(50));
  console.log(`  ${title}`);
  console.log("=".repeat(50) + "\n");
}

// ============================================
// Main Test Flow
// ============================================

async function runTests() {
  logSection("Lit Protocol v8 (Naga) Integration Test");
  
  const network = getNetwork();
  log("🔧", `Network: ${LIT_NETWORK}`);
  log("🌐", `Network module: ${network.name || "naga"}`);

  // Create viem account from private key
  const account = privateKeyToAccount(OPERATOR_PRIVATE_KEY);
  log("👤", `Operator address: ${account.address}`);

  // ============================================
  // Step 1: Create Lit Client
  // ============================================
  logSection("Step 1: Create Lit Client");

  log("🔌", "Creating Lit client...");
  
  let litClient;
  try {
    litClient = await createLitClient({ 
      network,
      debug: false,
    });
    log("✅", "Lit client created!");
  } catch (error) {
    log("❌", "Failed to create Lit client:", { error: error.message });
    process.exit(1);
  }

  // ============================================
  // Step 2: Create Auth Manager & Context
  // ============================================
  logSection("Step 2: Create Auth Manager");

  log("🔐", "Creating auth manager...");
  
  // Create auth manager with a custom storage path for Node.js
  const os = await import("os");
  const path = await import("path");
  const storagePath = path.join(os.tmpdir(), "hyperclaw-lit-test");
  
  const authManager = createAuthManager({
    storage: storagePlugins.localStorageNode({
      appName: "hyperclaw-test",
      networkName: LIT_NETWORK,
      storagePath,
    }),
  });

  log("✅", "Auth manager created!");

  // Create EOA auth context
  log("🎫", "Creating EOA auth context...");
  
  let authContext;
  try {
    authContext = await authManager.createEoaAuthContext({
      config: { account },
      authConfig: {
        domain: "hyperclaw.xyz",
        statement: "HyperClaw Lit Protocol Test",
        resources: [
          ["lit-action-execution", "*"],
          ["pkp-signing", "*"],
        ],
        expiration: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
      litClient,
    });
    log("✅", "Auth context created!");
  } catch (error) {
    log("❌", "Failed to create auth context:", { error: error.message, stack: error.stack?.slice(0, 300) });
    await litClient.disconnect();
    process.exit(1);
  }

  // ============================================
  // Step 3: Mint a PKP
  // ============================================
  logSection("Step 3: Mint a PKP");

  log("🔨", "Minting new PKP...");
  
  let pkp;
  try {
    // Use the new v8 minting API
    const mintResult = await litClient.mintWithEoa({
      account,
    });
    
    // The PKP info is in mintResult.data
    const pkpData = mintResult.data || mintResult;
    pkp = {
      tokenId: String(pkpData.tokenId), // Convert BigInt to string
      publicKey: pkpData.pubkey || pkpData.publicKey, // Note: it's 'pubkey' not 'publicKey'
      ethAddress: pkpData.ethAddress,
    };
    
    log("✅", "PKP minted successfully!", {
      tokenId: pkp.tokenId,
      ethAddress: pkp.ethAddress,
      publicKey: pkp.publicKey ? (pkp.publicKey.slice(0, 40) + "...") : "N/A",
      txHash: mintResult.txHash,
    });
  } catch (error) {
    log("❌", "Failed to mint PKP:", { error: error.message, stack: error.stack?.slice(0, 500) });
    
    // Try alternative: view existing PKPs
    log("🔍", "Checking for existing PKPs...");
    try {
      const existingPkps = await litClient.viewPKPsByAddress({ 
        ownerAddress: account.address 
      });
      
      if (existingPkps && existingPkps.length > 0) {
        pkp = existingPkps[0];
        log("✅", "Found existing PKP:", {
          tokenId: pkp.tokenId,
          ethAddress: pkp.ethAddress,
        });
      } else {
        log("⚠️", "No existing PKPs found. You may need to mint one manually or fund your wallet.");
        await litClient.disconnect();
        process.exit(1);
      }
    } catch (viewError) {
      log("❌", "Could not view PKPs:", { error: viewError.message });
      await litClient.disconnect();
      process.exit(1);
    }
  }

  // ============================================
  // Step 4: Test Valid Order (Should Pass)
  // ============================================
  logSection("Step 4: Test Valid Order");

  const validOrder = {
    coin: "ETH",
    side: "long",
    size: "0.5",
    price: "3000",
    leverage: 5,
    stopLoss: "2800",
    timestamp: Date.now(),
  };

  log("📤", "Submitting valid order:", validOrder);

  try {
    const validResult = await litClient.executeJs({
      code: TEST_TRADING_ACTION,
      authContext,
      jsParams: {
        orderParams: JSON.stringify(validOrder),
        pkpPublicKey: pkp.publicKey,
      },
    });

    const validResponse = JSON.parse(validResult.response);
    if (validResponse.success) {
      log("✅", "Valid order PASSED as expected!", {
        success: true,
        signed: validResponse.signed,
      });
    } else {
      log("❌", "Valid order unexpectedly rejected:", validResponse.errors);
    }
  } catch (error) {
    log("❌", "Error executing valid order:", { error: error.message });
  }

  // ============================================
  // Step 5: Test Invalid Orders (Should Fail)
  // ============================================
  logSection("Step 5: Test Constraint Enforcement");

  // Test 1: Disallowed coin
  const badCoinOrder = { ...validOrder, coin: "DOGE" };
  log("📤", "Testing disallowed coin (DOGE)...");

  try {
    const badCoinResult = await litClient.executeJs({
      code: TEST_TRADING_ACTION,
      authContext,
      jsParams: {
        orderParams: JSON.stringify(badCoinOrder),
        pkpPublicKey: pkp.publicKey,
      },
    });

    const badCoinResponse = JSON.parse(badCoinResult.response);
    if (!badCoinResponse.success) {
      log("✅", "Disallowed coin correctly REJECTED!", { errors: badCoinResponse.errors });
    } else {
      log("❌", "Disallowed coin should have been rejected!");
    }
  } catch (error) {
    log("⚠️", "Error (constraint may have blocked):", { error: error.message });
  }

  // Test 2: Position too large
  const bigPositionOrder = { ...validOrder, size: "10", price: "3000" }; // $30k > $5k limit
  log("📤", "Testing oversized position ($30k)...");

  try {
    const bigPosResult = await litClient.executeJs({
      code: TEST_TRADING_ACTION,
      authContext,
      jsParams: {
        orderParams: JSON.stringify(bigPositionOrder),
        pkpPublicKey: pkp.publicKey,
      },
    });

    const bigPosResponse = JSON.parse(bigPosResult.response);
    if (!bigPosResponse.success) {
      log("✅", "Oversized position correctly REJECTED!", { errors: bigPosResponse.errors });
    } else {
      log("❌", "Oversized position should have been rejected!");
    }
  } catch (error) {
    log("⚠️", "Error (constraint may have blocked):", { error: error.message });
  }

  // Test 3: Missing stop loss
  const noStopOrder = { ...validOrder };
  delete noStopOrder.stopLoss;
  log("📤", "Testing missing stop loss...");

  try {
    const noStopResult = await litClient.executeJs({
      code: TEST_TRADING_ACTION,
      authContext,
      jsParams: {
        orderParams: JSON.stringify(noStopOrder),
        pkpPublicKey: pkp.publicKey,
      },
    });

    const noStopResponse = JSON.parse(noStopResult.response);
    if (!noStopResponse.success) {
      log("✅", "Missing stop loss correctly REJECTED!", { errors: noStopResponse.errors });
    } else {
      log("❌", "Missing stop loss should have been rejected!");
    }
  } catch (error) {
    log("⚠️", "Error (constraint may have blocked):", { error: error.message });
  }

  // ============================================
  // Summary
  // ============================================
  logSection("Test Summary");

  log("🎉", "All tests completed!");
  log("📋", "PKP Details:", {
    tokenId: pkp.tokenId,
    ethAddress: pkp.ethAddress,
    network: LIT_NETWORK,
  });

  log("💡", "Next steps:");
  console.log("   1. Deploy Lit Action to IPFS for production");
  console.log("   2. Switch to 'naga-test' or 'naga' for production");
  console.log("   3. Set USE_LIT_PKP=true in production .env");
  console.log("   4. For paid networks, set up PaymentManager");

  // Cleanup
  litClient.disconnect();
  log("👋", "Disconnected from Lit network");
}

// Run tests
runTests().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});
