# PKP Trading Verification Checklist

Use this checklist to verify that PKP trading is working correctly in your HyperClaw deployment.

## Pre-Flight Checks

### Environment Configuration

- [ ] `USE_LIT_PKP=true` set in `.env`
- [ ] `LIT_NETWORK=datil` set (or `datil-dev` for testnet)
- [ ] `NEXT_PUBLIC_HYPERLIQUID_TESTNET` matches your target network
- [ ] `NEXT_PUBLIC_BUILDER_ADDRESS` configured (for builder code revenue)
- [ ] `NEXT_PUBLIC_BUILDER_FEE` set (e.g., `10` for 1bp = 0.1%)

### Dependencies

- [ ] `@lit-protocol/lit-node-client` installed
- [ ] `@nktkas/hyperliquid` SDK installed
- [ ] No TypeScript errors in `lib/lit-signing.ts`
- [ ] No TypeScript errors in `lib/agent-runner.ts`

## Agent Creation Tests

### 1. Create PKP Agent via API

```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "PKP Test Agent",
    "markets": ["BTC"],
    "riskLevel": "conservative",
    "maxLeverage": 2,
    "autonomy": {
      "mode": "full_auto",
      "aggressiveness": 50
    },
    "usePKP": true
  }'
```

**Expected Result:**
- [ ] Agent created successfully
- [ ] Response includes `id` and `hlAddress`
- [ ] `hlAddress` is a valid 0x-prefixed Ethereum address

### 2. Verify PKP Account Creation

```typescript
// In Node REPL or script
import { getAccountForAgent, isPKPAccount } from "./lib/account-manager.js";

const agentId = "agent-id-from-above";
const account = await getAccountForAgent(agentId);
console.log("Account:", account);

const isPKP = await isPKPAccount(agentId);
console.log("Is PKP?", isPKP);
```

**Expected Result:**
- [ ] `account.type === "pkp"`
- [ ] `account.tokenId` is a valid hex string
- [ ] `account.publicKey` is a valid hex string (130 chars, uncompressed)
- [ ] `isPKP === true`

### 3. Check Builder Code Approval

```typescript
import { hasBuilderApproval } from "./lib/builder.js";

const agentAddress = account.address; // from above
const approved = await hasBuilderApproval(agentAddress);
console.log("Builder approved?", approved);
```

**Expected Result:**
- [ ] `approved === true` (auto-approved during wallet creation)

## Order Execution Tests

### 4. Manual PKP Order Test

Create a test script:

```typescript
// scripts/test-pkp-order.mjs
import { executeOrderWithPKP } from "./lib/lit-signing.js";

const agentId = "your-pkp-agent-id";
const orderParams = {
  coin: "BTC",
  side: "buy",
  size: 0.001, // Small test size
  orderType: "market",
  slippagePercent: 1,
};

console.log("Executing PKP order...");
const result = await executeOrderWithPKP(agentId, orderParams);
console.log("Order result:", JSON.stringify(result, null, 2));
```

Run:
```bash
node scripts/test-pkp-order.mjs
```

**Expected Result:**
- [ ] No errors thrown
- [ ] Logs show `[PKP] Signing order for xxx: buy 0.001 BTC @ ...`
- [ ] Result includes `status: "ok"` or order details
- [ ] Check Hyperliquid UI to confirm order appeared

### 5. Agent Runner Integration Test

Start the agent runner:

```bash
# Terminal 1: Start dev server
npm run dev

# Terminal 2: Start agent
curl -X POST http://localhost:3000/api/agents/start \
  -H "Content-Type: application/json" \
  -d '{"agentId": "your-pkp-agent-id"}'
```

**Expected Logs:**
- [ ] `[Agent xxx] Using PKP signing for trade execution`
- [ ] No `No HL key found` warnings
- [ ] If market conditions trigger trade:
  - [ ] `[PKP] Signing order for xxx: buy/sell X BTC @ Y`
  - [ ] `[Agent xxx] PKP order executed successfully!`

### 6. Stop-Loss & Take-Profit Test

Modify agent to aggressive mode and watch for full order set:

```bash
curl -X PUT http://localhost:3000/api/agents/your-pkp-agent-id \
  -H "Content-Type: application/json" \
  -d '{
    "autonomy": {
      "mode": "full_auto",
      "aggressiveness": 90
    }
  }'
```

