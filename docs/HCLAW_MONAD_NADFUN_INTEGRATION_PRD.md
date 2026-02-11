# HCLAW Monad/Nad.fun Integration PRD

Version: 1.0  
Date: February 11, 2026  
Status: Draft for execution  
Owner: HyperClaw core team

Companion execution tracker: `docs/HCLAW_IMPLEMENTATION_CHECKLIST.md`

## 1. Objective

Deliver an end-to-end HCLAW utility and incentive system in HyperClaw that:

- Keeps the token brand as `HCLAW` (no separate `ve` token).
- Adds lock-based utility to increase user deposit capacity and fee rebate tier.
- Adds a weekly points program tied to aligned behavior.
- Adds an Agentic LP treasury strategy that can generate real yield and fund HCLAW buybacks plus incentives.

This PRD is scoped to the existing codebase architecture:

- Next.js app/API in `app/` and `lib/`
- Foundry contracts in `contracts/`
- Optional Supabase persistent storage in `supabase/`

## 2. Naming and Product Language

- Public token: `HCLAW`
- Locked state label: `Locked HCLAW`
- Utility weight label: `HCLAW Power`

Technical note: this is vote-escrow style logic, but product language remains HCLAW-only.

## 3. Current Baseline (As Implemented)

- Vault contract: `contracts/HyperclawVaultV2.sol`
- Frontend vault ABI and helpers: `lib/vault.ts`
- Token tier reads and UI flywheel: `lib/hclaw.ts`, `app/page.tsx`
- Deposit relay and accounting: `lib/deposit-relay.ts`, `app/api/deposit/route.ts`
- Supabase schema for core entities: `supabase/migrations/20260210_hyperclaw_store.sql`

Current gaps against target:

- No lock primitive for HCLAW.
- No per-user lock-based cap boost.
- No fee rebate or fee-tier engine.
- No points epochs and settlement pipeline.
- No treasury/agentic LP on-chain module.
- Vault cap logic is not yet lock-aware.

## 4. Product Requirements

### 4.1 Lock + Power

- Users lock HCLAW for fixed durations: 30d, 90d, 180d.
- Lock position grants `HCLAW Power` based on lock amount and duration multiplier.
- Power decays to zero at unlock.
- Users can extend lock duration and/or add amount.
- Locked amount is non-transferable until unlock.

### 4.2 Deposit Cap and Effective Fee Tier

- Base cap still depends on Nad.fun market cap tier.
- User-specific cap is boosted by lock tier:
  - 30d: 1.25x
  - 90d: 1.75x
  - 180d: 2.50x
- Nad.fun base fee is unchanged; fee tiers are implemented as rebates funded by treasury flows:
  - 30d: 15%
  - 90d: 35%
  - 180d: 55%

### 4.3 Weekly Points

- Weekly epochs.
- Formula:
  - 40% lock points
  - 35% LP points
  - 15% referral points
  - 10% quest points
- Anti-abuse:
  - Minimum eligibility hold time
  - Self-trade/wash exclusion
  - Sybil heuristics
  - Epoch expiration (no infinite carry)

### 4.4 Agentic LP Main Vault

- Create an HCLAW treasury strategy vault with initial allocation cap of 5-8% of HCLAW supply.
- Strategy objective: market-make HCLAW/MON and run delta-aware inventory management.
- Net PnL split:
  - 50% reinvest
  - 30% buyback HCLAW
  - 20% incentives pool
- Must support kill-switch and strict risk limits.

## 5. Contract Architecture

### 5.1 New Contracts

1. `contracts/HclawLock.sol`
- Stores lock positions and calculates HCLAW Power.
- Core functions:
  - `lock(uint256 amount, uint16 durationDays)`
  - `extendLock(uint256 lockId, uint16 newDurationDays)`
  - `increaseLock(uint256 lockId, uint256 amount)`
  - `unlock(uint256 lockId)`
  - `getUserPower(address user)`
  - `getUserTier(address user)`

2. `contracts/HclawPolicy.sol`
- Reads Nad.fun curve state and user HCLAW Power.
- Returns effective cap and rebate tier.
- Core functions:
  - `getBaseCapUsd()`
  - `getUserCapUsd(address user)`
  - `getUserRebateBps(address user)`

3. `contracts/HyperclawVaultV3.sol`
- Successor to V2 with user-level cap accounting and policy integration.
- Must preserve existing event signatures used by relay:
  - `Deposited(...)`
  - `Withdrawn(...)`
