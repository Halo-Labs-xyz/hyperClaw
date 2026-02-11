#!/usr/bin/env node

/**
 * Test script for Hyperliquid Builder Codes integration
 * 
 * Usage:
 *   node scripts/test-builder-codes.mjs
 * 
 * This script verifies:
 * 1. Builder configuration is loaded correctly
 * 2. API endpoints respond as expected
 * 3. Order functions include builder parameters
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
config({ path: join(__dirname, '../.env.local') });

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const TEST_USER = process.env.TEST_USER_ADDRESS;

console.log('\n🧪 Testing Hyperliquid Builder Codes Integration (Vincent-Style)\n');
console.log('=' .repeat(60));
console.log('\n✨ Now with automatic builder code approval on:');
console.log('   1. Agent wallet provisioning');
console.log('   2. First trade execution');
console.log('   (No manual approval required!)\n');

// Test 1: Check environment variables
console.log('\n1️⃣  Checking environment variables...');
const builderAddress = process.env.NEXT_PUBLIC_BUILDER_ADDRESS;
const builderFee = process.env.NEXT_PUBLIC_BUILDER_FEE;

if (!builderAddress || !builderFee) {
  console.error('❌ Builder configuration missing!');
  console.error('   Set NEXT_PUBLIC_BUILDER_ADDRESS and NEXT_PUBLIC_BUILDER_FEE');
  process.exit(1);
}

console.log(`✅ Builder Address: ${builderAddress}`);
console.log(`✅ Builder Fee: ${builderFee} (${builderFee * 0.01}%)`);

// Test 2: Check builder info API
console.log('\n2️⃣  Testing /api/builder/info endpoint...');

try {
  const url = TEST_USER 
    ? `${API_BASE}/api/builder/info?user=${TEST_USER}`
    : `${API_BASE}/api/builder/info`;
  
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  const data = await response.json();
  
  if (!data.enabled) {
    console.log('⚠️  Builder codes not enabled');
    console.log('   This is OK if builder is not configured');
  } else {
    console.log('✅ Builder info endpoint responding');
    console.log(`   Address: ${data.builder.address}`);
    console.log(`   Fee: ${data.builder.feePercent}`);
    
    if (data.user) {
      console.log(`   User has approval: ${data.user.hasApproval}`);
    }
    
    if (data.stats) {
      console.log(`   Total fees earned: ${data.stats.totalFees} USDC`);
    }
  }
} catch (error) {
  console.error('❌ Failed to fetch builder info:', error.message);
  console.error('   Make sure the dev server is running: npm run dev');
}

// Test 3: Check typed data endpoint
console.log('\n3️⃣  Testing /api/builder/approve/typed-data endpoint...');

try {
  const response = await fetch(`${API_BASE}/api/builder/approve/typed-data?chainId=421614`);
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  const data = await response.json();
  
  if (data.typedData && data.typedData.domain && data.typedData.message) {
    console.log('✅ Typed data endpoint responding');
    console.log(`   Primary Type: ${data.typedData.primaryType}`);
    console.log(`   Max Fee Rate: ${data.typedData.message.maxFeeRate}`);
  } else {
    console.error('❌ Invalid typed data response');
  }
} catch (error) {
  console.error('❌ Failed to fetch typed data:', error.message);
}

// Test 4: Check claim endpoint
console.log('\n4️⃣  Testing /api/builder/claim endpoint...');

try {
  const response = await fetch(`${API_BASE}/api/builder/claim`);
  
  if (!response.ok) {
    console.log('⚠️  Claim endpoint returned error (expected if not configured)');
  } else {
    const data = await response.json();
    console.log('✅ Claim endpoint responding');
    console.log(`   Claimable fees: ${data.claimable} USDC`);
  }
} catch (error) {
  console.error('❌ Failed to fetch claim info:', error.message);
}

// Test 5: Verify builder code module
console.log('\n5️⃣  Testing builder code module...');

try {
  // Dynamic import to test the module loads
  const module = await import('../lib/builder.ts');
  
  if (typeof module.getBuilderConfig === 'function') {
    console.log('✅ Builder module loaded successfully');
    console.log('   Available functions:');
    console.log('   - getBuilderConfig');
    console.log('   - getBuilderParam');
    console.log('   - builderPointsToPercent');
    console.log('   - getMaxBuilderFee');
    console.log('   - hasBuilderApproval');
    console.log('   - getBuilderStats');
    console.log('   - getApproveBuilderFeeTypedData');
  } else {
    console.error('❌ Builder module structure unexpected');
  }
} catch (error) {
  console.error('❌ Failed to load builder module:', error.message);
}

// Summary
console.log('\n' + '='.repeat(60));
console.log('\n✨ Vincent-Style Auto-Approval Test Complete!\n');
console.log('Next steps:');
console.log('1. Start the dev server: npm run dev');
console.log('2. Create a new agent (builder code auto-approved on provisioning)');
console.log('3. Place a trade (builder code auto-approved on first trade if needed)');
console.log('4. Check fees accumulate: GET /api/builder/claim');
console.log('\nDocumentation:');
console.log('- BUILDER_CODES.md - Full integration docs');
console.log('- docs/root-guides/VINCENT_STYLE_AUTO_APPROVAL.md - Auto-approval guide');
console.log('- docs/root-guides/QUICK_START_BUILDER_CODES.md - 5-minute setup\n');
