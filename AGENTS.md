# Agent Rules

## Git Branch Strategy (Mandatory)

- `main` is the stable production branch and deployment source branch.
- Create one short-lived branch per scope/session (`feat/*`, `fix/*`, `docs/*`).
- Open PRs targeting `main` only.
- Rebase PR branches on latest `main` before merge when `main` has advanced (`git fetch origin` + `git rebase origin/main`).
- Resolve conflicts in the PR branch, rerun required validation, and merge only after green checks.
- For parallel execution, assign non-overlapping file ownership across concurrent branches.

## Validation Gates

- Run `npm run lint` before opening a PR.
- Run `npm run check` before merge.

## Documentation Requirements

- When public behavior changes, update relevant docs under `docs/` in the same branch.
