# HCLAW Implementation Checklist (Sequenced Tickets)

Version: 1.0  
Date: February 11, 2026  
Source PRD: `docs/HCLAW_MONAD_NADFUN_INTEGRATION_PRD.md`

## 1. Execution Rules

- Work in ticket order unless a ticket explicitly allows parallel work.
- Do not break compatibility for existing `Deposited` and `Withdrawn` event decoding in `lib/deposit-relay.ts`.
- Keep product naming as `HCLAW`, `Locked HCLAW`, and `HCLAW Power`.
- Merge gate: each milestone must pass listed acceptance criteria before next milestone begins.

## 2. Milestones

- M0: Design freeze and constants
- M1: Smart contracts
- M2: Backend and APIs
- M3: Data model and migrations
- M4: Frontend
- M5: Ops and monitoring
- M6: QA and launch

## 3. Ticket Board

| ID | Milestone | Ticket | Owner | Depends On | Status |
|---|---|---|---|---|---|
| HC-000 | M0 | Finalize constants and policy matrix | Product + Protocol | None | [x] |
| HC-101 | M1 | Implement `HclawLock.sol` | Contracts | HC-000 | [x] |
| HC-102 | M1 | Implement `HclawPolicy.sol` | Contracts | HC-101 | [x] |
| HC-103 | M1 | Implement `HyperclawVaultV3.sol` | Contracts | HC-102 | [x] |
| HC-104 | M1 | Implement rewards + treasury contracts | Contracts | HC-103 | [x] |
| HC-105 | M1 | Implement `AgenticLPVault.sol` guardrail shell | Contracts | HC-104 | [x] |
| HC-106 | M1 | Foundry tests + deployment scripts | Contracts | HC-101..HC-105 | [x] |
| HC-201 | M2 | Add ABIs/types/env for new contracts | Backend | HC-106 | [x] |
| HC-202 | M2 | Add lock/policy/reward/treasury libs | Backend | HC-201 | [x] |
| HC-203 | M2 | Add points epoch engine | Backend | HC-202 | [x] |
| HC-204 | M2 | Add HCLAW API routes | Backend | HC-202, HC-203 | [x] |
| HC-205 | M2 | Integrate cap/rebate context in deposit relay | Backend | HC-204 | [x] |
| HC-206 | M2 | Add auth and preflight checks for new routes | Backend | HC-204 | [x] |
| HC-301 | M3 | Supabase migration for lock/points/rewards/flows | Data | HC-204 | [x] |
| HC-302 | M3 | Store adapter support for new tables | Data | HC-301 | [x] |
| HC-303 | M3 | Backfill/indexing script for day-0 bootstrap | Data | HC-302 | [x] |
| HC-401 | M4 | Dashboard flywheel expansion | Frontend | HC-204 | [x] |
| HC-402 | M4 | Agent deposit page cap/rebate UX | Frontend | HC-205 | [x] |
| HC-403 | M4 | New `/hclaw` hub page | Frontend | HC-204, HC-302 | [x] |
| HC-404 | M4 | Claim UX for rebates and incentives | Frontend | HC-403 | [x] |
| HC-501 | M5 | Deployment runbook + env updates | Ops | HC-106, HC-206, HC-301 | [x] |
| HC-502 | M5 | Treasury reporting + weekly epoch close job | Ops | HC-204, HC-302 | [x] |
| HC-503 | M5 | Incident controls and rollback docs | Ops | HC-501 | [x] |
| HC-601 | M6 | End-to-end test matrix pass | QA | HC-404, HC-503 | [x] |
| HC-602 | M6 | Testnet rehearsal and signoff | QA + Ops | HC-601 | [ ] |
| HC-603 | M6 | Mainnet cutover and verification | QA + Ops | HC-602 | [ ] |

Operational note:
- HC-602 and HC-603 remain manual deployment-stage tasks and must be completed on live infrastructure.

## 4. Ticket Details

### HC-000: Finalize constants and policy matrix

Scope:
- Freeze lock durations, multipliers, cap boosts, rebate bps.
- Freeze points weights and anti-abuse minimums.
- Freeze treasury split defaults and Agentic LP risk limits.

Primary files:
- `docs/HCLAW_MONAD_NADFUN_INTEGRATION_PRD.md`
- `docs/HCLAW_IMPLEMENTATION_CHECKLIST.md`

Definition of done:
- Constants table approved by product + protocol.
- Any changed constants reflected in PRD before contract coding.

