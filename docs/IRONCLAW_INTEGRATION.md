# IronClaw Integration Guide

How **IronClaw** (in `ironclaw/`) integrates with **hyperClaw** as the overarching **agent fund manager assistant** for all hyperClaw agentic operations.

---

## Vision: IronClaw as Fund Manager Assistant

**IronClaw is the user-facing control plane for hyperClaw.** Users get the best experience by interacting with their agents, positions, and vault through **IronClaw’s UI/UX** (sidecar)—secure and easily accessible—while hyperClaw remains the execution layer.

| Layer | Role | User access |
|-------|------|-------------|
| **IronClaw** | Overarching **agent fund manager assistant**: query agents, positions, PnL; start/stop agents; approve flows; natural-language Q&A; memory and tools. | **Primary UX**: IronClaw TUI, web gateway, HTTP webhook, Telegram/Slack (WASM channels). Secure, local-first, one place to “talk to” the fund. |
| **hyperClaw** | **Execution engine**: deposit relay, agent runner, Hyperliquid API, Lit Protocol, trade alerts/approvals. | Dashboard and API for power users; Telegram for trade notifications and approval buttons. |

**Why this is the best experience**

- **Single assistant** – One place (IronClaw) to ask “What’s my exposure?”, “Pause the BTC agent”, “Summarize today’s trades”, “Why did the last trade get rejected?”
- **Secure** – IronClaw’s model: WASM sandbox, credential injection, prompt-injection defense, local/encrypted memory. Sensitive actions go through the same safety layer.
- **Easily accessible** – Users can use the **IronClaw sidecar UI/UX** (CLI/TUI, web UI, or channels like Telegram/Slack) instead of being forced into the hyperClaw web app for every question or command.
- **Clear split** – hyperClaw does execution; IronClaw does reasoning, tool use, and conversation. No mixing of concerns.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  User                                                                   │
│  TUI / Web UI / Telegram / Slack / HTTP  ←  IronClaw UI/UX (sidecar)   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  IronClaw (Fund Manager Assistant)                                      │
│  • LLM reasoning (NEAR AI)                                              │
│  • Memory, tools, MCP, WASM sandbox                                     │
│  • Safety layer, credentials                                            │
│  • Tools that call hyperClaw (via MCP or HTTP)                          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │  list agents, positions, lifecycle,
                                 │  market data, approve, etc.
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  hyperClaw (Execution)                                                 │
│  • Agent runner, deposit relay, Lit Protocol                            │
│  • /api/agents, /api/lifecycle, /api/stream/*, /api/trade, etc.         │
│  • Telegram trade alerts & approval buttons                             │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
                    Hyperliquid, Monad vault, etc.
```

---

## Dual MCP Setup: Fund Manager + Deep Analysis

IronClaw gets the **best holistic experience** by connecting to **two** MCP servers:

1. **hyperClaw MCP** – fund manager tools (agents, lifecycle, positions, market summary).
2. **Hyperliquid Info MCP** (`hyperliquid-info-mcp/`) – deep Hyperliquid analysis and stats (user state, fills, funding, L2 book, candles, metadata) to inform **agent strategy creation** and preemptive insights.

Together they give users one assistant that can manage agents *and* reason over full market and account data.

---

### hyperClaw MCP server (implemented)

- **Endpoint:** `POST /api/mcp` (e.g. `https://your-hyperclaw.com/api/mcp` or `http://localhost:3000/api/mcp`).
- **Protocol:** JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`.
- **Auth (supported modes):**
  - `x-api-key: <key>` header
  - `Authorization: Bearer <key>` header
  - If neither `HYPERCLAW_API_KEY` nor `MCP_API_KEY` is set, endpoint is open (local dev only, not production)

**Tools exposed to IronClaw:**

| Tool | Description |
|------|-------------|
| `hyperclaw_list_agents` | List all agents (id, name, status, markets, HL address). |
| `hyperclaw_agent_status` | Detailed status for one agent (runner, lifecycle, config). Requires `agent_id`. |
| `hyperclaw_lifecycle_summary` | Summary for all agents (counts, health, per-agent runner/AIP status). |
| `hyperclaw_lifecycle_action` | Run action: `activate`, `deactivate`, `init`, `health`, `heal`, `stop-all`. Use `agent_id` for activate/deactivate. |
| `hyperclaw_positions` | Current HL positions for one agent or all agents. Optional `agent_id`. |
| `hyperclaw_exposure` | Exposure workflow: portfolio or single-agent gross/net exposure, long/short split, equity, and leverage proxy. Optional `agent`. |
| `hyperclaw_pause_agent` | Pause workflow: pause one agent by `agent` id/name, with optional `dry_run` preview. |
| `hyperclaw_daily_trade_summary` | Daily workflow: windowed trade summary plus anomaly detection (rejections, concentration, leverage breaches, burst trading). |
| `hyperclaw_market_summary` | Market data: `mids`, `markets-enriched`, `book`, `funding`. Use `action` and optionally `coin`. |

**Configure in IronClaw:** Add the MCP server with static API-key auth (no OAuth):

```bash
# Add hyperclaw MCP with API key (port 3014 = hyperClaw dev; use 3000 for default)
ironclaw mcp add hyperclaw http://localhost:3014/api/mcp \
  --api-key YOUR_HYPERCLAW_API_KEY \
  --api-key-header x-api-key

# If your endpoint expects Authorization header format:
ironclaw mcp add hyperclaw http://localhost:3014/api/mcp \
  --api-key "Bearer YOUR_HYPERCLAW_API_KEY" \
  --api-key-header Authorization

# Test the connection
ironclaw mcp test hyperclaw
```

If `HYPERCLAW_API_KEY` or `MCP_API_KEY` is set in hyperClaw, use that same value for `--api-key` (or `Bearer <key>` when using `Authorization` header mode).

IronClaw now stores `--api-key` values in encrypted secrets storage. `~/.ironclaw/mcp-servers.json` stores only header metadata and a secret reference, not plaintext key material.

To migrate old plaintext entries from `mcp-servers.json`:

```bash
ironclaw mcp list --verbose
```

This triggers migration of legacy static auth values into secrets storage.

### Final MCP auth modes

| Mode | How to configure | Secret storage |
|------|------------------|----------------|
| Static header API key | `ironclaw mcp add ... --api-key ... --api-key-header ...` | Encrypted in IronClaw secrets; config stores only secret reference |
| OAuth 2.1 (incl. DCR) | `ironclaw mcp add ... --client-id ...` then `ironclaw mcp auth ...` | Access/refresh tokens in IronClaw secrets |
| No auth (dev only) | No key and no OAuth | Not recommended for production |

### Telegram-First Fund Manager Workflows

These are the three core bot intents for a seamless trading UX:

1. **"What's my exposure?"**
   - Call `hyperclaw_exposure` with no args (portfolio) or with `agent`.
   - Bot should return: gross/net exposure, top coin concentration, and highest-risk agent.
2. **"Pause agent X"**
   - Call `hyperclaw_pause_agent` with `agent` as the exact message text token after "pause".
   - Use `dry_run=true` first if you want a confirmation step in Telegram.
3. **"Daily trade summary + anomalies"**
   - Call `hyperclaw_daily_trade_summary` (default 24h window) or pass `window_hours`.
   - Bot should return: totals, top assets/agents, and anomaly list with severity.

Recommended behavior in IronClaw Telegram channel:

- Prefer `hyperclaw_pause_agent` over generic lifecycle tools for user-facing pause requests.
- For ambiguity ("pause btc"), retry with `hyperclaw_list_agents` and ask the user to pick one.
- Always include next action in responses when anomalies are detected (e.g. "inspect rejection spike for Agent A").

---

### Hyperliquid Info MCP (deep analysis and stats)

The **`hyperliquid-info-mcp/`** Python server exposes Hyperliquid-native tools for:

- **User data:** `get_user_state`, `get_user_open_orders`, `get_user_trade_history`, `get_user_funding_history`, `get_user_fees`, staking, sub-accounts.
- **Market data:** `get_all_mids`, `get_l2_snapshot`, `get_candles_snapshot`, `get_coin_funding_history`, `get_perp_metadata`, `get_spot_metadata`.
- **Analysis:** `analyze_positions` prompt for risk/performance.

Use this in IronClaw so the assistant can:

- Pull deep stats and history **before** creating or tuning agents (funding regimes, volatility, OI).
- Answer “How has this account performed?” or “What’s the current order book for BTC?” without leaving the fund-manager UX.

**Run the server:**

```bash
cd hyperliquid-info-mcp
uv sync
# Stdio (default): for use with MCP Inspector or stdio-based clients
mcp dev main.py

# HTTP: for IronClaw's HTTP MCP client (Streamable HTTP)
MCP_TRANSPORT=streamable-http MCP_PORT=8000 uv run python main.py
```
Then use `http://localhost:8000` (or your host/port) as the MCP server URL in IronClaw. If your FastMCP version does not support `streamable-http`, use an MCP HTTP bridge or see FastMCP docs.

If the Python server runs over HTTP, use its URL (e.g. `http://localhost:8000/mcp`) as a second MCP server in IronClaw. If it runs only over stdio, use an MCP HTTP bridge or run it in a process that exposes HTTP; see [MCP Streamable HTTP](https://modelcontextprotocol.io/docs/concepts/transports#streamable-http) and FastMCP docs.

**Configure in IronClaw:** Add a second MCP server (e.g. name `hyperliquid-info`, URL = the HTTP endpoint above). No auth required for local; use OAuth or a shared secret if you expose it remotely.

---

## Running IronClaw as the Sidecar

For a separate internet-facing AWS deployment of IronClaw (independent from hyperClaw host), use `docs/IRONCLAW_AWS_DEPLOY.md`.

1. **Build and run IronClaw** (see `ironclaw/README.md`):
   - Rust 1.85+, PostgreSQL 15+ with pgvector.
   - `cargo build --release`, migrations, `ironclaw setup` (NEAR AI, etc.).
   - Enable HTTP channel: `HTTP_HOST=0.0.0.0`, `HTTP_PORT=8080`, optional `HTTP_WEBHOOK_SECRET`.

2. **Configure hyperClaw → IronClaw** (optional, for in-app chat or health):
   - In hyperClaw `.env`: `IRONCLAW_WEBHOOK_URL=http://127.0.0.1:8080/webhook`, optional `IRONCLAW_WEBHOOK_SECRET`.
   - Then the hyperClaw app can proxy assistant requests to IronClaw via `POST /api/ironclaw` (e.g. for an embedded “Ask the fund manager” box).

3. **Configure IronClaw → two MCP servers** (holistic fund manager + deep analysis):
   - **hyperClaw:** URL = your hyperClaw base + `/api/mcp` (e.g. `http://localhost:3000/api/mcp`). Set `HYPERCLAW_API_KEY` or `MCP_API_KEY` in hyperClaw and configure the same key in IronClaw so it can authenticate.
   - **Hyperliquid Info:** Run `hyperliquid-info-mcp` (see above) and add its HTTP URL as a second MCP server in IronClaw. Gives the assistant deep HL stats and analysis for strategy creation and preemptive insights.

4. **User experience:** Users open **IronClaw’s UI** (TUI, web gateway, or Telegram/Slack). They ask things like “List my agents”, “What’s my BTC exposure?”, “What’s the funding regime for ETH?”, “Pause the ETH agent”, “Summarize today’s trades”, or “Help me design a new agent given current market conditions”. IronClaw uses both MCP servers and responds in one place—secure and easily accessible through the sidecar.

### One-command local/staging boot

From the hyperClaw repo root:

```bash
npm run dev:stack
```

This starts:
- Postgres + pgvector (Docker)
- IronClaw HTTP channel on `127.0.0.1:8080`
- hyperClaw on `127.0.0.1:3014`

Logs, pid files, and generated local secrets are written to `/tmp/hyperclaw-stack/`.

### Rotate exposed local secrets

Treat existing local dev/test secrets as exposed and rotate:

```bash
npm run rotate:dev-secrets
```

This rotates local keys in `.env` (with backup), including:
- `SECRETS_MASTER_KEY`
- `HYPERCLAW_API_KEY` / `MCP_API_KEY`
- webhook and orchestrator shared secrets

After rotation:
1. Restart the local stack.
2. Re-run `ironclaw mcp add ... --api-key ... --api-key-header ...` with the rotated value.
3. Run `ironclaw mcp test <server>` to verify auth.

### Recommended production defaults

- Keep `/api/mcp` protected: set `HYPERCLAW_API_KEY` and/or `MCP_API_KEY`.
- Use explicit header mode when adding MCP server (`--api-key-header x-api-key` or `Authorization`).
- Keep runtime network switching disabled (`ALLOW_RUNTIME_NETWORK_SWITCH=false`).
- Set webhook auth on both sides: `HTTP_WEBHOOK_SECRET` (IronClaw) and `IRONCLAW_WEBHOOK_SECRET` (hyperClaw).
- Ensure `SECRETS_MASTER_KEY` is set and persisted so MCP auth material remains decryptable.

---

## IronClaw HTTP Webhook (for hyperClaw → IronClaw)

When you want the **hyperClaw app** to also send messages to the assistant (e.g. “Ask the fund manager” in the dashboard):

- **IronClaw** exposes:
  - `POST /webhook` – body: `{ "content": "user message", "thread_id?", "secret?", "wait_for_response?" }`. With `wait_for_response: true`, the response includes the assistant’s reply.
  - `GET /health` – health check.
- **hyperClaw** uses `lib/ironclaw.ts` and `POST /api/ironclaw` when `IRONCLAW_WEBHOOK_URL` is set.

So you get **two directions**:
- **User → IronClaw UI** = primary, best experience (fund manager assistant).
- **User → hyperClaw app → IronClaw webhook** = optional, for in-app assistant or health.

---

## Shared Telegram (optional)

- **hyperClaw** already uses Telegram for trade notifications and approval flows.
- **IronClaw** can run a Telegram WASM channel so the same (or a second) bot can handle conversational DMs.
- **Two bots:** One for hyperClaw (trades, approvals), one for IronClaw (fund manager chat). Easiest.
- **One bot:** Route by command (e.g. `/ask` → IronClaw; rest → hyperClaw). Requires a small gateway.

Users can then “talk to the fund manager” in Telegram as well, consistent with the sidecar UX.

---

## Maintenance: Clean Up Test MCP Entries

If you added temporary MCP servers (e.g. pointing to `localhost:3015` or other test ports), remove them:

```bash
# List configured servers
ironclaw mcp list

# Remove a test server by name
ironclaw mcp remove <server-name>
```

Config is stored at `~/.ironclaw/mcp-servers.json`; removing entries via `mcp remove` is the recommended way.

---

## Summary

- **IronClaw** = overarching **agent fund manager assistant** for all hyperClaw agentic operations.
- **Best experience** = users interact through the **IronClaw sidecar UI/UX** (TUI, web, Telegram, etc.): secure and easily accessible.
- **hyperClaw** = execution; **IronClaw** = reasoning, tools, memory, safety.
- **Dual MCP:** Connect IronClaw to **hyperClaw MCP** (`POST /api/mcp`) for fund-manager tools and to **Hyperliquid Info MCP** (`hyperliquid-info-mcp/`) for deep analysis and stats—preemptively informing agent strategy creation and giving the best holistic experience.

See also: `ironclaw/README.md`, `ironclaw/CLAUDE.md`, `hyperliquid-info-mcp/README.md`, and hyperClaw’s `lib/mcp-server.ts`, `app/api/mcp/route.ts`, `lib/agent-runner.ts`, `app/api/lifecycle/route.ts`.
