# Quick Start: Builder Codes

Get builder codes working in **5 minutes**.

## Step 1: Set Environment Variables (30 seconds)

Add to `.env.local`:

```bash
NEXT_PUBLIC_BUILDER_ADDRESS=0xYourBuilderWalletAddress
NEXT_PUBLIC_BUILDER_FEE=10
```

> **Fee Reference**: `10` = 0.1%, `50` = 0.5%, `100` = 1.0%

## Step 2: Verify Setup (1 minute)

```bash
# Run the test script
node scripts/test-builder-codes.mjs
```

Expected output:
```
✅ Builder Address: 0x...
✅ Builder Fee: 10 (0.1%)
✅ Builder info endpoint responding
✅ Typed data endpoint responding
✅ Builder module loaded successfully
```

## Step 3: Add Approval UI (2 minutes)

In any page where users first trade (e.g., `/agents/new` or first trade screen):

```tsx
import BuilderApproval from "@/app/components/BuilderApproval";

export default function YourPage() {
  return (
    <div>
      {/* Show builder approval if needed */}
      <BuilderApproval 
        onApprovalComplete={() => {
          console.log("User approved builder fee!");
          // Continue with your flow
        }}
      />
      
      {/* Rest of your page */}
    </div>
  );
}
```

The component automatically:
- ✅ Checks if user has approved
- ✅ Shows approval UI only if needed
- ✅ Handles EIP-712 signing
- ✅ Submits to Hyperliquid
- ✅ Hides after approval

## Step 4: Trade & Earn (30 seconds)

That's it! Now every trade automatically includes your builder code:

```bash
# Users trade normally
# Builder fees accumulate automatically
# Check your earnings:
curl http://localhost:3000/api/builder/claim
```

## Example: Full User Flow

```
User visits app
    ↓
Connects wallet
    ↓
BuilderApproval component appears
    ↓
User clicks "Approve Builder Fee" (one-time)
    ↓
Signs EIP-712 message (gas-free)
    ↓
✅ Approved! Component disappears
    ↓
User places trade
    ↓
Builder code automatically included
    ↓
💰 You earn 0.1% fee
```

## Check Your Earnings

```bash
# View accumulated fees
curl http://localhost:3000/api/builder/claim

# Claim fees
curl -X POST http://localhost:3000/api/builder/claim
```

## Troubleshooting

### "Builder codes not configured"
→ Add `NEXT_PUBLIC_BUILDER_ADDRESS` and `NEXT_PUBLIC_BUILDER_FEE` to `.env.local`

### "Failed to fetch builder info"
→ Make sure dev server is running: `npm run dev`

### Orders not including builder code
→ Check `.env.local` variables are set and restart dev server

### Cannot claim fees
→ Ensure `HYPERLIQUID_PRIVATE_KEY` matches builder address

## That's It!

You're now earning fees on every trade. 🎉

**Full Documentation**: See `BUILDER_CODES.md` for details.
