# Lit Protocol v8 (Naga) Integration for HyperClaw

This document explains how HyperClaw uses Lit Protocol for secure, distributed key management of agent trading wallets.

> **Updated for Lit SDK v8 (Naga)** - This integration uses the latest Lit Protocol SDK with the new `createLitClient()` API, `authContext` authentication model, and `jsParams.*` access pattern in Lit Actions.

## Overview

HyperClaw supports two wallet modes for trading agents, **both with automatic builder code approval**:

| Mode | Security | Key Storage | Builder Approval | Best For |
|------|----------|-------------|------------------|----------|
| **PKP** (recommended) | High | Distributed across Lit network | Auto (via PKP) | Production, high-value agents |
| **Traditional** | Medium | Encrypted on server | Auto (via private key) | Development, quick testing |

### Builder Code Integration

Both wallet modes automatically approve Hyperliquid builder codes during:
1. **Wallet provisioning** - Approved when agent is created
2. **First trade** - Auto-approved if not done during provisioning

This implements **Vincent-style automatic approval** for seamless UX with guaranteed builder fee revenue.

## Why Lit Protocol?

### The Problem with Traditional Key Management

In traditional mode, HyperClaw stores agent private keys encrypted with AES-256. While this is reasonably secure, it has risks:

- **Single point of failure**: If the server or encryption key is compromised, all agent wallets are exposed
- **Full key exposure during signing**: The private key is decrypted in memory for each transaction
- **No constraint enforcement at crypto layer**: Trading rules are enforced in application code

### The PKP Solution

Lit Protocol's Programmable Key Pairs (PKPs) solve these issues:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Traditional Mode                            │
│  ┌─────────┐    ┌───────────────┐    ┌──────────────────────┐   │
│  │ Backend │───▶│ Decrypt Key   │───▶│ Sign Transaction     │   │
│  │         │    │ (full key     │    │ (key in memory)      │   │
│  │         │    │  exposed)     │    │                      │   │
│  └─────────┘    └───────────────┘    └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         PKP Mode                                 │
│  ┌─────────┐    ┌───────────────┐    ┌──────────────────────┐   │
│  │ Backend │───▶│ Lit Network   │───▶│ Threshold Signing    │   │
│  │         │    │ (validates    │    │ (key shares only,    │   │
│  │         │    │  constraints) │    │  never assembled)    │   │
│  └─────────┘    └───────────────┘    └──────────────────────┘   │
│                                                                  │
│  Private key NEVER exists in full form!                         │
└─────────────────────────────────────────────────────────────────┘
```

## Architecture

### Components

1. **`lib/lit-protocol.ts`** - Core Lit client and PKP management
2. **`lib/lit-auth.ts`** - Authentication and session management
3. **`lib/lit-actions/trading-action.ts`** - Serverless signing logic
4. **`lib/lit-signing.ts`** - Integration layer for Hyperliquid orders

### Flow: Creating a PKP Agent Wallet with Builder Approval

```typescript
// 1. Enable PKP mode in .env
USE_LIT_PKP=true

// 2. Provision agent (automatically creates PKP + approves builder code)
const result = await provisionAgentWallet(agentId, 1000, {
  mode: "pkp",
  constraints: {
    maxPositionSizeUsd: 5000,
    allowedCoins: ["BTC", "ETH", "SOL"],
    maxLeverage: 10,
    requireStopLoss: true,
  },
});

console.log(result);
// {
//   address: "0x...",
//   funded: true,
//   signingMethod: "pkp",
//   builderApproved: true,  ← Auto-approved via PKP signing
// }
```

### Flow: Signing a Trade with PKP

```typescript
import { signOrderWithPKP } from "@/lib/lit-signing";

// Order goes through Lit Action which enforces constraints
const result = await signOrderWithPKP(agentId, {
  coin: "ETH",
  side: "long",
  size: 0.1,
  orderType: "market",
}, currentPrice);

