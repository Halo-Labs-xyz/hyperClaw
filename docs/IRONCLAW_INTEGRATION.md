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
- **Auth:** Set `HYPERCLAW_API_KEY` or `MCP_API_KEY` in hyperClaw; IronClaw sends it as `Authorization: Bearer <key>` or `x-api-key` header. If no key is set, the endpoint is open (suitable only for local dev).

**Tools exposed to IronClaw:**

| Tool | Description |
|------|-------------|
| `hyperclaw_list_agents` | List all agents (id, name, status, markets, HL address). |
| `hyperclaw_agent_status` | Detailed status for one agent (runner, lifecycle, config). Requires `agent_id`. |
| `hyperclaw_lifecycle_summary` | Summary for all agents (counts, health, per-agent runner/AIP status). |
| `hyperclaw_lifecycle_action` | Run action: `activate`, `deactivate`, `init`, `health`, `heal`, `stop-all`. Use `agent_id` for activate/deactivate. |
| `hyperclaw_positions` | Current HL positions for one agent or all agents. Optional `agent_id`. |
| `hyperclaw_market_summary` | Market data: `mids`, `markets-enriched`, `book`, `funding`. Use `action` and optionally `coin`. |

**Configure in IronClaw:** Add one MCP server with URL = your hyperClaw base + `/api/mcp`, and the API key in secrets or env so IronClaw can authenticate.

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

## Summary

- **IronClaw** = overarching **agent fund manager assistant** for all hyperClaw agentic operations.
- **Best experience** = users interact through the **IronClaw sidecar UI/UX** (TUI, web, Telegram, etc.): secure and easily accessible.
- **hyperClaw** = execution; **IronClaw** = reasoning, tools, memory, safety.
- **Dual MCP:** Connect IronClaw to **hyperClaw MCP** (`POST /api/mcp`) for fund-manager tools and to **Hyperliquid Info MCP** (`hyperliquid-info-mcp/`) for deep analysis and stats—preemptively informing agent strategy creation and giving the best holistic experience.

See also: `ironclaw/README.md`, `ironclaw/CLAUDE.md`, `hyperliquid-info-mcp/README.md`, and hyperClaw’s `lib/mcp-server.ts`, `app/api/mcp/route.ts`, `lib/agent-runner.ts`, `app/api/lifecycle/route.ts`.
