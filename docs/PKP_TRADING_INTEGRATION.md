# PKP Trading Integration

Complete guide to Programmable Key Pair (PKP) trading in HyperClaw.

## Overview

PKP agents use **distributed threshold signing** via Lit Protocol to execute trades on Hyperliquid without ever exposing a full private key. All trading operations—market orders, stop-losses, take-profits, and builder code approvals—are signed via the Lit Network with cryptographically enforced constraints.

## Architecture

```mermaid
flowchart TB
    subgraph Agent["Agent Runner"]
        Tick["executeTick()"]
        Decision["AI Trade Decision"]
    end
    
    subgraph Signing["Signing Layer"]
        Detect["Detect Wallet Type<br/>(PKP vs Traditional)"]
        PKPPath["executeOrderWithPKP()"]
        TradPath["executeOrder()"]
    end
    
    subgraph Lit["Lit Protocol"]
        Action["Lit Action<br/>(constraint validation)"]
        Nodes["Lit Network Nodes<br/>(threshold signing)"]
        Sig["Signature Shares"]
    end
    
    subgraph HL["Hyperliquid"]
        API["Exchange API"]
        Fill["Order Execution"]
    end
    
    Tick --> Decision
    Decision --> Detect
    Detect -->|isPKP=true| PKPPath
    Detect -->|isPKP=false| TradPath
    PKPPath --> Action
    Action -->|validate constraints| Nodes
    Nodes -->|combine shares| Sig
    Sig -->|signed order| API
    API --> Fill
    TradPath -->|wallet.sign()| API
```

## Key Features

### 1. **Full Trading Execution**
- ✅ Market orders
- ✅ Limit orders
- ✅ Stop-loss orders (TP/SL)
- ✅ Take-profit orders
- ✅ Builder code auto-approval
- 🚧 Leverage updates (coming soon)

### 2. **Cryptographic Constraints**
Lit Actions enforce trading rules at the signature level:
- Maximum position size per trade
- Allowed coins/markets
- Price deviation limits
- Rate limiting (max trades per hour)
- Emergency stop conditions

### 3. **Seamless Integration**
The agent runner automatically detects PKP wallets and routes through PKP signing:

```typescript
// Agent runner automatically detects signing method
const isPKP = await isPKPAccount(agentId);

if (isPKP) {
  // Use PKP signing
  const { executeOrderWithPKP } = await import("./lit-signing");
  await executeOrderWithPKP(agentId, orderParams);
} else {
  // Use traditional wallet signing
  await executeOrder(orderParams, exchangeClient);
}
```

## How It Works

### Order Execution Flow

1. **Agent Tick Cycle**
   ```
   Agent Runner → Fetch Market Data → AI Decision → Execute Trade
   ```

2. **PKP Signing Detection**
   ```typescript
   const isPKP = await isPKPAccount(agentId);
   if (isPKP) {
     console.log(`[Agent ${agentId}] Using PKP signing for trade execution`);
   }
   ```

3. **Order Construction**
   - Agent runner builds standard `PlaceOrderParams`
   - Converts to Hyperliquid's native order format
   - Includes asset index, size, price, reduce-only flags, builder codes

