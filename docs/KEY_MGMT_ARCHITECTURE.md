# HyperClaw Key Management Architecture

## Complete System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        HyperClaw Platform                                    │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                    User Action: Create Agent                       │     │
│  └─────────────────────────────┬──────────────────────────────────────┘     │
│                                │                                            │
│                   ┌────────────┴────────────┐                              │
│                   │  Mode Detection Logic   │                              │
│                   │  USE_LIT_PKP env var    │                              │
│                   └────────────┬────────────┘                              │
│                                │                                            │
│              ┌─────────────────┴─────────────────┐                         │
│              │                                   │                         │
│              ▼                                   ▼                         │
│  ┌─────────────────────┐              ┌─────────────────────┐              │
│  │    PKP Mode         │              │  Traditional Mode   │              │
│  │  (Production)       │              │  (Development)      │              │
│  └──────────┬──────────┘              └──────────┬──────────┘              │
│             │                                    │                         │
│             ▼                                    ▼                         │
│  ┌─────────────────────┐              ┌─────────────────────┐              │
│  │ Lit Protocol        │              │ Local Key           │              │
│  │ PKP Minting         │              │ Generation          │              │
│  │                     │              │                     │              │
│  │ • DKG across nodes  │              │ • Random 32 bytes   │              │
│  │ • Threshold MPC     │              │ • AES-256 encrypt   │              │
│  │ • No full key       │              │ • Store encrypted   │              │
│  └──────────┬──────────┘              └──────────┬──────────┘              │
│             │                                    │                         │
│             ▼                                    ▼                         │
│  ┌─────────────────────────────────────────────────────────┐               │
│  │            Account Manager Storage                      │               │
│  │                                                         │               │
│  │  PKP Mode:              Traditional Mode:               │               │
│  │  • pkpTokenId           • encryptedKey                  │               │
│  │  • pkpPublicKey         • iv:ciphertext                 │               │
│  │  • pkpEthAddress        • address                       │               │
│  │  • constraints          • agentId                       │               │
│  └─────────────────────┬───────────────────────────────────┘               │
│                        │                                                   │
│                        ▼                                                   │
│  ┌─────────────────────────────────────────────────────────┐               │
│  │        Fund Wallet (USDC Transfer)                      │               │
│  │        sendUsdToAgent(address, amount)                  │               │
│  └─────────────────────┬───────────────────────────────────┘               │
│                        │                                                   │
│                        ▼                                                   │
│  ┌─────────────────────────────────────────────────────────┐               │
│  │      Auto-Approve Builder Code (Vincent-Style)          │               │
│  │                                                         │               │
│  │  ┌─────────────────────────┬──────────────────────┐    │               │
│  │  │                         │                      │    │               │
│  │  ▼                         ▼                      │    │               │
│  │  PKP Signing              Traditional Signing     │    │               │
│  │  ┌──────────────────┐    ┌──────────────────┐    │    │               │
│  │  │1. Get PKP info   │    │1. Get private key│    │    │               │
│  │  │2. EIP-712 data   │    │2. EIP-712 data   │    │    │               │
│  │  │3. Hash message   │    │3. Hash message   │    │    │               │
│  │  │4. Get session    │    │4. Sign with key  │    │    │               │
│  │  │5. Execute Lit    │    │5. Submit to HL   │    │    │               │
│  │  │6. PKP signs      │    │                  │    │    │               │
│  │  │7. Submit to HL   │    │                  │    │    │               │
│  │  └──────────────────┘    └──────────────────┘    │    │               │
│  │                                                   │    │               │
│  └───────────────────────────────────────────────────┘    │               │
│                        │                                   │               │
│                        ▼                                   │               │
│  ┌─────────────────────────────────────────────────────────┐               │
│  │         Hyperliquid approveBuilderFee Action            │               │
│  │         (signature + action submitted)                  │               │
│  └─────────────────────┬───────────────────────────────────┘               │
│                        │                                                   │
│                        ▼                                                   │
│  ┌─────────────────────────────────────────────────────────┐               │
│  │  ✅ Agent Wallet Ready to Trade                          │               │
│  │     - Funded with USDC                                  │               │
│  │     - Builder code approved                             │               │
│  │     - Fee: 0.1% on all trades                           │               │
│  │     - Signing method: PKP or Traditional                │               │
│  └─────────────────────────────────────────────────────────┘               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## PKP Signing Flow (Detailed)

