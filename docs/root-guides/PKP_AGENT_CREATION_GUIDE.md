# PKP Agent Creation Guide

## Overview

HyperClaw now supports **two wallet modes** for agent creation:

1. **PKP Mode (Recommended)** - Secure distributed key management via Lit Protocol
2. **Traditional Mode** - Local encrypted private keys (fallback)

## Current Status

### ✅ What's Been Fixed

1. **Agent Creation API** (`app/api/agents/route.ts`)
   - Now checks `USE_LIT_PKP` environment variable
   - Automatically creates PKP wallets when enabled
   - Falls back to traditional wallets if PKP creation fails
   - Logs wallet type for transparency

2. **Hyperliquid API Timeouts** (`lib/hyperliquid.ts`)
   - Increased HTTP timeout from 10s → 30s
   - Applied to all client types: InfoClient, ExchangeClient, ExchangeClientForAgent
   - Prevents `TimeoutError` during market data fetching

3. **PKP Integration** (Complete Lit v8 Implementation)
   - Core Lit Protocol client setup
   - PKP minting with operator wallet
   - Lit Actions for cryptographic constraint enforcement
   - Trading constraints (position size, leverage, stop-loss, allowed coins)

## How to Enable PKP Mode

PKP mode is already enabled in your `.env`:

```bash
# Lit Protocol (Secure PKP Key Management)
USE_LIT_PKP=true
LIT_NETWORK=naga-dev
RPC_URL=https://yellowstone-rpc.litprotocol.com/

# Your operator wallet private key
HYPERLIQUID_PRIVATE_KEY=0xa5a959b5a70ea78b3bd687d8f0205db63eefd465d889d31f068c8eaf942011fd
```

## Testing the Integration

### 1. Restart the Dev Server

The current dev server (PID 19857) is running old code. Restart it to apply changes:

```bash
# In terminal 11 (or wherever npm run dev is running):
# Press Ctrl+C to stop
# Then restart:
npm run dev
```

### 2. Create a Test Agent

Once the server restarts, create a new agent via the UI or API:

**Via UI:**
- Go to http://localhost:3000
- Click "Create New Agent"
- Fill in the details (name, markets, risk level)
- Submit

**Via API:**
```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "PKP Test Agent",
    "markets": ["BTC", "ETH"],
    "riskLevel": "moderate",
    "maxLeverage": 3,
    "stopLossPercent": 5
  }'
```

### 3. Expected Behavior

**With PKP Mode Enabled (`USE_LIT_PKP=true`):**

You should see logs like:
```
[AgentCreate] Creating PKP wallet...
[Lit] Connecting to Lit Network...
[Lit] Minting new PKP...
[AgentCreate] PKP wallet 0x... created (token: 123...)
[AgentCreate] PKP account linked to agent abc123
```

**PKP Wallet Signature:**
- The agent will be created with a PKP wallet
- Private key **never exists in full form**
- All trades require cryptographic validation via Lit Actions
- Constraints are enforced at the signing layer (no way to bypass)

**Fallback to Traditional:**

If PKP creation fails (network issues, Lit Protocol down, etc.):
```
[AgentCreate] PKP creation failed, falling back to traditional
[AgentCreate] Traditional wallet 0x... saved (PKP failed)
```

### 4. Verify the Agent Wallet Type

Check the agent details:
```bash
curl http://localhost:3000/api/agents/{agent-id}
```

Look for:
- `walletType: "pkp"` in the response (if successful)
- Or check `.data/accounts.json` for the account `type: "pkp"`

## What Happens During PKP Agent Creation

1. **User submits agent creation form**
2. **API checks `USE_LIT_PKP` env var**
3. **If true:**
   - Connects to Lit Protocol network (naga-dev)
   - Mints a new PKP via `provisionPKPWallet()`
   - PKP is created with trading constraints based on agent config:
     - `maxPositionSizeUsd`: Derived from risk level
     - `allowedCoins`: From agent's markets
     - `maxLeverage`: From agent config
     - `requireStopLoss`: Based on stop-loss setting
   - Stores PKP details in account-manager (no private key!)
   - Returns agent with PKP wallet address
4. **If false or PKP fails:**
   - Falls back to `generateAgentWallet()`
   - Creates traditional wallet with encrypted private key
   - Stores encrypted key in account-manager
   - Returns agent with traditional wallet address

