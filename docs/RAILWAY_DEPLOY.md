# Deploy Hyperclaw to Railway

This guide covers deploying the Hyperclaw Next.js app to [Railway](https://railway.app).

## Prerequisites

- Railway account ([railway.app](https://railway.app))
- GitHub repo connected to Railway
- Required external services: Supabase (or S3), Privy, Hyperliquid, etc.

## Quick Deploy

1. **Create a new project** in Railway and connect your GitHub repo.

2. **Configure the service**:
   - Railway should auto-detect the Dockerfile
   - If not, set Build → Builder: `DOCKERFILE` in the dashboard

3. **Add environment variables** (see checklist below).

4. **Deploy** — Railway will build and deploy automatically on push.

## Environment Variables

Railway injects env vars at runtime. For `NEXT_PUBLIC_*` vars, Railway passes them as build args so they are baked into the Next.js bundle.

### Required (minimum to boot)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy app ID (auth) |
| `NEXT_PUBLIC_PRIVY_CLIENT_ID` | Privy client ID (optional) |
| `NEXT_PUBLIC_HYPERLIQUID_TESTNET` | `true` for testnet, `false` for mainnet |
| `NEXT_PUBLIC_MONAD_TESTNET` | `true` for Monad testnet, `false` for mainnet |
| `NEXT_PUBLIC_VAULT_ADDRESS` | Hyperclaw vault contract address |
| `HYPERLIQUID_PRIVATE_KEY` | Operator wallet (funds agent wallets) |
| `ACCOUNT_ENCRYPTION_KEY` | Encrypt stored agent keys (`openssl rand -hex 32`) |
| `OPENAI_API_KEY` | AI agent brain |
| `HYPERCLAW_API_KEY` | API auth (`openssl rand -hex 32`) |

### Storage (pick one)

Railway has an **ephemeral filesystem** — `.data/` is lost on redeploy. You must use external storage:

**Option A: Supabase (recommended)**

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | `https://your-project.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key from Supabase |

Before enabling Supabase in Railway, apply every SQL file in `supabase/migrations/`.
Required core tables: `hc_agents`, `hc_deposits`, `hc_cursors`, `hc_trades`, `hc_vault_messages`.
If HCLAW features are enabled, also apply `supabase/migrations/20260211_hclaw_rewards.sql`.

**Option B: AWS S3**

| Variable | Description |
|----------|-------------|
| `AWS_S3_BUCKET` | S3 bucket name |
| `AWS_REGION` | e.g. `us-east-1` |
| `AWS_ACCESS_KEY_ID` | IAM credentials |
| `AWS_SECRET_ACCESS_KEY` | IAM credentials |

### Optional but recommended

| Variable | Description |
|----------|-------------|
| `MONAD_PRIVATE_KEY` | Vault deployer / deposit relay |
| `TELEGRAM_BOT_TOKEN` | Notifications + vault chat |
| `TELEGRAM_WEBHOOK_URL` | Optional explicit Telegram webhook URL (full path) |
| `PUBLIC_BASE_URL` | Optional base URL used for Telegram webhook auto-sync |
| `TELEGRAM_WEBHOOK_SECRET` | Optional Telegram secret token for webhook validation |
| `NEXT_PUBLIC_WEB_PUSH_PUBLIC_KEY` | Web push (with `WEB_PUSH_PRIVATE_KEY`) |
| `GEMINI_API_KEY` | Fallback AI when OpenAI is limited |
| `MCP_API_KEY` | IronClaw MCP auth |
| `ORCHESTRATOR_SECRET` | If using external orchestrator |

### HCLAW token (if using $HCLAW)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS` | Token contract |
| `NEXT_PUBLIC_HCLAW_LOCK_ADDRESS` | Lock contract |
| `NEXT_PUBLIC_HCLAW_POLICY_ADDRESS` | Policy contract |
| `NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS` | Rewards contract |
| `NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS` | LP vault |
| `HCLAW_POINTS_CLOSE_KEY` | Epoch close auth |

### Lit Protocol PKP (optional)

| Variable | Description |
|----------|-------------|
| `USE_LIT_PKP` | `true` for PKP wallets |
| `LIT_NETWORK` | `naga-dev`, `naga-test`, or `naga` |

## Build-time variables

The Dockerfile expects these as build args for `NEXT_PUBLIC_*` vars. Railway passes env vars as build args automatically. Ensure these are set in Railway before the first build:

- `NEXT_PUBLIC_PRIVY_APP_ID`
- `NEXT_PUBLIC_PRIVY_CLIENT_ID`
- `NEXT_PUBLIC_WEB_PUSH_PUBLIC_KEY`
- `NEXT_PUBLIC_HYPERLIQUID_TESTNET`
- `NEXT_PUBLIC_MONAD_TESTNET`
- `NEXT_PUBLIC_VAULT_ADDRESS`
- `NEXT_PUBLIC_HCLAW_*` addresses
- `NEXT_PUBLIC_BUILDER_ADDRESS`
- `NEXT_PUBLIC_BUILDER_FEE`

## Custom domain

1. In Railway: Project → Settings → Domains
2. Add your domain (e.g. `hyperclaw.yourdomain.com`)
3. Update DNS per Railway’s instructions

## Unibase AIP (agent-to-agent)

For public agents with DIRECT mode:

1. Set `AGENT_PUBLIC_URL` to your Railway URL, e.g. `https://your-app.railway.app`
2. Set `AIP_DEPLOYMENT_MODE=DIRECT`

For private agents, use `AIP_DEPLOYMENT_MODE=POLLING` (default).

## Health check

Railway uses `railway.json` to configure a health check at `/api/health`.

On each health probe, Hyperclaw:

- Ensures the agent lifecycle manager is initialized
- Reconciles active agent runners
- Periodically syncs the Telegram webhook to the current public deployment URL

Webhook URL resolution priority:

1. `TELEGRAM_WEBHOOK_URL` (full URL)
2. `PUBLIC_BASE_URL` (builds `${PUBLIC_BASE_URL}/api/telegram/webhook`)
3. Railway domain env vars (`RAILWAY_STATIC_URL`, `RAILWAY_PUBLIC_DOMAIN`)
4. `AGENT_PUBLIC_URL` / `VERCEL_URL` fallback

## Troubleshooting

- **Build fails**: Check Railway build logs. Ensure all `NEXT_PUBLIC_*` vars needed at build time are set.
- **App crashes on start**: Check logs for missing env vars. Supabase/S3 must be configured (no persistent `.data/` on Railway).
- **Port**: Railway sets `PORT` automatically; the app uses it.
- **Redeploy**: Push to your connected branch or use “Redeploy” in the Railway dashboard.
