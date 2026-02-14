# Mainnet Vault Migration (V2 -> V3 + HCLAW Stack)

This runbook migrates HyperClaw from `HyperclawVaultV2.sol` to `HyperclawVaultV3.sol` and enables the HCLAW lock/policy/rewards stack with minimal risk.

## Why V3 + HCLAW

`HyperclawVaultV3.sol` + HCLAW modules add:
- Per-user cap enforcement: `userDepositsUSD[agentId][user] <= getUserCapUsd(user)`.
- Lock-based utility (`Locked HCLAW`, `HCLAW Power`) and cap/rebate tiers.
- Rewards and treasury routing endpoints for weekly points and incentive claims.
- Agentic LP guardrail shell (`AgenticLPVault`) with kill-switch and risk bounds.

## Preconditions

- `HYPERCLAW_API_KEY` is set in production.
- `ALLOW_RUNTIME_NETWORK_SWITCH=false` in production.
- `RELAY_STABLE_TOKENS` is set for any mainnet ERC20 relay funding flow.
- HCLAW envs are configured:
  - `NEXT_PUBLIC_HCLAW_LOCK_ADDRESS`
  - `NEXT_PUBLIC_HCLAW_POLICY_ADDRESS`
  - `NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS`
  - `NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS`
  - `HCLAW_POINTS_CLOSE_KEY`
- HCLAW split bps sum to 10000:
  - `HCLAW_BUYBACK_SPLIT_BPS`
  - `HCLAW_INCENTIVE_SPLIT_BPS`
  - `HCLAW_RESERVE_SPLIT_BPS`
- Builder env is configured:
  - `NEXT_PUBLIC_BUILDER_ADDRESS`
  - `NEXT_PUBLIC_BUILDER_FEE`

## Deployment Steps

1. Announce maintenance window and disable new deposits in UI.
2. Deploy HCLAW stack (lock -> policy -> vault -> rewards -> treasury -> agentic vault):
   - `npm run deploy:hclaw-stack`
   - **For buyback → lockup vault**: Deploy `HclawBuybackLock` first, then use its address as `HCLAW_BUYBACK_RECIPIENT`:
     - `npm run deploy:hclaw-buyback-lock` (requires `NEXT_PUBLIC_HCLAW_LOCK_ADDRESS`)
     - Set `HCLAW_BUYBACK_RECIPIENT=<HclawBuybackLock address>` before deploying the treasury router, or call `configureRecipients(buyback, incentive, reserve)` on the existing router
3. Deploy `contracts/HyperclawVaultV3.sol` with:
   - `_hclawToken`
   - `_nadFunLens`
   - `_hclawPolicy`
4. Configure supported ERC20s:
   - `whitelistToken(token, true)` for each allowed token.
5. Configure token prices (USD 1e18):
   - MON: `setTokenPrice(address(0), monUsdPriceE18)`
   - Each whitelisted token: `setTokenPrice(token, usdPriceE18)`
6. Set staleness policy:
   - `setMaxPriceAge(seconds)` (recommended: 900 to 3600).
7. Update app env:
   - `NEXT_PUBLIC_VAULT_ADDRESS=<v3 address>`
   - `NEXT_PUBLIC_HCLAW_LOCK_ADDRESS=<lock address>`
   - `NEXT_PUBLIC_HCLAW_POLICY_ADDRESS=<policy address>`
   - `NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS=<rewards address>`
   - `NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS=<agentic vault address>`
8. Run:
   - `npm run preflight:mainnet`
9. Redeploy app / restart server processes.

## Data + Funds Migration Strategy

Preferred for safety: **manual user migration**.

1. Keep V2 available for withdrawals only.
2. Users withdraw from V2 to wallet.
3. Users redeposit into V3.
4. After migration window, deprecate V2 deposit paths in frontend.

Reason: per-user cap accounting in V3 differs materially from V2; forced in-place migration risks incorrect user cap baselines.

## Smoke Test Checklist

Run before reopening deposits:

1. MON deposit:
   - Deposit succeeds.
   - `Deposited` event emitted with non-zero shares.
2. ERC20 deposit:
   - `transferFrom` receives expected amount.
   - Shares minted and TVL updated.
3. Partial withdrawal:
   - MON and ERC20 are both returned pro-rata.
   - `Withdrawn` + `WithdrawalAsset` events emitted.
4. Replay protection:
   - Re-sending same tx hash to `/api/deposit` returns stable result and does not double-fund.
5. Relay funding behavior:
   - Known agent ID deposit funds HL wallet once.
   - Unknown agent ID deposit does not trigger HL funding.
6. HCLAW policy context:
   - `/api/deposit` response contains `lockTier`, `boostBps`, `rebateBps`, and `userCapRemainingUsd`.
7. Epoch close auth:
   - `/api/hclaw/epochs/close` rejects requests with missing/invalid close key.

## Rollback

If issues are found during smoke testing:

1. Disable deposits in UI.
2. Point `NEXT_PUBLIC_VAULT_ADDRESS` back to V2.
3. Restart app services.
4. Keep V3/HCLAW contracts deployed for forensic/debug use; do not destroy state.

## Post-Cutover Monitoring (First 24h)

- Deposit success/failure rate.
- Withdrawal confirmation latency.
- Relay funding failures (`hlFunded=false`) and retries.
- TVL parity:
  - On-chain `getVaultTVL(agentId)`
  - App `agent.vaultTvlUsd`
- HCLAW state parity:
  - `/api/hclaw/state` values align with on-chain policy reads
  - `/api/hclaw/treasury` totals align with treasury flow records
