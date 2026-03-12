---
name: ms-4
description: Execute MS-4 (WS-4) with multi agent discipline using strict branch policy, dependency ordering, file ownership isolation, validation, and deterministic merge sequencing.
---

# MS-4

Use this exact prompt template:

```text
Execute MS-4 (WS-4) with multi agent discipline. MAKE NO MISTAKES.

Repository and branch policy:
- `main` is the stable production branch.
- Every session branch must be created from latest `origin/main`.
- Every PR must target `main`.
- Rebase each PR branch on latest `origin/main` immediately before merge.
- Do not merge feature branches into other feature branches.
- If rebase conflict occurs, resolve in that PR branch, rerun validations, then continue.

Constraints:
- Chronological execution only for hard dependencies.
- One branch per session.
- No overlapping files across active branches.
- If a required file is owned by another active branch, mark blocked and stop.
- Output first: dependency graph, branch plan, file-ownership map, merge order, and base SHA from `origin/main`.
- Per session report: branch name, base SHA, commits, changed files, validation commands, validation results.

Session prompts:

Session 1: branch feat/ms4-intent-contracts. MAKE NO MISTAKES.
Scope: WS-4.1 typed runtime artifacts and wiring.
Owned files only:
- src/agent/intent.rs (new)
- src/agent/mod.rs
- src/settings.rs
Do not edit any other files.
Run Rust validation and report results.

Session 2: branch feat/ms4-hyperliquid-tool. MAKE NO MISTAKES.
Dependency: start after Session 1 commit is available.
Scope: WS-4.2 Hyperliquid tool implementation + registry integration.
Owned files only:
- src/tools/hyperliquid.rs (new)
- src/tools/mod.rs
- src/tools/registry.rs
Do not edit any other files.
Run Rust validation and report results.

Session 3: branch feat/ms4-hyperclaw-bridge-routes. MAKE NO MISTAKES.
Dependency: start after Session 1 and Session 2 commits are available.
Scope: WS-4.3 bridge routes for intents/execute/verify/runs.
Owned files only:
- ../hyperClaw/app/api/liquidclaw/intents/route.ts
- ../hyperClaw/app/api/liquidclaw/execute/route.ts
- ../hyperClaw/app/api/liquidclaw/verify/route.ts
- ../hyperClaw/app/api/liquidclaw/runs/[id]/route.ts
Do not edit any other files.
Run `npm run lint` and relevant checks in `hyperClaw`, report results.

Session 4: branch docs/ms4-intent-execution-pipeline. MAKE NO MISTAKES.
Dependency: start after Session 3 commit is available.
Scope: docs sync for public behavior changes.
Owned files only:
- docs/LIQUIDCLAW_E2E_TODO_PRD.md
- docs/LIQUIDCLAW_VERIFIABLE_HL_AGENT_KIT_PRD.md
- src/setup/README.md (only if onboarding/runtime behavior text changed)
Do not edit any other files.
Run docs/lint checks and report results.

Merge order:
1. feat/ms4-intent-contracts
2. feat/ms4-hyperliquid-tool
3. feat/ms4-hyperclaw-bridge-routes
4. docs/ms4-intent-execution-pipeline
```
