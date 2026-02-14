# HyperClaw CLI

Professional CLI for interacting with the HyperClaw Railway dapp and IronClaw AWS instance. End-to-end flow: connect Privy, create agents, fund, deposit, and view the arena.

## Quick Start

```bash
# From project root
npm run hc -- config --base-url https://your-app.up.railway.app --api-key <key>

# Launch interactive TUI (recommended)
npm run hc -- tui
# or: hc tui

# Or install globally
cd cli && npm link
hc config --base-url https://your-app.up.railway.app --api-key <key>
hc tui
```

## Interactive TUI

Run `hc tui` for a full terminal UI:

- **Dashboard** – API health, agent summary
- **Agents** – List, select for details, create new (`n`)
- **Arena** – Leaderboard of active agents
- **Fund** – Provision and fund agents
- **Deposit** – Vault deposit info
- **IronClaw Chat** – Chat with the assistant
- **Config** – View configuration

**Keys:** `1-7` switch views · `↑↓` select · `Enter` confirm · `Esc` back · `q` quit

## Configuration

```bash
hc config --base-url <URL>    # Railway app URL
hc config --api-key <KEY>     # HYPERCLAW_API_KEY (for fund, provision, IronClaw)
hc config --privy-id <ID>     # From web app (optional, for agent ownership)
hc config --wallet <0x...>    # From web app (optional)
hc config --show              # View current config
```

Config is stored in `~/.hyperclaw/config.json`. Environment variables override:
- `HC_BASE_URL` or `PUBLIC_BASE_URL`
- `HC_API_KEY` or `HYPERCLAW_API_KEY`
- `HC_PRIVY_ID`, `HC_WALLET_ADDRESS`, `HC_NETWORK`

Advanced overrides:
- `HC_CONFIG_PATH` (use a custom config file path)
- `HC_CONFIG_DIR` (use a custom config directory; writes `config.json` inside)
- `HC_ORCHESTRATOR_KEY` (sets `x-orchestrator-key` when calling `hc orchestrator`)

## Connect Privy

```bash
hc login   # Shows instructions to connect wallet in web app
```

Then run `hc config --privy-id <id> --wallet 0x...` to link your identity.

## Commands

### Agents

```bash
hc agents list                    # List all agents
hc agents list --explore          # Active agents only
hc agents create -n "My Agent" -m BTC,ETH,SOL -r moderate --yes
hc agents get <agentId>           # Get agent details
hc agents get <agentId> --state  # Include HL positions
hc agents get <agentId> --trades  # Include trade history
hc agents tick <agentId>          # Trigger a single tick via /api/agents/[id]/tick
hc agents runner status <agentId> # Runner status
hc agents runner start <agentId>  # Start runner
hc agents runner stop <agentId>   # Stop runner
hc agents approve <agentId> <approvalId>       # Approve pending trade
hc agents approve <agentId> <approvalId> --reject  # Reject pending trade
hc agents chat list <agentId>     # List vault chat messages
hc agents chat send <agentId> "hi?" --type question  # Send message (agent may auto-respond)
```

### Fund

```bash
hc fund status                    # System status
hc fund provision <agentId> -a 100   # Provision + fund $100 + activate
hc fund balance <agentId>        # Agent balance
hc fund activate <agentId>        # Activate agent
```

### Deposit (Vault)

```bash
hc deposit info <agentId>        # Deposit info + instructions
hc deposit confirm <txHash>       # Confirm deposit after tx
```

### Arena

```bash
hc arena                         # Active agents leaderboard
```

### IronClaw

```bash
hc ironclaw health               # Check IronClaw health
hc ironclaw chat "Hello"        # Send message to assistant
hc ironclaw chat "Hello" -t <threadId>  # Continue conversation
```

### Orchestrator

```bash
hc orchestrator                  # Active agents + tick schedule bounds
```

### Doctor

```bash
hc doctor                        # Validate config + API reachability
hc doctor --json                 # Machine-readable report
```

### Health

```bash
hc health                        # API health check
```

## End-to-End Flow

1. **Configure**: `hc config --base-url <URL> --api-key <KEY>`
2. **Connect Privy** (optional): `hc login` → open web app → `hc config --privy-id <id> --wallet 0x...`
3. **Create agent**: `hc agents create -n "Alpha" -m BTC,ETH,SOL -r moderate --yes`
4. **Fund agent**: `hc fund provision <agentId> -a 100`
5. **Or deposit via vault**: `hc deposit info <agentId>` → follow instructions → `hc deposit confirm <txHash>`
6. **View arena**: `hc arena`
7. **View agent state**: `hc agents get <agentId> --state --trades`
8. **Chat with IronClaw**: `hc ironclaw chat "What's your strategy?"`

## API Key

For production, set `HYPERCLAW_API_KEY` on your Railway server. The CLI uses this for:
- `fund` (provision, balance, activate)
- `ironclaw` (chat, health)
- `deposit confirm`

Pass the same key to the CLI: `hc config --api-key <key>`