```
┌────────────────────────────────────────────────────────────────┐
│               signBuilderApprovalWithPKP(agentId)              │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 1: Get PKP Info from Account Manager                     │
│                                                                │
│   const pkpInfo = await getPKPForAgent(agentId);               │
│   → { tokenId, publicKey, ethAddress }                         │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 2: Generate EIP-712 Typed Data                           │
│                                                                │
│   const typedData = getApproveBuilderFeeTypedData(chainId, nonce);│
│                                                                │
│   Domain:                                                      │
│   - name: "Exchange"                                           │
│   - version: "1"                                               │
│   - chainId: 421614 (Arbitrum Sepolia)                        │
│                                                                │
│   Message:                                                     │
│   - type: "approveBuilderFee"                                 │
│   - builder: "0x..."                                          │
│   - maxFeeRate: "0.001" (0.1%)                                │
│   - nonce: timestamp                                          │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 3: Hash the Approval Message                             │
│                                                                │
│   const messageHash = ethers.TypedDataEncoder.hash(            │
│     domain,                                                    │
│     types,                                                     │
│     message                                                    │
│   );                                                           │
│   → 0x1234...abcd (32-byte hash)                               │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 4: Get PKP Session Signatures                            │
│                                                                │
│   const sessionSigs = await getSessionSigsForPKP({             │
│     pkpPublicKey,                                              │
│     pkpTokenId,                                                │
│     pkpEthAddress,                                             │
│   });                                                          │
│                                                                │
│   → Session tokens for Lit Protocol authentication            │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 5: Execute Lit Action on Lit Network                     │
│                                                                │
│   const litActionCode = `                                      │
│     const sigShare = await Lit.Actions.signEcdsa({             │
│       toSign: dataToSign,                                      │
│       publicKey,                                               │
│       sigName: "builderApprovalSig",                           │
│     });                                                        │
│   `;                                                           │
│                                                                │
│   const result = await client.executeJs({                      │
│     code: litActionCode,                                       │
│     sessionSigs,                                               │
│     jsParams: {                                                │
│       dataToSign: ethers.getBytes(messageHash),                │
│       publicKey: pkpInfo.publicKey,                            │
│     },                                                         │
│   });                                                          │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 6: Lit Network Distributed Signing                       │
│                                                                │
│   ┌──────────────────────────────────────────────────────┐    │
│   │  Lit Node 1     Lit Node 2     Lit Node 3   ...     │    │
│   │  (key share)    (key share)    (key share)          │    │
│   │      │              │              │                 │    │
│   │      └──────────────┴──────────────┘                 │    │
│   │                    │                                 │    │
│   │                    ▼                                 │    │
│   │         Threshold Signature                          │    │
│   │         (assembled from shares)                      │    │
│   │         > 2/3 nodes required                         │    │
│   └──────────────────────────────────────────────────────┘    │
│                                                                │
│   Private key NEVER exists in full form!                      │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 7: Extract and Format Signature                          │
│                                                                │
│   const sig = result.signatures?.["builderApprovalSig"];       │
│   const signature = ethers.Signature.from("0x" + sig.signature);│
│                                                                │
│   return {                                                     │
│     success: true,                                             │
│     signature: {                                               │
│       r: signature.r,  // 0x1234...                            │
│       s: signature.s,  // 0x5678...                            │
│       v: signature.v,  // 27 or 28                             │
│     },                                                         │
│     action: typedData.message,                                 │
│   };                                                           │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 8: Submit to Hyperliquid                                 │
│                                                                │
│   const info = getInfoClient();                                │
│                                                                │
│   await info.custom({                                          │
│     action: approvalResult.action,                             │
│     nonce: approvalResult.action.nonce,                        │
│     signature: approvalResult.signature,                       │
│   });                                                          │
│                                                                │
│   ✅ Builder code approved on-chain!                           │
└────────────────────────────────────────────────────────────────┘
```

