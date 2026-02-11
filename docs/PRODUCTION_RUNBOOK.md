# Production Runbook

This runbook defines a safe production workflow for HyperClaw without removing or rewriting existing features.

## Scope

- Primary app: Next.js service in repository root
- Side projects: `ironclaw/` (Rust) and `hyperliquid-info-mcp/` (Python)
- Objective: consistent build quality, deterministic release checks, and clear rollback path

## Baseline Commands

Run from repository root:

```bash
npm run clean:cache
npm install
npm run check
```

Command meanings:

- `npm run lint`: framework and TypeScript lint checks
- `npm run typecheck`: static type check without emit
- `npm run build`: production bundle and route compilation
- `npm run check`: one-shot production gate

## Pre-Deploy Checklist

1. Confirm env parity against `.env.example`.
2. Run `npm run check` and resolve blocking failures.
3. Run `npm run preflight:mainnet` and resolve all blockers.
3. Verify required external integrations are configured:
   - Hyperliquid credentials
   - Lit/PKP credentials (if enabled)
   - Supabase connection
   - Telegram webhook/keys (if enabled)
   - HCLAW envs and split config:
     - `NEXT_PUBLIC_HCLAW_LOCK_ADDRESS`
     - `NEXT_PUBLIC_HCLAW_POLICY_ADDRESS`
     - `NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS`
     - `NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS`
     - `HCLAW_POINTS_CLOSE_KEY`
     - `HCLAW_BUYBACK_SPLIT_BPS + HCLAW_INCENTIVE_SPLIT_BPS + HCLAW_RESERVE_SPLIT_BPS = 10000`
4. Validate key API routes manually:
   - `/api/startup`
   - `/api/lifecycle`
   - `/api/agents`
   - `/api/trade`
   - `/api/hclaw/state`
   - `/api/hclaw/points`
   - `/api/hclaw/treasury`
5. Smoke test UI routes:
   - `/`
   - `/agents`
   - `/monitor`
   - `/strategy`
   - `/hclaw`

## Runtime Guardrails

- Treat warnings from `react-hooks/exhaustive-deps` as follow-up cleanup items, even when non-blocking.
- Keep `.data/*` out of commits; state in this directory is environment-specific.
- Prefer feature toggles via environment variables rather than branch-only behavior.
- Keep API routes explicitly dynamic where they depend on runtime request context.

## Release Flow

1. Branch from latest stable mainline.
2. Run `npm run check`.
3. Deploy to staging and execute API/UI smoke tests.
4. Promote identical build artifact to production.
5. Post-deploy verify:
   - agent lifecycle health
   - stream routes returning data
   - trade route can dry-run safely
   - HCLAW epoch close auth gate rejects missing/invalid key
   - claim route updates state (`/api/hclaw/rewards`)
   - treasury flow report endpoint returns totals (`/api/hclaw/treasury`)

## Rollback Strategy

1. Re-deploy last known good artifact.
2. Restore previous environment snapshot if config drift is detected.
3. Pause active autonomous agents via lifecycle endpoint if execution risk exists.
4. Re-enable only after health and funding state are verified.
5. HCLAW-specific containment:
   - Disable epoch closures by rotating `HCLAW_POINTS_CLOSE_KEY`.
   - Pause lock/rewards/agentic execution contracts on multisig (if deployed controls are enabled).
   - Point `NEXT_PUBLIC_VAULT_ADDRESS` back to previous stable vault and redeploy frontend.

## Ongoing Maintenance

- Weekly: run full `npm run check`.
- Before merging infrastructure changes: verify `supabase/migrations/` and runtime env keys are aligned.
- Keep this runbook updated whenever scripts or deploy assumptions change.