4. **Lit Action Execution**
   - Constructs L1 action hash (matches Hyperliquid SDK's `createL1ActionHash`)
   - Executes Lit Action with order params + constraints
   - Lit Action validates:
     - Position size within limits
     - Coin is in allowed list
     - Price is reasonable (no fat-finger protection)
     - Rate limits not exceeded

5. **Threshold Signing**
   - Lit Action requests ECDSA signature from Lit Network
   - 2/3 of nodes must agree to sign
   - Signature shares combined into final signature

6. **Order Submission**
   - Signed order submitted to Hyperliquid via REST API
   - Same format as SDK's `ExchangeClient.order()`
   - Returns standard HL order response (status, fills, oid)

## Configuration

### Environment Variables

```bash
# Enable PKP mode
USE_LIT_PKP=true

# Lit Network (datil-dev for testnet, datil for mainnet)
LIT_NETWORK=datil

# Hyperliquid Network (must match Lit Actions)
NEXT_PUBLIC_HYPERLIQUID_TESTNET=false
```

### Creating PKP Agents

```typescript
// Via API
POST /api/agents
{
  "name": "PKP Trader",
  "markets": ["BTC", "ETH"],
  "autonomy": { "mode": "full_auto" },
  "usePKP": true  // ← Enable PKP wallet
}
```

PKP wallet creation:
1. Mints new PKP on Lit Protocol
2. Derives Ethereum address from PKP public key
3. Stores PKP token ID + public key in `.data/accounts.json`
4. Auto-approves builder code via PKP signing
5. Ready to trade immediately

### Trading Constraints

Default constraints (can be customized per agent):

```typescript
{
  maxPositionSize: 1000,        // Max $1000 per trade
  allowedCoins: ["BTC", "ETH"], // Whitelisted markets
  maxPriceDeviation: 0.05,      // 5% slippage protection
  maxTradesPerHour: 10,         // Rate limiting
}
```

To customize constraints, modify the agent's PKP record:

```typescript
// Update agent's trading constraints
const agent = await getAgent(agentId);
const pkp = await getPKPForAgent(agentId);

await updatePKPConstraints(agentId, {
  ...pkp.constraints,
  maxPositionSize: 5000, // Increase to $5k
  allowedCoins: ["BTC", "ETH", "SOL"], // Add SOL
});
```

## Implementation Details

### Agent Runner (`lib/agent-runner.ts`)

```typescript
// Detect wallet type at tick start
const isPKP = agentAccount ? await isPKPAccount(agentId) : false;
const signingMethod = isPKP ? "pkp" : "traditional";

// Execute market entry order
if (isPKP) {
  const { executeOrderWithPKP } = await import("./lit-signing");
  await executeOrderWithPKP(agentId, entryParams);
} else if (ex) {
  await executeOrder(entryParams, ex);
}

// Execute stop-loss (same pattern)
if ((isPKP || ex) && decision.stopLoss) {
  const slParams: PlaceOrderParams = { /* ... */ };
  
  if (isPKP) {
    await executeOrderWithPKP(agentId, slParams);
  } else {
    await executeOrder(slParams, ex);
  }
}
```

### PKP Order Execution (`lib/lit-signing.ts`)

```typescript
export async function executeOrderWithPKP(
  agentId: string,
  orderParams: PlaceOrderParams
): Promise<unknown> {
  // 1. Get PKP info
  const pkpInfo = await getPKPForAgent(agentId);
  
  // 2. Resolve asset index and price
  const assetIndex = await getAssetIndex(orderParams.coin);
  const orderPrice = /* calculate or use provided */;
  
  // 3. Build Hyperliquid order action
  const action = {
    type: "order",
    orders: [{
      a: assetIndex,
      b: isBuy,
      p: formattedPrice,
      s: formattedSize,
      r: orderParams.reduceOnly,
      t: orderTypeMap[orderParams.orderType],
    }],
    grouping: "na",
  };
  
  // 4. Execute Lit Action to sign order
  const result = await executeLitAction({
    code: litActionCode, // Contains constraint validation
    jsParams: {
      action: JSON.stringify(action),
      nonce: Date.now(),
      pkpPublicKey: pkpInfo.publicKey,
    },
  });
  
  // 5. Submit signed order to Hyperliquid
  const response = await fetch(hlEndpoint, {
    method: "POST",
    body: JSON.stringify({
      action,
      nonce,
      signature: { r, s, v },
    }),
  });
  
  return await response.json();
}
```

### Builder Code Auto-Approval

PKP agents auto-approve builder codes during wallet creation:

```typescript
// lib/builder.ts
export async function autoApproveBuilderCode(
  agentAddress: Address,
  agentPrivateKey?: string,
  agentId?: string
) {
  // Check if approval needed
  const needsApproval = await needsBuilderApproval(agentAddress);
  if (!needsApproval) return { success: true, alreadyApproved: true };
  
  // Detect signing method
  const isPKP = agentId ? await isPKPAccount(agentId) : false;
  
  if (isPKP) {
    // Sign via PKP
    const { signBuilderApprovalWithPKP } = await import("./lit-signing");
    const result = await signBuilderApprovalWithPKP(agentId);
    
    // Submit signed approval to Hyperliquid
    await submitApproval(result.action, result.signature);
    return { success: true };
  } else {
    // Traditional signing via ExchangeClient
    await exchange.approveBuilderFee({ builder, maxFeeRate });
    return { success: true };
  }
}
```

## Security Considerations

### Key Safety
- ✅ Private key **never exists in full form**
- ✅ No single node can sign alone (2/3 threshold)
- ✅ Operator's Lit capacity credit is the only centralized dependency
- ✅ PKP token ID stored in plain text (public info)
- ✅ Public key stored in plain text (derivable from token ID)

### Constraint Enforcement
- ✅ Constraints are enforced in Lit Action code (can't be bypassed)
- ⚠️ Lit Action code is immutable once deployed to IPFS
- ⚠️ Pre-deployment: constraints stored in `.data/accounts.json` (mutable)
- 🎯 Best practice: Deploy Lit Action to IPFS after testing, store CID in agent record

### Rate Limiting
- ✅ Lit Action can track trades per hour via Lit KV storage
- ✅ Agent runner respects tick intervals (default 60s)
- ⚠️ Multiple agent runner instances could bypass rate limits (use centralized KV)

## Troubleshooting

### Agent says "No HL key found; tick will analyze but not execute orders"

**Cause**: Agent runner can't find a signing method (neither PKP nor traditional).

**Fix**:
1. Check agent's account record:
   ```typescript
   const account = await getAccountForAgent(agentId);
   console.log(account); // Should have either 'encryptedKey' or 'tokenId'
   ```
2. If PKP: Verify `USE_LIT_PKP=true` and `LIT_NETWORK` is set
3. If traditional: Verify encrypted key exists and `ENCRYPTION_KEY` env var is set

### "PKP signing failed: No PKP found for agent"

**Cause**: Agent record doesn't have PKP info (no `tokenId` or `publicKey`).

**Fix**:
```typescript
// Recreate PKP wallet for agent
const { createPKPForAgent } = await import("./lit-protocol");
const pkp = await createPKPForAgent(agentId);
console.log(`New PKP created: ${pkp.tokenId}`);
```

### "Hyperliquid order failed: Invalid signature"

**Cause**: Lit Action's signing logic doesn't match Hyperliquid's expected format.

**Fix**:
1. Verify chain ID matches (Arbitrum mainnet: 42161, testnet: 421614)
2. Check EIP-712 domain matches Hyperliquid's exact format:
   ```typescript
   {
     name: "Exchange",
     version: "1",
     chainId: 42161,
     verifyingContract: "0x0000000000000000000000000000000000000000",
   }
   ```
3. Ensure L1 action hash construction matches `@nktkas/hyperliquid` SDK

### "Rate limit exceeded"

**Cause**: Lit Protocol has rate limits on Lit Action executions.

**Fix**:
1. Increase agent tick interval: `AGENT_TICK_INTERVAL=120000` (2 minutes)
2. Use capacity credit delegation (production)
3. Deploy Lit Action to IPFS to reduce network overhead

## Testing

### Manual PKP Trade Test

```typescript
// scripts/test-pkp-trading.mjs
import { executeOrderWithPKP } from "../lib/lit-signing.js";

const agentId = "your-agent-id";
const orderParams = {
  coin: "BTC",
  side: "buy",
  size: 0.001,
  orderType: "market",
  slippagePercent: 1,
};

const result = await executeOrderWithPKP(agentId, orderParams);
console.log("Order result:", result);
```

Run:
```bash
node scripts/test-pkp-trading.mjs
```

### Integration Test

Start agent runner and watch logs:
```bash
npm run dev

# In another terminal, start an agent
curl -X POST http://localhost:3000/api/agents/start \
  -H "Content-Type: application/json" \
  -d '{"agentId": "your-pkp-agent-id"}'

# Watch logs for:
# [Agent xxx] Using PKP signing for trade execution
# [PKP] Signing order for xxx: buy 0.001 BTC @ 50000
# [Agent xxx] PKP order executed successfully!
```

## Future Enhancements

- [ ] **Leverage updates via PKP** - Currently uses default leverage for PKP agents
- [ ] **Multi-sig PKP wallets** - Require multiple PKP approvals for high-value trades
- [ ] **Dynamic constraint updates** - Adjust constraints based on agent performance
- [ ] **Cross-chain PKP** - Use same PKP for Monad deposits + Hyperliquid trades
- [ ] **Lit KV for rate limiting** - Centralized rate limit tracking across instances
- [ ] **Lit Action IPFS deployment** - One-click deploy constraints to IPFS

## Resources

- [Lit Protocol Docs](https://developer.litprotocol.com/)
- [Hyperliquid API Docs](https://hyperliquid.gitbook.io/)
- [HyperClaw PKP Setup Guide](./LIT_PROTOCOL_INTEGRATION.md)
- [Agent Runner Source](../lib/agent-runner.ts)
- [PKP Signing Source](../lib/lit-signing.ts)
- [Builder Code Integration](./PKP_BUILDER_CODE_INTEGRATION.md)