---

## Traditional Signing Flow (Detailed)

```
┌────────────────────────────────────────────────────────────────┐
│      autoApproveBuilderCodeTraditional(address, privateKey)    │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 1: Get Exchange Client                                   │
│                                                                │
│   const exchange = getExchangeClientForAgent(agentPrivateKey); │
│   → Hyperliquid SDK client authenticated with private key     │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 2: Prepare Approval Parameters                           │
│                                                                │
│   const config = getBuilderConfig();                           │
│   const maxFeeRate = builderPointsToPercent(config.feePoints);│
│   → "0.001" (0.1%)                                             │
│                                                                │
│   const action = {                                             │
│     type: "approveBuilderFee",                                 │
│     hyperliquidChain: "Mainnet" or "Testnet",                  │
│     maxFeeRate,                                                │
│     builder: config.address,                                   │
│     nonce: Date.now(),                                         │
│   };                                                           │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 3: Sign and Submit via Exchange Client                   │
│                                                                │
│   const result = await exchange.approveBuilderFee({            │
│     builder: config.address,                                   │
│     maxFeeRate,                                                │
│   });                                                          │
│                                                                │
│   Exchange client:                                             │
│   1. Constructs EIP-712 typed data                             │
│   2. Signs with private key                                    │
│   3. Submits to Hyperliquid API                                │
│                                                                │
│   ✅ Builder code approved on-chain!                           │
└────────────────────────────────────────────────────────────────┘
```

---

## Unified Auto-Approval Logic

```
┌────────────────────────────────────────────────────────────────┐
│  autoApproveBuilderCode(address, privateKey?, agentId?)        │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 1: Check if Already Approved                             │
│                                                                │
│   const needsApproval = await needsBuilderApproval(address);   │
│                                                                │
│   if (!needsApproval) {                                        │
│     return { success: true, alreadyApproved: true };           │
│   }                                                            │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Step 2: Detect Wallet Type                                    │
│                                                                │
│   let isPKP = false;                                           │
│   if (agentId) {                                               │
│     isPKP = await isPKPAccount(agentId);                       │
│   }                                                            │
└────────────────────────┬───────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
   ┌──────────────────┐  ┌──────────────────┐
   │ isPKP = true     │  │ isPKP = false    │
   │ && agentId       │  │ && privateKey    │
   └────────┬─────────┘  └────────┬─────────┘
            │                     │
            ▼                     ▼
┌──────────────────────┐  ┌──────────────────────┐
│ Route to PKP         │  │ Route to Traditional │
│                      │  │                      │
│ autoApproveBuilder   │  │ autoApproveBuilder   │
│ CodeWithPKP()        │  │ CodeTraditional()    │
│                      │  │                      │
│ • Get PKP info       │  │ • Get exchange       │
│ • signBuilderApproval│  │ • exchange.approve   │
│   WithPKP()          │  │   BuilderFee()       │
│ • Submit to HL       │  │                      │
└──────────┬───────────┘  └──────────┬───────────┘
           │                         │
           └────────────┬────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────────────┐
│ Return Result                                                  │
│                                                                │
│   { success: true/false, error?: string }                      │
└────────────────────────────────────────────────────────────────┘
```

---

## First Trade Auto-Approval Flow