if (result.success) {
  // Submit signed order to Hyperliquid
  console.log("Signature:", result.signature);
} else {
  // Constraint violation or error
  console.log("Rejected:", result.errors);
}
```

## Trading Constraints

Constraints are enforced at the cryptographic layer by Lit Actions. Even if your backend is compromised, the Lit Action will refuse to sign orders that violate constraints.

### Available Constraints

```typescript
interface PKPTradingConstraints {
  maxPositionSizeUsd: number;   // Max notional value per trade
  allowedCoins: string[];       // Whitelist of tradeable assets
  maxLeverage: number;          // Maximum leverage allowed
  requireStopLoss: boolean;     // Require SL on new positions
  maxDailyTrades: number;       // Rate limit
  cooldownMs: number;           // Min time between trades
}
```

### Pre-built Constraint Templates

```typescript
import { 
  CONSERVATIVE_TRADING_ACTION,
  MODERATE_TRADING_ACTION,
  AGGRESSIVE_TRADING_ACTION,
} from "@/lib/lit-actions/trading-action";

// Conservative: $1k max, 3x leverage, BTC/ETH only
// Moderate: $5k max, 10x leverage, top coins
// Aggressive: $20k max, 20x leverage, many coins
```

## Setup Guide

### 1. Install Dependencies

```bash
npm install
```

This adds the Lit Protocol v8 packages:
- `@lit-protocol/lit-client` - Core client (replaces `lit-node-client`)
- `@lit-protocol/networks` - Network modules (nagaDev, nagaTest, naga)
- `@lit-protocol/auth` - Authentication manager
- `@lit-protocol/contracts` - Contract interactions
- `viem` - Ethereum interactions (peer dependency)

### 2. Configure Environment

```bash
# .env.local
USE_LIT_PKP=true
LIT_NETWORK=naga-dev  # naga-dev (free), naga-test (paid testnet), naga (mainnet)
```

### 3. Fund Chronicle Yellowstone Wallet

PKP minting requires tstLPX tokens on Chronicle Yellowstone (Lit's chain):

1. Get your operator address: The same wallet as `HYPERLIQUID_PRIVATE_KEY`
2. Get testnet tokens: https://chronicle-yellowstone-faucet.litprotocol.com/
3. Each PKP mint costs a small amount of tstLPX

**Network Details:**
- **Chain ID:** 175188 (0x2ac54)
- **RPC URL:** https://yellowstone-rpc.litprotocol.com/
- **Currency:** tstLPX

### 4. Test PKP Creation

```bash
# Run the test script
npm run test:lit
```

Or programmatically:

```typescript
import { mintPKP, getLitClient } from "@/lib/lit-protocol";

// Initialize client (connects automatically in v8)
const client = await getLitClient();

// Mint PKP
const pkp = await mintPKP();

console.log("PKP Address:", pkp.ethAddress);
console.log("PKP Token ID:", pkp.tokenId);
console.log("TX Hash:", pkp.txHash);
```

## Migration from Traditional to PKP

### Option A: New Agents Only (Recommended)

Keep existing agents on traditional mode, create new agents with PKP:

```typescript
// New agents automatically get PKP if USE_LIT_PKP=true
await provisionAgentWallet(newAgentId, 1000);
```

### Option B: Migrate Existing Agent

1. Create a new PKP wallet for the agent
2. Transfer funds from old wallet to new PKP wallet
3. Update agent's account reference

```typescript
import { provisionPKPForAgent } from "@/lib/lit-signing";
import { sendUsdToAgent } from "@/lib/hyperliquid";

// Create PKP for existing agent
const pkpResult = await provisionPKPForAgent(agentId, {
  maxPositionSizeUsd: 10000,
  allowedCoins: agent.markets,
});

