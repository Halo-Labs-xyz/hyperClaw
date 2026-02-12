# Main Track Compliance (Agent + Token)

Date: February 12, 2026

This document maps hackathon requirements to repository evidence and submission artifacts.

## 9.1 Autonomous Agent Requirements

Requirement: Genuine autonomous decision-making (not scripted `if/then`)
- Code evidence:
  - `lib/ai.ts`
  - `lib/agent-runner.ts`
  - `app/api/agents/[id]/tick/route.ts`
- Notes:
  - Runner executes AI-driven decisions with confidence, risk controls, and execution pipeline.

Requirement: Decisions without constant human intervention
- Code evidence:
  - `lib/agent-lifecycle.ts`
  - `lib/agent-runner.ts`
  - `app/api/agents/orchestrator/route.ts`
- Notes:
  - Active agents are ticked by orchestrator/runner loops; semi/manual modes are optional, full mode is autonomous.

Requirement: Clear demonstration of agent reasoning/learning
- Code evidence:
  - `lib/types.ts` (`TradeDecision.reasoning`)
  - `lib/trade-archive.ts`
  - `lib/supermemory.ts`
  - `lib/ai-budget.ts`
- Notes:
  - Decisions include explicit reasoning text and are persisted as trade logs. Memory integration exists for context carryover.

Requirement: Evidence of autonomous operation in demo video
- Submission artifact required:
  - `docs/submission/main-track-evidence.json` (video section)

## 9.2 Monad Integration Requirements

Requirement: Provide contract addresses or transaction hashes
- Submission artifact required:
  - `docs/submission/main-track-evidence.json` (`contracts` and `transactions`)

Requirement: Use Monad mainnet
- Code/runtime evidence:
  - `scripts/preflight-mainnet.mjs`
  - `lib/network.ts`
  - `lib/hclaw.ts`
- Enforcement:
  - `NEXT_PUBLIC_MONAD_TESTNET=false` required for mainnet deployment.

Requirement: Clearly document blockchain integration purpose
- Docs evidence:
  - `README.md`
  - `docs/HCLAW_MONAD_NADFUN_INTEGRATION_PRD.md`
- Notes:
  - Vault deposits, policy caps, lock/rewards, and treasury flows are on-chain.

Requirement: Demonstrate why Monad capabilities are utilized
- Docs/code evidence:
  - `README.md`
  - `contracts/HyperclawVaultV3.sol`
  - `contracts/HclawPolicy.sol`
  - `contracts/HclawLock.sol`

## 9.3 Token Requirements (Main Track)

Requirement: Token launched on nad.fun during hackathon period
- Submission artifact required:
  - `docs/submission/main-track-evidence.json` (`token.launch`)

Requirement: Token remains active/tradable through February 18, 2026
- Submission artifact required:
  - `docs/submission/main-track-evidence.json` (`token.tradability`)
- Enforcement:
  - Validator checks `activeThroughDate >= 2026-02-18`.

Requirement: Comply with nad.fun terms/policies
- Submission artifact required:
  - `docs/submission/main-track-evidence.json` (`token.compliance`)

## 9.4 Demo Video Requirements

Requirement: Video length <= 2 minutes
- Submission artifact required:
  - `docs/submission/main-track-evidence.json` (`demoVideo.durationSeconds <= 120`)

Requirement: Publicly accessible (YouTube/Loom/Vimeo/etc.)
- Submission artifact required:
  - `docs/submission/main-track-evidence.json` (`demoVideo.url`)

Requirement: Show real agent operation (not mockups/slides)
- Submission artifact required:
  - `docs/submission/main-track-evidence.json` (`demoVideo.showsLiveOperation`)

Requirement: Show autonomous decision-making
- Submission artifact required:
  - `docs/submission/main-track-evidence.json` (`demoVideo.showsAutonomousDecisions`)

Requirement: Show Monad blockchain interactions
- Submission artifact required:
  - `docs/submission/main-track-evidence.json` (`demoVideo.showsMonadInteractions`)

Requirement: Main Track shows token functionality/integration
- Submission artifact required:
  - `docs/submission/main-track-evidence.json` (`demoVideo.showsTokenIntegration`)

## Validation Command

Run:

```bash
npm run check:main-track
```

This validates required fields and hard constraints in `docs/submission/main-track-evidence.json`.
