# Unit + Railway Dev Context

## Current State (2026-02-12)

- Bridge deposit path validated end-to-end on Monad mainnet -> Hyperunit.
- Verified tx: `0x751529770a212105349e9893f2143fe8683f902fbdb2f85714c0d67b5a2f8d53`.
- Relay response confirmed:
  - `bridgeProvider=hyperunit`
  - `bridgeStatus=submitted`
  - `bridgeTxHash=0x98657c78066900e9775300d7b8e9fdfc49fdfa2e37cf087994aca28ab45eef0a`
  - `hlFunded=true`
- Hyperunit operations endpoint confirmed reachable:
  - `GET https://api.hyperunit.xyz/operations/0xa438B019932F57352bd14347f8925ddF29704183` returned 200.

## Bridge Integration Notes

- `lib/mainnet-bridge.ts` includes:
  - Optional Hyperunit auth headers (`HYPERUNIT_API_KEY`, `HYPERUNIT_BEARER_TOKEN`).
  - Operations lookup (`GET /operations/:address`) for address reuse and operation-state context.
  - Retryable pending behavior instead of terminal failure when Hyperunit errors combine with unconfigured deBridge fallback.

## Railway Deploy Blocker

- No valid Railway auth token/session is currently available.
- `railway whoami` returns `Unauthorized. Please login with railway login`.
- Tokens in `.env` and `.env.bak.20260211011312` are invalid/expired.

## Deployment Command Path

After setting a valid token in shell:

```bash
export RAILWAY_TOKEN=<valid_token>
export RAILWAY_PROJECT_ID=51ace337-7b35-4a11-af30-759a109efc62
# optional if project has multiple services/environments
export RAILWAY_SERVICE_ID=<service_id>
export RAILWAY_ENVIRONMENT_ID=<environment_id>
./scripts/deploy-railway-dev.sh
```

## Required Runtime Variables to Reconfirm in Railway

- `MAINNET_BRIDGE_ENABLED=true`
- `HYPERUNIT_API_URL=https://api.hyperunit.xyz`
- `HYPERUNIT_MONAD_CHAIN=monad`
- `HYPERUNIT_HYPERLIQUID_CHAIN=hyperliquid`
- `HYPERUNIT_DEPOSIT_ASSET=mon`
- `HYPERUNIT_WITHDRAW_ASSET=usdc`
- Optional when Hyperunit environment is restricted:
  - `HYPERUNIT_API_KEY`
  - `HYPERUNIT_BEARER_TOKEN`

## MCP Note

- Unit MCP resources are not exposed in this Codex session (`list_mcp_resources` returned empty).
- This file is the authoritative continuity context for the current development/deploy cycle.