```
┌────────────────────────────────────────────────────────────────┐
│ POST /api/trade                                                │
│ { agentId, coin, side, size, orderType }                       │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Get Agent Account Info                                         │
│                                                                │
│   const account = await getAccountForAgent(body.agentId);      │
│   const agentAddress = account.address;                        │
│   const agentPrivateKey = decryptKey(account.encryptedKey);    │
│                                                                │
│   (privateKey undefined for PKP accounts)                      │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Ensure Builder Approval (Vincent-Style)                       │
│                                                                │
│   if (agentAddress && body.agentId) {                          │
│     try {                                                      │
│       const approved = await ensureBuilderApproval(            │
│         agentAddress,                                          │
│         agentPrivateKey,  // undefined for PKP                 │
│         body.agentId      // for PKP signing                   │
│       );                                                       │
│                                                                │
│       if (!approved) {                                         │
│         console.warn("Builder approval failed, proceeding");   │
│       }                                                        │
│     } catch (err) {                                            │
│       console.error("Builder approval error:", err);           │
│       // Don't block trade                                     │
│     }                                                          │
│   }                                                            │
│                                                                │
│   ensureBuilderApproval internally:                            │
│   1. Checks if already approved                                │
│   2. If not, calls autoApproveBuilderCode()                    │
│   3. Auto-detects PKP vs traditional                           │
│   4. Routes to appropriate signing method                      │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Execute Trade                                                  │
│                                                                │
│   const result = await executeOrder(body, exchange);           │
│                                                                │
│   executeOrder includes builder parameter:                     │
│   const builderParam = getBuilderParam();                      │
│   → { address: "0x...", fee: 10 }                              │
│                                                                │
│   Order submitted with builder code attached                   │
│   ✅ Builder fees earned on this trade!                        │
└────────────────────────────────────────────────────────────────┘
```

---

## Security Architecture Comparison

### PKP Mode Security Stack

```
┌─────────────────────────────────────────────────────────────┐
│                     Application Layer                        │
│  - Next.js API routes                                        │
│  - Agent management                                          │
│  - Order execution                                           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Integration Layer                         │
│  - lib/lit-signing.ts (PKP operations)                       │
│  - lib/builder.ts (unified approval)                         │
│  - lib/hyperliquid.ts (trade execution)                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Lit Protocol Layer                        │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Lit Node 1   Lit Node 2   Lit Node 3   ...        │    │
│  │  [Key Share]  [Key Share]  [Key Share]             │    │
│  │       │            │            │                   │    │
│  │       └────────────┴────────────┘                   │    │
│  │                   │                                 │    │
│  │        Threshold Signing (>2/3)                     │    │
│  │        Private key NEVER assembled                  │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Blockchain Layer                           │
│  - Hyperliquid DEX (order execution)                         │
│  - On-chain builder fee approval                             │
│  - Cryptographically verified signatures                     │
└─────────────────────────────────────────────────────────────┘

Security Features:
✅ No single point of failure
✅ Threshold cryptography (>2/3 nodes)
✅ Private key never exists in full
✅ Cryptographic constraint enforcement
✅ Distributed trust model
```

### Traditional Mode Security Stack

```
┌─────────────────────────────────────────────────────────────┐
│                     Application Layer                        │
│  - Next.js API routes                                        │
│  - Agent management                                          │
│  - Order execution                                           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Integration Layer                         │
│  - lib/builder.ts (unified approval)                         │
│  - lib/hyperliquid.ts (trade execution)                      │
│  - lib/account-manager.ts (key storage)                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Encryption Layer                          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  AES-256-CBC Encryption                             │    │
│  │  - Encrypted at rest                                │    │
│  │  - Decrypted for signing                            │    │
│  │  - Key from ACCOUNT_ENCRYPTION_KEY env              │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Blockchain Layer                           │
│  - Hyperliquid DEX (order execution)                         │
│  - On-chain builder fee approval                             │
│  - Cryptographically verified signatures                     │
└─────────────────────────────────────────────────────────────┘

Security Features:
✅ AES-256-CBC encryption
✅ Encrypted at rest
⚠️  Single point of failure (server)
⚠️  Key exposed during signing
✅ Application-level constraints
```

---

## Mode Selection Decision Tree

