# Repository Structure

This map documents where production-critical code lives and how subprojects relate.

## Top-Level

- `app/`: Next.js App Router pages, API routes, and client components
- `lib/`: shared domain logic (trading, lifecycle, integrations, store, security)
- `contracts/`: Solidity vault contract sources
- `scripts/`: deployment and verification helpers
- `supabase/`: SQL migrations for persistent backend state
- `public/`: static assets and PWA icons
- `docs/`: implementation and operations documentation

## App Layer (`app/`)

- `app/api/**`: HTTP surface for trading, lifecycle, streaming, builder codes, AIP, and integrations
- `app/agents/**`: agent creation and management UI
- `app/monitor/**`, `app/arena/**`, `app/strategy/**`: operator and strategy pages
- `app/components/**`: reusable UI and feature components

## Domain Layer (`lib/`)

- `lib/agent-runner.ts`: autonomous execution loop
- `lib/agent-lifecycle.ts`: orchestration and health controls
- `lib/hyperliquid.ts`: exchange access and market/account fetchers
- `lib/ai.ts`: trading decision generation
- `lib/builder.ts`: builder fee/approval workflows
- `lib/lit-*.ts`: Lit Protocol and PKP integration
- `lib/store*.ts`: state persistence adapters
- `lib/unibase-aip.ts`: AIP registry and invocation handling
- `lib/mcp-server.ts`: MCP tool surface for fund-manager workflows

## Subprojects

- `ironclaw/`: Rust orchestration/fund-manager project with its own docs, tests, and tooling
- `hyperliquid-info-mcp/`: Python MCP utility with independent packaging

## Production Boundaries

- Root `package.json` governs the Next.js production service.
- Subproject dependencies and release cycles should be managed independently unless explicitly bundled.
- Any cross-project interface changes should be documented in both:
  - `docs/IRONCLAW_INTEGRATION.md`
  - `hyperliquid-info-mcp/README.md` or `ironclaw/README.md` as appropriate
