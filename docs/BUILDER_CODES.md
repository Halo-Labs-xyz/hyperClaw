# Hyperliquid Builder Codes Integration

This document describes how HyperClaw implements Hyperliquid Builder Codes to monetize trades executed through the platform.

## Overview

Builder codes are Hyperliquid's native way for applications to earn fees on trades they facilitate. HyperClaw has been fully integrated with builder codes, allowing the platform to earn revenue on every trade while maintaining complete transparency with users.

## Architecture

```
┌─────────────────┐
│   User Wallet   │
│   (via Privy)   │
└────────┬────────┘
         │
         │ 1. Sign builder approval (one-time, gas-free)
         ▼
┌─────────────────┐
│  HyperClaw App  │
│                 │
│ • Stores approval status
│ • Adds builder param to orders
└────────┬────────┘
         │
         │ 2. Order with builder code
         ▼
┌─────────────────┐
│  Hyperliquid    │
│   Exchange      │
│                 │
│ • Validates builder approval
│ • Executes trade
│ • Credits builder fee
└────────┬────────┘
         │
         │ 3. Fees accumulate
         ▼
┌─────────────────┐
│ Builder Account │
│ (Referral Pool) │
│                 │
│ • Claim anytime
└─────────────────┘
```

## Implementation Details

### 1. Backend Integration

#### `lib/builder.ts`

Core builder code functionality:

- **`getBuilderConfig()`** - Loads builder address and fee from env
- **`getBuilderParam()`** - Formats builder param for orders: `{ b: address, f: fee }`
- **`getMaxBuilderFee(user)`** - Checks user's approved fee amount
- **`hasBuilderApproval(user)`** - Validates if user has sufficient approval
- **`getBuilderStats()`** - Fetches accumulated fees
- **`getApproveBuilderFeeTypedData()`** - Generates EIP-712 data for approval

#### `lib/hyperliquid.ts`

All order functions now support builder codes:

- **`placeOrder()`** - Base limit order with optional builder param
- **`placeMarketOrder()`** - Market order with builder
- **`placeStopLossOrder()`** - Stop loss with builder
- **`placeTakeProfitOrder()`** - Take profit with builder
- **`executeOrder()`** - Unified order execution (adds builder automatically)

Each function:
1. Accepts optional `builder` parameter
2. Falls back to `getBuilderParam()` if not provided
3. Includes builder in order payload if available

### 2. API Endpoints

#### GET `/api/builder/info`

Get builder configuration and user approval status.

**Query Parameters:**
- `user` (optional) - User address to check approval

**Response:**
```json
{
  "enabled": true,
  "builder": {
    "address": "0x...",
    "feePoints": 10,
    "feePercent": "0.1%"
  },
  "user": {
    "address": "0x...",
    "hasApproval": true,
    "needsApproval": false,
    "maxApprovedFee": 10,
    "maxApprovedPercent": "0.1%"
  },
  "stats": {
    "totalFees": "123.45",
    "claimableFees": "123.45"
  }
}
```

#### POST `/api/builder/approve`

Submit signed builder fee approval to Hyperliquid.

**Body:**
```json
{
  "signature": { "r": "0x...", "s": "0x...", "v": 27 },
  "nonce": 1707123456789,
  "chainId": 421614
}
```

**Response:**
```json
{
  "success": true,
  "result": { ... }
}
```

#### GET `/api/builder/approve/typed-data`

Get EIP-712 typed data for client-side signing.

**Query Parameters:**
- `chainId` - Chain ID for signature
- `nonce` (optional) - Timestamp for nonce

**Response:**
```json
{
  "typedData": {
    "domain": { ... },
    "types": { ... },
    "primaryType": "HyperliquidTransaction:ApproveBuilderFee",
    "message": { ... }
  },
  "nonce": 1707123456789
}
```

#### GET `/api/builder/claim`

View claimable builder fees.

**Response:**
```json
{
  "claimable": "123.45",
  "total": "123.45",
  "builderAddress": "0x..."
}
```

#### POST `/api/builder/claim`

Claim accumulated builder fees.

**Response:**
```json
{
  "success": true,
  "message": "Builder fees claimed successfully",
  "result": { ... }
}
```

### 3. Frontend Components

#### `BuilderApproval` Component

React component for handling builder fee approval flow.

**Props:**
- `onApprovalComplete?: () => void` - Callback after successful approval
- `showIfNotNeeded?: boolean` - Whether to show when already approved

**Features:**
- Auto-detects approval status
- Shows approval UI if needed
- Handles EIP-712 signing via Wagmi
- Submits signed approval to Hyperliquid
- Refreshes status after approval

**Usage:**
```tsx
import BuilderApproval from "@/app/components/BuilderApproval";

function YourPage() {
  return (
    <BuilderApproval 
      onApprovalComplete={() => {
        console.log("Builder fee approved!");
        // Proceed with trading flow
      }}
    />
  );
}
```

## Configuration

### Environment Variables

Add to `.env.local`:

```bash
# Builder wallet address (receives fees)
NEXT_PUBLIC_BUILDER_ADDRESS=0x1234567890abcdef...

# Builder fee in tenths of basis points
# 10 = 1 basis point = 0.1%
# 100 = 10 basis points = 1.0%
NEXT_PUBLIC_BUILDER_FEE=10
```