```
                    Start: Create Agent
                            │
                            ▼
                   ┌────────────────────┐
                   │ Check USE_LIT_PKP   │
                   │   environment var   │
                   └─────────┬───────────┘
                             │
                 ┌───────────┴───────────┐
                 │                       │
                 ▼                       ▼
        USE_LIT_PKP=true       USE_LIT_PKP=false
                 │                       │
                 ▼                       ▼
        ┌─────────────────┐    ┌─────────────────┐
        │   PKP Mode      │    │ Traditional     │
        │                 │    │     Mode        │
        └────────┬────────┘    └────────┬────────┘
                 │                      │
                 ▼                      ▼
        ┌─────────────────┐    ┌─────────────────┐
        │ Production?     │    │ Development?    │
        │ High-value?     │    │ Testing?        │
        │ Max security?   │    │ Fast setup?     │
        └────────┬────────┘    └────────┬────────┘
                 │                      │
                 │YES                   │YES
                 ▼                      ▼
        ┌─────────────────┐    ┌─────────────────┐
        │ ✅ PKP Mode      │    │ ✅ Traditional  │
        │   Selected       │    │    Mode Selected│
        └─────────┬────────┘    └────────┬────────┘
                  │                      │
                  └──────────┬───────────┘
                             │
                             ▼
                    ┌────────────────────┐
                    │  Wallet Created    │
                    │  Builder Approved  │
                    │  Ready to Trade    │
                    └────────────────────┘

Override Options:
• Explicitly pass { mode: "pkp" } to provisionAgentWallet()
• Explicitly pass { mode: "traditional" } to provisionAgentWallet()
```

---

## Integration Points Summary

### 1. Wallet Provisioning
- **Entry**: `provisionAgentWallet(agentId, funding, options)`
- **PKP Path**: `provisionPKPWallet()` → `provisionPKPForAgent()` → `signBuilderApprovalWithPKP()`
- **Traditional Path**: `generateAgentWallet()` → `autoApproveBuilderCodeTraditional()`
- **Output**: `{ address, funded, builderApproved, signingMethod }`

### 2. Trade Execution
- **Entry**: `POST /api/trade { agentId, ... }`
- **Pre-Trade Check**: `ensureBuilderApproval(address, privateKey?, agentId)`
- **Auto-Detection**: Checks if PKP or traditional, routes appropriately
- **Order Execution**: `executeOrder()` includes builder parameter
- **Result**: Trade executed with builder fees

### 3. Builder Approval
- **Check**: `needsBuilderApproval(address)` → queries Hyperliquid
- **Approve**: `autoApproveBuilderCode()` → auto-detects mode and signs
- **Verify**: `hasBuilderApproval(address)` → confirms approval status

### 4. Mode Detection
- **Check**: `getAgentSigningMethod(agentId)` → returns "pkp" | "traditional" | "none"
- **PKP Check**: `isPKPAccount(agentId)` → boolean
- **Account Info**: `getAccountForAgent(agentId)` → full account details

---

## File Dependency Graph

```
app/api/trade/route.ts
    │
    ├─→ lib/builder.ts
    │       ├─→ ensureBuilderApproval()
    │       │       └─→ autoApproveBuilderCode()
    │       │               ├─→ autoApproveBuilderCodeWithPKP()
    │       │               │       └─→ lib/lit-signing.ts
    │       │               │               └─→ signBuilderApprovalWithPKP()
    │       │               │
    │       │               └─→ autoApproveBuilderCodeTraditional()
    │       │                       └─→ lib/hyperliquid.ts
    │       │                               └─→ getExchangeClientForAgent()
    │       │
    │       └─→ needsBuilderApproval()
    │               └─→ lib/hyperliquid.ts
    │                       └─→ getInfoClient()
    │
    └─→ lib/hyperliquid.ts
            └─→ executeOrder()
                    └─→ getBuilderParam()
                            └─→ lib/builder.ts

lib/hyperliquid.ts
    │
    └─→ provisionAgentWallet()
            ├─→ provisionPKPWallet()
            │       └─→ lib/lit-signing.ts
            │               └─→ provisionPKPForAgent()
            │                       ├─→ lib/lit-protocol.ts (mintPKP)
            │                       ├─→ lib/account-manager.ts (addPKPAccount)
            │                       └─→ signBuilderApprovalWithPKP()
            │
            └─→ generateAgentWallet()
                    └─→ lib/account-manager.ts (addAccount)
```

---

This architecture ensures:
- ✅ Clean separation of concerns
- ✅ Mode-agnostic integration
- ✅ Non-blocking error handling
- ✅ Unified API surface
- ✅ Maximum security (PKP) or fast development (Traditional)
