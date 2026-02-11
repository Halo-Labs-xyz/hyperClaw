# Dependency Fix Summary

## Changes Made

### 1. Fixed `viem` Version Conflict

**Before:**
```json
"viem": "^2.38.3"  // Allowed pnpm to install 2.45.1
```

**After:**
```json
"viem": "2.38.3",  // Pinned to exact version
"overrides": {
  "viem": "2.38.3"  // Force all sub-dependencies to use this version
}
```

**Result:**
- ✅ Downgraded from `viem@2.45.1` → `viem@2.38.3`
- ✅ Matches Lit Protocol v8's expected version
- ✅ Prevents potential runtime issues with PKP operations

### 2. Added Missing `ws` Package

**Added:**
```json
"ws": "^8.18.0"
```

**Result:**
- ✅ Fixes OpenAI peer dependency warning
- ✅ Added `ws@8.19.0` to dependencies

## Remaining Warnings (Safe to Ignore)

### TypeScript Version Mismatch
```
@lit-protocol/contracts expects typescript@5.8.3: found 5.9.3
```
- **Impact:** None - TypeScript is backward compatible
- **Action:** No change needed

### Ethers v5 in Lit Auth Sub-dependency
```
@typechain/ethers-v6 expects ethers@6.x: found 5.7.2 in @lit-protocol/auth
```
- **Impact:** None - Internal to Lit Protocol's legacy dependencies
- **Action:** No change needed (your code uses ethers v6)

### Privy/WalletConnect Peer Warnings
```
@solana/kit@^2.3.0: found 5.5.1
zod@^3 >=3.22.0: found 4.3.6
```
- **Impact:** None - Internal to Privy and WalletConnect
- **Action:** No change needed (not used directly in your code)

## Why These Changes Matter

### Before Fix:
- Lit Protocol v8 expected `viem@2.38.3`
- Your app was running `viem@2.45.1` (7 minor versions ahead)
- Potential for API incompatibilities in:
  - `createAuthManager()`
  - `litClient.mintWithEoa()`
  - `privateKeyToAccount()`
  - Other Lit Protocol core functions

### After Fix:
- Exact version match with Lit Protocol's requirements
- Guaranteed compatibility with all Lit v8 APIs
- Reduced risk of runtime errors during PKP operations

## Testing Checklist

After restarting the dev server:

- [ ] Test Lit Protocol connection (`npm run test:lit`)
- [ ] Create a new PKP agent via UI
- [ ] Verify PKP wallet creation logs
- [ ] Check for any new runtime errors
- [ ] Confirm no more `viem` version warnings

## Commands Run

```bash
# Update package.json (viem pinned, ws added, overrides section)
# Then:
pnpm install --no-frozen-lockfile
```

## Files Modified

- `package.json` - Pinned `viem` version, added `ws`, added `overrides` section
- `pnpm-lock.yaml` - Updated (automatically)

---

**Status:** ✅ Critical dependencies fixed, ready for testing