// Transfer funds from old wallet to PKP
// (requires manual withdrawal from old wallet first)
await sendUsdToAgent(pkpResult.address, fundAmount);
```

## Security Considerations

### What PKP Protects Against

✅ Server compromise (private key never on server)
✅ Database leaks (no encrypted keys stored for PKP accounts)
✅ Insider threats (constraints enforced cryptographically)
✅ Replay attacks (timestamp validation in Lit Action)

### What PKP Does NOT Protect Against

⚠️ Lit network compromise (highly unlikely, threshold distributed)
⚠️ Operator key compromise (can mint new PKPs, not steal existing)
⚠️ Application logic bugs (validate before sending to Lit)

### Best Practices

1. **Use specific Lit Action CIDs**: Deploy actions to IPFS and reference by CID
2. **Audit constraints carefully**: They're immutable once deployed
3. **Monitor session usage**: Track session creation and expiration
4. **Rotate operator keys periodically**: The key that owns PKPs

## API Reference

### Core Functions

```typescript
// Provision PKP wallet
provisionAgentWallet(agentId, fundingAmount, { mode: "pkp" })

// Sign order with PKP
signOrderWithPKP(agentId, orderParams, price)

// Check if agent uses PKP
isPKPAccount(agentId)

// Get agent's signing method
getAgentSigningMethod(agentId) // "pkp" | "traditional" | "none"
```

### Account Manager Extensions

```typescript
// Add PKP account manually
addPKPAccount({
  alias: "my-pkp",
  agentId: "...",
  pkpTokenId: "...",
  pkpPublicKey: "...",
  pkpEthAddress: "0x...",
  constraints: {...},
})

// Get PKP info
getPKPForAgent(agentId)

// Update constraints (requires new Lit Action deployment)
updatePKPConstraints(alias, newConstraints)
```

### Lit Protocol Direct Access

```typescript
import { getLitNodeClient, mintPKP } from "@/lib/lit-protocol";
import { getSessionSigsForPKP } from "@/lib/lit-auth";

// Direct Lit client access
const client = await getLitNodeClient();

// Mint PKP manually
const pkp = await mintPKP(signer);

// Get session for PKP
const sessionSigs = await getSessionSigsForPKP({
  pkpPublicKey: "...",
  pkpTokenId: "...",
  pkpEthAddress: "0x...",
});
```

## Troubleshooting

### "Failed to get session"

- Check that LIT_NETWORK matches where you minted the PKP
- Ensure operator has access to the PKP
- Verify PKP token ID is correct

### "Constraint violation" errors

- Check the specific error message for which constraint failed
- Verify order parameters match constraints
- Ensure timestamp is fresh (within 60 seconds)

### "No signature returned"

- Lit Action may have thrown an error - check logs
- Session may have expired - will auto-refresh
- PKP may not have the Lit Action permitted

### Slow signing (>5s)

- Normal for first request (session creation)
- Subsequent requests should be ~1-2s
- Consider warming up sessions on agent startup

## Cost Considerations

| Operation | Cost |
|-----------|------|
| PKP Mint | ~0.0001 LIT (one-time) |
| Session Creation | Free |
| Lit Action Execution | ~0.00001 LIT per sign |

For 1000 trades/month: ~0.01 LIT ≈ negligible

## Builder Code Integration

HyperClaw automatically approves builder codes for both PKP and traditional wallets:

### PKP Builder Approval

```typescript
// Signed via Lit Protocol (no private key exposure)
const approvalResult = await signBuilderApprovalWithPKP(agentId);

if (approvalResult.success) {
  // Submit to Hyperliquid
  await info.custom({
    action: approvalResult.action,
    signature: approvalResult.signature,
  });
}
```

### Traditional Builder Approval

```typescript
// Signed with private key
const approvalResult = await autoApproveBuilderCode(
  address,
  privateKey,
  agentId
);
```

### Unified Approval (Auto-Detects Mode)

```typescript
// Works for both PKP and traditional
await ensureBuilderApproval(
  agentAddress,
  privateKey || undefined,  // Optional for PKP
  agentId                   // Used for PKP signing
);
```

**See**: `docs/PKP_BUILDER_CODE_INTEGRATION.md` for complete builder code + PKP documentation.

## Future Enhancements

- [x] ✅ Vincent-style auto-approval for builder codes
- [x] ✅ PKP signing support for builder approvals
- [ ] IPFS deployment integration for Lit Actions
- [ ] Multi-sig PKP for high-value agents
- [ ] Session persistence across server restarts
- [ ] Lit Action hot-reload for constraint updates