### Fee Calculation

Builder fees are specified in **tenths of basis points**:

| Points | Basis Points | Percentage | Example on $1000 |
|--------|--------------|------------|------------------|
| 1      | 0.1 bp       | 0.01%      | $0.10            |
| 5      | 0.5 bp       | 0.05%      | $0.50            |
| 10     | 1.0 bp       | 0.10%      | $1.00            |
| 50     | 5.0 bp       | 0.50%      | $5.00            |
| 100    | 10.0 bp      | 1.00%      | $10.00           |

**Limits:**
- Perp trades: Max 0.1% (10 bp = 100 points)
- Spot trades: Max 1.0% (100 bp = 1000 points)

## User Flow

### First-Time User

1. **Connect Wallet**
   - User connects via Privy (Monad wallet)

2. **Builder Approval** (one-time)
   - App detects no builder approval
   - Shows `BuilderApproval` component
   - User clicks "Approve Builder Fee"
   - Signs EIP-712 message (gas-free)
   - Approval submitted to Hyperliquid
   - Status updated in app

3. **Start Trading**
   - All trades automatically include builder code
   - Builder fee shown transparently in UI

### Returning User

1. **Auto-Detection**
   - App checks approval status on load
   - If approved, no action needed

2. **Trading**
   - All orders include builder param automatically
   - No additional steps required

## Testing

### Test Builder Approval Flow

```bash
# 1. Start dev server
npm run dev

# 2. Open app in browser
open http://localhost:3000

# 3. Connect wallet

# 4. Check builder info
curl "http://localhost:3000/api/builder/info?user=0xYOUR_ADDRESS"

# 5. After approval, verify
curl "http://localhost:3000/api/builder/info?user=0xYOUR_ADDRESS"
# Should show hasApproval: true
```

### Test Order with Builder Code

```bash
# Place a trade (should include builder code automatically)
curl -X POST http://localhost:3000/api/trade \
  -H "Content-Type: application/json" \
  -d '{
    "coin": "BTC",
    "side": "buy",
    "size": 0.01,
    "orderType": "market",
    "agentId": "your_agent_id"
  }'
```

### Verify Builder Fees

```bash
# Check accumulated fees
curl http://localhost:3000/api/builder/claim

# Response:
# {
#   "claimable": "12.34",
#   "total": "12.34",
#   "builderAddress": "0x..."
# }
```

## Claiming Fees

Builder fees accumulate in the referral pool and can be claimed anytime.

### Prerequisites

- `HYPERLIQUID_PRIVATE_KEY` must match `NEXT_PUBLIC_BUILDER_ADDRESS`
- Builder must have at least 100 USDC in perps account value

### Claim via API

```bash
# Claim all available fees
curl -X POST http://localhost:3000/api/builder/claim
```

### Claim via Hyperliquid UI

Alternatively, claim directly on Hyperliquid:
1. Go to https://app.hyperliquid.xyz/referrals
2. Connect with builder wallet
3. Click "Claim Rewards"

## Troubleshooting

### User Cannot Approve Builder Fee

**Issue:** Approval transaction fails

**Solutions:**
1. Check user has connected correct wallet
2. Verify chain ID matches Hyperliquid requirements
3. Ensure user is on correct network (mainnet/testnet)
4. Check browser console for error details

### Orders Not Including Builder Code

**Issue:** Trades execute without builder param

**Solutions:**
1. Verify `NEXT_PUBLIC_BUILDER_ADDRESS` is set
2. Check `NEXT_PUBLIC_BUILDER_FEE` is valid number
3. Confirm `getBuilderParam()` returns valid object
4. Check order logs in console

### Cannot Claim Fees

**Issue:** Claim endpoint returns error

**Solutions:**
1. Verify `HYPERLIQUID_PRIVATE_KEY` matches builder address
2. Ensure builder has 100+ USDC account value
3. Check builder has accumulated fees > 0
4. Try claiming via Hyperliquid UI directly

## Best Practices

### 1. Transparency

Always show users:
- Builder fee amount before approval
- Approval status in UI
- Builder fee in trade confirmations

### 2. Error Handling

```typescript
try {
  const builderParam = getBuilderParam();
  // Include in order
} catch (error) {
  // Log error but don't block trade
  console.warn("Builder param unavailable:", error);
  // Proceed without builder code
}
```

### 3. Approval State Management

```typescript
// Check approval before allowing trades
const hasApproval = await hasBuilderApproval(userAddress);

if (!hasApproval) {
  // Show BuilderApproval component
  return <BuilderApproval onApprovalComplete={proceedToTrade} />;
}
```

### 4. Testing

Always test on Hyperliquid testnet first:
1. Set `NEXT_PUBLIC_HYPERLIQUID_TESTNET=true`
2. Use testnet wallet for builder
3. Test approval flow end-to-end
4. Verify fees appear in referral pool
5. Test claiming fees

## Resources

- [Hyperliquid Builder Codes Docs](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes)
- [Hyperliquid Python SDK Example](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/examples/basic_builder_fee.py)
- [EIP-712 Specification](https://eips.ethereum.org/EIPS/eip-712)

## Support

For issues or questions:
1. Check Hyperliquid docs
2. Review implementation in `lib/builder.ts`
3. Test on testnet first
4. Open GitHub issue with reproduction steps