### HC-101: Implement `HclawLock.sol`

Scope:
- Add lock lifecycle and HCLAW Power calculation.
- Expose read methods for user tier/power queries.

Primary files:
- `contracts/HclawLock.sol`
- `test/HclawLock.t.sol`

Definition of done:
- Lock, extend, increase, unlock all tested.
- Time-based power behavior tested across boundaries.

### HC-102: Implement `HclawPolicy.sol`

Scope:
- Combine Nad.fun base cap and HCLAW lock tier to compute user cap.
- Compute user rebate bps from lock tier.

Primary files:
- `contracts/HclawPolicy.sol`
- `test/HclawPolicy.t.sol`

Definition of done:
- `getBaseCapUsd`, `getUserCapUsd`, `getUserRebateBps` validated.
- Nad.fun lens failure fallback behavior tested.

### HC-103: Implement `HyperclawVaultV3.sol`

Scope:
- Extend V2 for per-user cap enforcement via policy contract.
- Keep existing event ABI shape for relay compatibility.

Primary files:
- `contracts/HyperclawVaultV3.sol`
- `test/HyperclawVaultV3.t.sol`
- `lib/vault.ts` (ABI updates)

Definition of done:
- Deposit path blocks cap overflow at user level.
- Withdraw behavior remains pro-rata and isolated by `agentId`.
- Existing relay parser still decodes events without changes.

### HC-104: Implement rewards + treasury contracts

Scope:
- Add rewards distributor and treasury split router.
- Support claim accounting for rebates and incentives.

Primary files:
- `contracts/HclawRewardsDistributor.sol`
- `contracts/HclawTreasuryRouter.sol`
- `test/HclawRewardsDistributor.t.sol`

Definition of done:
- Epoch allocation and claim lifecycle tested.
- Treasury split bps totals and bounds enforced.

### HC-105: Implement `AgenticLPVault.sol` guardrail shell

Scope:
- Add strategy vault contract with role-gated execution and kill switch.
- Add configurable risk limits and status reporting fields.

Primary files:
- `contracts/AgenticLPVault.sol`
- `test/AgenticLPVault.t.sol`

Definition of done:
- Execution pauses correctly on kill-switch.
- Guardrail parameter bounds are enforced.

### HC-106: Foundry tests + deployment scripts

Scope:
- Complete test coverage for M1 contracts.
- Add deployment scripts and verify constructor wiring.

Primary files:
- `test/*.t.sol` (new HCLAW suites)
- `scripts/` (new deploy scripts)
- `foundry.toml`

Definition of done:
- `npm run test:solidity` passes for new suites.
- Deployment script outputs addresses for env wiring.

### HC-201: Add ABIs/types/env for new contracts

Scope:
- Add new ABIs and TS contract helpers.
- Extend env accessors and placeholders.

Primary files:
- `lib/vault.ts`
- `lib/types.ts`
- `lib/env.ts`
- `.env.example`

Definition of done:
- All new addresses validated and available through typed helpers.

### HC-202: Add lock/policy/reward/treasury libs

Scope:
- Build service modules for all new on-chain reads/writes.

Primary files:
- `lib/hclaw-lock.ts`
- `lib/hclaw-policy.ts`
- `lib/hclaw-rewards.ts`
- `lib/agentic-vault.ts`

Definition of done:
- Modules return typed, normalized values for UI and APIs.

### HC-203: Add points epoch engine

Scope:
- Implement weekly epoch close logic and score calculations.
- Apply anti-abuse filters.

Primary files:
- `lib/hclaw-points.ts`

Definition of done:
- Deterministic scoring for same input dataset.
- Unit tests for all weight paths and abuse filters.

### HC-204: Add HCLAW API routes

Scope:
- Add endpoints for state, lock, points, rewards, treasury, epoch close.

Primary files:
- `app/api/hclaw/state/route.ts`
- `app/api/hclaw/lock/route.ts`
- `app/api/hclaw/points/route.ts`
- `app/api/hclaw/rewards/route.ts`
- `app/api/hclaw/treasury/route.ts`
- `app/api/hclaw/epochs/close/route.ts`

Definition of done:
- Endpoints return stable schemas.
- Endpoint auth enforced for epoch close/admin operations.

### HC-205: Integrate cap/rebate context in deposit relay

Scope:
- Enrich deposit responses with user cap remaining and rebate tier hints.
- Ensure no regressions in tx replay protection.

Primary files:
- `lib/deposit-relay.ts`
- `app/api/deposit/route.ts`