**Expected Logs:**
- [ ] Entry order placed via PKP
- [ ] Stop-loss order placed via PKP (if decision includes SL)
- [ ] Take-profit order placed via PKP (if decision includes TP)
- [ ] All three orders appear in Hyperliquid UI

## Error Handling Tests

### 7. Invalid Order Test

Try to execute an order with invalid parameters:

```typescript
// Should fail gracefully
const invalidParams = {
  coin: "INVALID_COIN",
  side: "buy",
  size: 0.001,
  orderType: "market",
};

try {
  await executeOrderWithPKP(agentId, invalidParams);
} catch (error) {
  console.log("Expected error:", error.message);
}
```

**Expected Result:**
- [ ] Error thrown with descriptive message
- [ ] No crash or hang
- [ ] Agent runner continues after error

### 8. PKP Constraint Violation Test

(Only if constraints are configured)

Try to execute an order that violates constraints:

```typescript
const oversizedOrder = {
  coin: "BTC",
  side: "buy",
  size: 100, // Way over maxPositionSize
  orderType: "market",
};

try {
  await executeOrderWithPKP(agentId, oversizedOrder);
} catch (error) {
  console.log("Constraint violation:", error.message);
}
```

**Expected Result:**
- [ ] Lit Action rejects the order
- [ ] Error mentions constraint violation
- [ ] Order does NOT appear on Hyperliquid

## Performance Tests

### 9. Latency Measurement

Measure PKP signing latency:

```typescript
const start = Date.now();
await executeOrderWithPKP(agentId, orderParams);
const elapsed = Date.now() - start;
console.log(`PKP order took ${elapsed}ms`);
```

**Expected Result:**
- [ ] First execution: 2-5s (Lit client initialization)
- [ ] Subsequent executions: 1-3s (cached client)
- [ ] No timeouts or hangs

### 10. Concurrent Order Test

Execute multiple orders in parallel:

```typescript
const orders = [
  { coin: "BTC", side: "buy", size: 0.001, orderType: "market" },
  { coin: "ETH", side: "buy", size: 0.01, orderType: "market" },
];

const results = await Promise.all(
  orders.map(params => executeOrderWithPKP(agentId, params))
);

console.log("All orders executed:", results.length);
```

**Expected Result:**
- [ ] Both orders execute successfully
- [ ] No rate limit errors (Lit Protocol)
- [ ] Total time < 10s

## UI/Frontend Tests

### 11. Dashboard Display

- [ ] PKP agent appears in dashboard
- [ ] Shows correct wallet address
- [ ] Balance loads correctly
- [ ] "Start Agent" button works

### 12. Agent Detail Page

- [ ] Navigate to `/agents/[id]`
- [ ] Shows "PKP Wallet" indicator
- [ ] Trade history populates
- [ ] Real-time updates work (SSE)

### 13. Trade Execution Log

- [ ] Recent trades show in UI
- [ ] Each trade shows entry + SL + TP orders
- [ ] Timestamps are accurate
- [ ] Confidence scores displayed

## Production Readiness Checks

### 14. Security Review

- [ ] PKP token IDs are stored securely (encrypted or access-controlled)
- [ ] Lit capacity credits configured (no free tier in prod)
- [ ] Builder code auto-approval working (revenue protection)
- [ ] Agent API endpoints protected (authentication)

### 15. Monitoring Setup

- [ ] Agent runner logs are captured (PM2, CloudWatch, etc.)
- [ ] PKP signing errors trigger alerts
- [ ] Trade execution metrics tracked
- [ ] Hyperliquid API errors monitored

### 16. Disaster Recovery

- [ ] PKP token IDs backed up
- [ ] Agent configuration exported
- [ ] Hyperliquid wallet addresses documented
- [ ] Emergency stop procedure defined

## Cleanup

After testing, stop agents:

```bash
curl -X POST http://localhost:3000/api/agents/stop \
  -H "Content-Type: application/json" \
  -d '{"agentId": "your-pkp-agent-id"}'
```

## Troubleshooting

If any checks fail, see `docs/PKP_TRADING_INTEGRATION.md` → Troubleshooting section.

Common issues:
- **"No PKP found"** → Verify `USE_LIT_PKP=true` and agent has `tokenId` in account record
- **"Invalid signature"** → Check chain ID matches (42161 mainnet, 421614 testnet)
- **"Rate limit exceeded"** → Increase tick interval or configure capacity credits
- **Timeouts** → Lit Network congestion, retry or increase timeout

---

**All checks passed?** 🎉 PKP trading is production-ready!