- New state:
  - `mapping(bytes32 => mapping(address => uint256)) userDepositsUSD`
- New checks:
  - enforce `userDepositsUSD[agentId][user] <= HclawPolicy.getUserCapUsd(user)`

4. `contracts/HclawRewardsDistributor.sol`
- Receives epoch settlement roots or direct allocations.
- Supports claims for rebates and points incentives.

5. `contracts/HclawTreasuryRouter.sol`
- Routes realized revenue to buyback, incentive pool, reserve using configurable bps splits.

6. `contracts/AgenticLPVault.sol`
- Treasury-owned strategy vault with execution roles and risk guardrails.
- Provides accounting events and realized PnL reporting hooks.

### 5.2 Contract Compatibility Rules

- Keep existing vault entrypoints used by frontend:
  - `depositMON(bytes32 agentId)`
  - `depositERC20(bytes32 agentId, address token, uint256 amount)`
  - `withdraw(bytes32 agentId, uint256 shares)`
- Keep `getMaxDepositUSD()` for base tier compatibility, add user-aware read:
  - `getMaxDepositUSDForUser(address user)`
- Keep `lib/deposit-relay.ts` event decoding stable by preserving topic/data structure for deposit/withdraw.

## 6. Backend and API Integration

### 6.1 New Domain Modules (`lib/`)

- `lib/hclaw-lock.ts`  
On-chain reads/writes for lock data and HCLAW Power.

- `lib/hclaw-policy.ts`  
User cap/rebate resolution, tier mapping, caching.

- `lib/hclaw-points.ts`  
Epoch scoring engine, anti-abuse checks, settlement artifacts.

- `lib/hclaw-rewards.ts`  
Claim state, rebate math, distribution statuses.

- `lib/agentic-vault.ts`  
Treasury strategy execution client, risk checks, performance snapshots.

### 6.2 API Routes (`app/api/`)

- `app/api/hclaw/state/route.ts`  
Unified flywheel state: mcap tier, user power, cap boost, rebate tier.

- `app/api/hclaw/lock/route.ts`  
Lock lifecycle operations and previews.

- `app/api/hclaw/points/route.ts`  
Current epoch score, history, point breakdown.

- `app/api/hclaw/rewards/route.ts`  
Claimable rebates and incentives.

- `app/api/hclaw/treasury/route.ts`  
Revenue, buyback, reserve, incentive funding reports.

- `app/api/hclaw/epochs/close/route.ts`  
Admin/automation endpoint to close epoch and publish settlement.

### 6.3 Existing Module Changes

- `lib/deposit-relay.ts`
  - Pull user cap from `HclawPolicy` for UX hints.
  - Emit analytics-ready records for points ingestion.
- `app/api/deposit/route.ts`
  - Return user cap remaining and lock tier context post-confirmation.
- `lib/hclaw.ts`
  - Extend from market-cap-only state to include lock/power/rebate fields.
- `scripts/preflight-mainnet.mjs`
  - Add required checks for new contract addresses and treasury split config.

## 7. Data Model and Migrations

Add migration: `supabase/migrations/20260211_hclaw_rewards.sql`

Required tables:

- `hc_hclaw_locks`
  - `lock_id`, `user_address`, `amount`, `start_ts`, `end_ts`, `multiplier_bps`, `status`
- `hc_hclaw_points_epochs`
  - `epoch_id`, `start_ts`, `end_ts`, `status`, `root_hash`, `settled_ts`
- `hc_hclaw_points_balances`
  - `epoch_id`, `user_address`, `lock_points`, `lp_points`, `ref_points`, `quest_points`, `total_points`
- `hc_hclaw_referrals`
  - `referrer`, `referee`, `qualified_volume_usd`, `epoch_id`
- `hc_hclaw_rewards`
  - `user_address`, `epoch_id`, `rebate_usd`, `incentive_hclaw`, `claimed`
- `hc_hclaw_treasury_flows`
  - `ts`, `source`, `amount_usd`, `buyback_usd`, `incentive_usd`, `reserve_usd`, `tx_hash`

Indexes:

- `(user_address, epoch_id)` on balances and rewards.
- `(epoch_id)` on all epoch tables.
- `(ts desc)` on treasury flow table.

## 8. Frontend Integration

### 8.1 Dashboard (`app/page.tsx`)