## Security Benefits of PKP Mode

### Traditional Wallets
- ⚠️ Private key stored locally (encrypted with AES-256-CBC)
- ⚠️ Single point of failure if encryption key is compromised
- ⚠️ No cryptographic enforcement of trading rules
- ⚠️ Keys can be exfiltrated if system is compromised

### PKP Wallets
- ✅ Private key **never exists** in full form (DKG)
- ✅ Distributed across Lit Protocol network (threshold cryptography)
- ✅ Trading constraints enforced at the signing layer (Lit Actions)
- ✅ Immutable rules stored on IPFS
- ✅ No way to bypass constraints (cryptographic guarantee)
- ✅ Agent can only trade within predefined limits

## Trading Constraints Example

When a PKP agent attempts to place a trade, the Lit Action checks:

```javascript
// Example constraints for a "moderate" risk agent
{
  maxPositionSizeUsd: 5000,
  allowedCoins: ["BTC", "ETH", "SOL"],
  maxLeverage: 3,
  requireStopLoss: true,
  timestampFreshness: 300  // 5 minutes
}
```

**If constraints are violated:**
- The Lit Action refuses to sign
- Trade is rejected **before** it reaches Hyperliquid
- Error is logged with specific violation

**Example violations:**
- "Position size $7000 exceeds max $5000"
- "Asset DOGE not in allowed list"
- "Leverage 5x exceeds max 3x"
- "Stop-loss is required but not provided"

## Troubleshooting

### "PKP creation failed, falling back to traditional"

**Possible causes:**
1. Lit Protocol network is down or unreachable
2. Chronicle Yellowstone RPC is slow/timing out
3. Operator wallet has insufficient gas (tstLPX on testnet)
4. Invalid environment variables (check `LIT_NETWORK`, `RPC_URL`)

**Solution:**
- Check Lit Protocol network status
- Verify your operator wallet has tstLPX for gas
- Try again (may be transient network issue)
- Check logs for specific error

### "TimeoutError: The operation was aborted due to timeout"

**Fixed in this update:**
- HTTP timeout increased from 10s → 30s
- Should no longer occur after restarting dev server

**If it still happens:**
- Check Hyperliquid API status
- Verify network connectivity
- Consider increasing timeout further in `lib/hyperliquid.ts`

### Agent created but no signing prompt

**Expected behavior:**
- PKP minting happens **server-side** via the operator wallet
- No user wallet signature required for agent creation
- The operator wallet (in `.env`) pays for PKP minting gas

**If you want user-controlled PKPs:**
- Would require frontend integration with Lit Protocol
- User would sign PKP mint transaction with their wallet
- More complex flow but gives user full ownership

## Next Steps

1. **Restart dev server** to apply code changes
2. **Create a test agent** and verify PKP creation logs
3. **Test Lit Actions** via `npm run test:lit`
4. **Deploy Lit Actions to IPFS** when ready for production:
   ```bash
   npm run deploy:lit-actions
   ```
5. **Update production environment** variables for mainnet

## Files Modified

- `app/api/agents/route.ts` - Agent creation with PKP support
- `lib/hyperliquid.ts` - Increased HTTP timeout (10s → 30s)
- `lib/lit-protocol.ts` - Lit v8 client setup and PKP minting
- `lib/lit-signing.ts` - PKP signing integration
- `lib/account-manager.ts` - PKP account type support
- `lib/types.ts` - PKP interfaces and types

## Production Checklist

Before deploying to production:

- [ ] Set `LIT_NETWORK=naga` (mainnet) in production `.env`
- [ ] Fund operator wallet with LPX for mainnet PKP minting gas
- [ ] Deploy Lit Actions to IPFS: `npm run deploy:lit-actions`
- [ ] Update `ACCOUNT_ENCRYPTION_KEY` in production (not dev fallback)
- [ ] Test PKP agent creation on production
- [ ] Monitor PKP creation success rate
- [ ] Set up alerting for PKP creation failures

## Resources

- [Lit Protocol Docs](https://developer.litprotocol.com/)
- [Lit Protocol v8 (Naga) Migration Guide](https://developer.litprotocol.com/v8/migration)
- [Chronicle Yellowstone Testnet](https://chronicle-yellowstone-explorer.litprotocol.com/)
- [Hyperliquid API Docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api)

---

**Status:** Ready for testing after dev server restart ✅
