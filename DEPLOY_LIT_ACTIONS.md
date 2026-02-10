# Deploy Lit Actions to IPFS - Step by Step

## Current Status

✅ Lit Protocol v8 (Naga) integrated  
✅ Constraint enforcement tested and working  
✅ PKP successfully minted on naga-dev  
✅ Three preset actions ready to deploy  

## Before You Deploy

You need Pinata API credentials to upload Lit Actions to IPFS.

### Get Pinata API Keys

1. Go to https://pinata.cloud
2. Sign up for a free account
3. Navigate to **API Keys** in the dashboard
4. Click **New Key** and generate with the following permissions:
   - `pinFileToIPFS` ✅
   - `pinJSONToIPFS` ✅
5. Copy both:
   - **API Key**
   - **API Secret**

### Add to Environment

```bash
# Add to .env
PINATA_API_KEY=your_pinata_api_key_here
PINATA_API_SECRET=your_pinata_api_secret_here
```

## Deploy Lit Actions

### Run Deployment Script

```bash
npm run deploy:lit-actions
```

### Expected Output

```
==================================================
  Lit Action IPFS Deployment
==================================================

📦 Building conservative preset...
   Max Position: $1000
   Max Leverage: 3x
   Allowed Coins: BTC, ETH
   Stop Loss Required: true
   Code size: 4364 bytes
   Uploading to IPFS...
   ✅ Uploaded! CID: QmXabc...123

📦 Building moderate preset...
   ✅ Uploaded! CID: QmXdef...456

📦 Building aggressive preset...
   ✅ Uploaded! CID: QmXghi...789

==================================================
  Deployment Summary
==================================================

📄 Config saved to: lib/lit-action-cids.json

📋 Add to .env for production:

LIT_ACTION_CID_CONSERVATIVE=QmXabc...123
LIT_ACTION_CID_MODERATE=QmXdef...456
LIT_ACTION_CID_AGGRESSIVE=QmXghi...789

✅ Done!
```

## After Deployment

### 1. Update Environment Variables

Add the CIDs to your production `.env`:

```env
LIT_ACTION_CID_CONSERVATIVE=QmXabc...123
LIT_ACTION_CID_MODERATE=QmXdef...456
LIT_ACTION_CID_AGGRESSIVE=QmXghi...789
```

### 2. Verify on IPFS Gateway

Check that your actions are accessible:

```bash
curl https://gateway.pinata.cloud/ipfs/QmXabc...123
```

Should return your Lit Action JavaScript code.

### 3. Create Agent with Specific Preset

```typescript
import { provisionAgentWallet } from "@/lib/hyperliquid";
import { readJSON } from "@/lib/store-backend";

// Load deployed CIDs
const actionCids = await readJSON("lit-action-cids.json");

// Create agent with moderate preset
const result = await provisionAgentWallet(agentId, 1000, {
  mode: "pkp",
  constraints: {
    // Use the deployed action by referencing its CID
    litActionCid: actionCids.presets.moderate.ipfsCid,
    // Constraints are baked into the action
    ...actionCids.presets.moderate.constraints,
  },
});
```

### 4. Switch to Production Network

When ready for mainnet:

```env
LIT_NETWORK=naga  # or naga-test for testnet
```

And fund the payment ledger (see `LIT_PROTOCOL_SETUP.md` for details).

## Preset Details

### Conservative (Low Risk)

```javascript
{
  maxPositionSizeUsd: 1000,
  allowedCoins: ["BTC", "ETH"],
  maxLeverage: 3,
  requireStopLoss: true,
  maxDailyTrades: 10,
  cooldownMs: 300000  // 5 minutes
}
```

**Best for:** New agents, small capital, risk-averse users

### Moderate (Balanced)

```javascript
{
  maxPositionSizeUsd: 5000,
  allowedCoins: ["BTC", "ETH", "SOL", "ARB", "AVAX"],
  maxLeverage: 10,
  requireStopLoss: true,
  maxDailyTrades: 30,
  cooldownMs: 60000  // 1 minute
}
```

**Best for:** Experienced traders, medium capital, balanced approach

### Aggressive (High Risk)

```javascript
{
  maxPositionSizeUsd: 20000,
  allowedCoins: ["BTC", "ETH", "SOL", "ARB", "AVAX", "DOGE", "MATIC", "LINK", "OP", "SUI", "APT", "INJ"],
  maxLeverage: 20,
  requireStopLoss: false,
  maxDailyTrades: 100,
  cooldownMs: 30000  // 30 seconds
}
```

**Best for:** High-frequency trading, large capital, risk-tolerant users

## Custom Constraints

To create a custom Lit Action:

```typescript
import { generateTradingLitAction } from "@/lib/lit-protocol";

const customAction = generateTradingLitAction({
  maxPositionSizeUsd: 3000,
  allowedCoins: ["BTC", "ETH", "SOL"],
  maxLeverage: 5,
  requireStopLoss: true,
  maxDailyTrades: 20,
  cooldownMs: 120000,
});

// Save to file
fs.writeFileSync("custom-lit-action.js", customAction);

// Then upload to Pinata manually or via API
```

## Verification Checklist

Before going to production:

- [ ] Pinata API keys added to `.env`
- [ ] Lit Actions deployed to IPFS
- [ ] CIDs added to `.env.production`
- [ ] CIDs verified on IPFS gateway
- [ ] Payment ledger funded (if using paid network)
- [ ] Test PKP creation on target network
- [ ] Test constraint enforcement on target network
- [ ] Monitor first trades for proper signing

## Support

If you encounter issues:

1. Check `lib/lit-action-cids.json` for deployment status
2. Verify IPFS gateway accessibility
3. Ensure PKP has the Lit Action added to permissions
4. Check Lit network status: https://uptime.getlit.dev/

---

**Ready to ship!** 🚀