- Expand existing `$HCLAW Flywheel` card to show:
  - User lock tier
  - HCLAW Power
  - Boosted cap
  - Current rebate tier
  - Weekly points and claimable rewards

### 8.2 Agent Deposit Page (`app/agents/[id]/page.tsx`)

- Before deposit submit, fetch and show:
  - Base cap
  - Boost multiplier
  - Remaining user cap
  - Rebate tier banner
- After tx confirm, include lock/rebate context in status copy.

### 8.3 New HCLAW Hub Page

- `app/hclaw/page.tsx`
- Sections:
  - Lock manager
  - Points breakdown and epoch timer
  - Claim center
  - Treasury transparency panel
  - Agentic LP performance panel

## 9. Economics and Treasury Rules

- Default revenue split (configurable in `HclawTreasuryRouter`):
  - 40% buyback
  - 40% points/rewards
  - 20% reserve
- Agentic LP net PnL split:
  - 50% reinvest
  - 30% buyback
  - 20% incentives
- Buybacks use TWAP or bounded-slippage execution with daily caps.

## 10. Security and Risk Controls

- Multisig + timelock for admin parameter updates.
- Emergency pause for:
  - lock contract
  - rewards distributor
  - agentic vault execution
- Strategy risk limits in contract-configurable params:
  - max inventory skew
  - max daily turnover
  - max drawdown halt
- No user fund commingling between agent vault accounting paths.

## 11. Testing Plan

### 11.1 Solidity (Foundry)

Add tests:

- `test/HclawLock.t.sol`
- `test/HclawPolicy.t.sol`
- `test/HyperclawVaultV3.t.sol`
- `test/HclawRewardsDistributor.t.sol`
- `test/AgenticLPVault.t.sol`

Coverage requirements:

- Lock lifecycle and power decay.
- User cap boost enforcement.
- Rebate tier resolution.
- Deposit/withdraw compatibility with relay event parsing.
- Treasury routing and pause behavior.

### 11.2 App/API

- Unit tests for points math and anti-abuse checks.
- Integration tests for:
  - `/api/hclaw/*` endpoints
  - epoch close flow
  - claim flow
- Contract-test extension in `scripts/test-ironclaw-contracts.mjs` for new API auth/contract expectations.

## 12. Rollout Plan

### Phase A: Launch-safe foundation (T+0 to T+2 days)

- Deploy `HclawLock`, `HclawPolicy`, `HyperclawVaultV3`.
- Update `NEXT_PUBLIC_VAULT_ADDRESS` to V3.
- Enable lock and cap boost.
- Keep points in read-only dry run.

### Phase B: Incentives live (T+3 to T+7 days)

- Enable weekly points epochs and rewards claims.
- Enable rebate accounting and claims.
- Publish weekly treasury report endpoint.

### Phase C: Agentic LP pilot (T+7 to T+21 days)

- Fund Agentic LP with 5-8% supply cap.
- Turn on conservative strategy profile.
- Start buyback + incentive routing from realized PnL.

## 13. Acceptance Criteria

- Users can lock HCLAW and see non-zero HCLAW Power.
- Deposits enforce user-specific boosted caps on-chain.
- Rebate tier is visible and claimable.
- Weekly points are computed, queryable, and claim-settled.
- Agentic LP PnL and treasury routing are visible via API and UI.
- Existing deposit relay flow remains functional with no event decoding regression.

## 14. Environment and Config Additions

Add to `.env.example`:

- `NEXT_PUBLIC_HCLAW_LOCK_ADDRESS`
- `NEXT_PUBLIC_HCLAW_POLICY_ADDRESS`
- `NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS`
- `NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS`
- `HCLAW_EPOCH_DURATION_DAYS=7`
- `HCLAW_BUYBACK_SPLIT_BPS=4000`
- `HCLAW_INCENTIVE_SPLIT_BPS=4000`
- `HCLAW_RESERVE_SPLIT_BPS=2000`
- `HCLAW_POINTS_CLOSE_KEY` (auth for epoch close route)

## 15. Open Decisions Required

- Confirm lock multipliers and rebate percentages as final launch constants.
- Confirm buyback destination: burn vs treasury-lock.
- Confirm referral qualification rules and anti-sybil thresholds.
- Confirm Agentic LP initial risk profile and daily risk caps.
- Confirm whether rewards claims are on-chain direct mint/transfer or Merkle distribution.