Definition of done:
- Deposit API response includes cap/rebate context when configured.
- Existing success and retry flows unchanged.

### HC-206: Add auth and preflight checks for new routes

Scope:
- Add route protection and preflight validations for new required envs.

Primary files:
- `lib/auth.ts`
- `scripts/preflight-mainnet.mjs`

Definition of done:
- Missing critical HCLAW envs fail preflight on mainnet.

### HC-301: Supabase migration for lock/points/rewards/flows

Scope:
- Create all PRD-defined HCLAW tables and indexes.

Primary files:
- `supabase/migrations/20260211_hclaw_rewards.sql`

Definition of done:
- Migration applies cleanly on new and existing DBs.

### HC-302: Store adapter support for new tables

Scope:
- Add data access helpers for new HCLAW entities.

Primary files:
- `lib/supabase-store.ts`

Definition of done:
- CRUD helpers for locks, epochs, balances, rewards, treasury flows.

### HC-303: Backfill/indexing script for day-0 bootstrap

Scope:
- Build one-time script to backfill recent lock/deposit/reward state.

Primary files:
- `scripts/` (new backfill script)

Definition of done:
- Script is idempotent and logs summary counts.

### HC-401: Dashboard flywheel expansion

Scope:
- Show lock tier, HCLAW Power, boosted cap, rebates, points.

Primary files:
- `app/page.tsx`
- `lib/hclaw.ts`

Definition of done:
- Existing flywheel UI still works when HCLAW contracts are unset.

### HC-402: Agent deposit page cap/rebate UX

Scope:
- Show base cap, boost multiplier, remaining cap, rebate tier at deposit time.

Primary files:
- `app/agents/[id]/page.tsx`

Definition of done:
- Users see cap state before signing deposit tx.

### HC-403: New `/hclaw` hub page

Scope:
- Build central utility page for locking, points, and treasury visibility.

Primary files:
- `app/hclaw/page.tsx`
- `app/components/` (new HCLAW components)

Definition of done:
- Lock actions, points view, and treasury view are functional.

### HC-404: Claim UX for rebates and incentives

Scope:
- Build claim flows and post-claim states.

Primary files:
- `app/hclaw/page.tsx`
- `app/api/hclaw/rewards/route.ts`

Definition of done:
- Users can claim and see updated balances/status.

### HC-501: Deployment runbook + env updates

Scope:
- Update deployment and migration instructions for HCLAW stack.

Primary files:
- `README.md`
- `docs/PRODUCTION_RUNBOOK.md`
- `docs/MAINNET_VAULT_MIGRATION.md`
- `.env.example`

Definition of done:
- New operator can deploy and configure from docs only.

### HC-502: Treasury reporting + weekly epoch close job

Scope:
- Add repeatable weekly close process and treasury report generation.

Primary files:
- `scripts/` (epoch close/report scripts)
- `app/api/hclaw/epochs/close/route.ts`

Definition of done:
- Weekly close can run safely and produces deterministic output.

### HC-503: Incident controls and rollback docs

Scope:
- Document pause/rollback process for lock, rewards, treasury, and vault paths.

Primary files:
- `docs/PRODUCTION_RUNBOOK.md`

Definition of done:
- Rollback runbook includes exact command and env steps.

### HC-601: End-to-end test matrix pass

Scope:
- Validate lock -> deposit boost -> points accrual -> claim -> treasury report path.

Primary files:
- `scripts/test-ironclaw-contracts.mjs` (extensions)
- `test/` and API route tests

Definition of done:
- Full matrix passes in CI-equivalent local run.

### HC-602: Testnet rehearsal and signoff

Scope:
- Perform full dry run on Monad testnet using production-like config.

Definition of done:
- Written signoff with known limitations list.

### HC-603: Mainnet cutover and verification

Scope:
- Deploy, configure, enable, and validate all HCLAW paths in production.

Definition of done:
- Post-cutover checks complete with no blocker severity findings.

## 5. Verification Commands (Per Milestone)

M1:
- `npm run test:solidity`

M2-M4:
- `npm run lint`
- `npm run typecheck`
- `npm run build`

M6:
- `npm run check`
- `npm run test:ironclaw-contracts`

## 6. Launch Exit Criteria

- All HC-000 through HC-603 tickets checked complete.
- No open Sev-1 or Sev-2 findings.
- Preflight passes with new HCLAW env checks.
- Treasury report and epoch close tested end-to-end on current release candidate.
