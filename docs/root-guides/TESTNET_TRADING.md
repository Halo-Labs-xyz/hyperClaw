# Testing agent trading on testnet

Quick checklist to run an agent trade on Hyperliquid testnet.

## 1. Environment

- `.env` has `NEXT_PUBLIC_HYPERLIQUID_TESTNET=true` (or HL mirrors Monad testnet).
- Operator wallet (`HYPERLIQUID_PRIVATE_KEY`) is funded on **HL testnet** (e.g. USDC from [Hyperliquid testnet](https://app.hyperliquid-testnet.xyz)).
- Agent has a funded HL wallet: either deposit MON on the agent’s Deposit tab (relay provisions + funds the agent’s HL wallet) or use **Fund** → provision/fund for that agent.

## 2. Agent setup

- Agent has **Markets** set (e.g. BTC, ETH, SOL) and is **Active**.
- Agent’s HL wallet has a non‑zero balance (see agent detail **Deposit** tab or Hyperdash **Hyperliquid Wallets**).

## 3. Trigger a tick

**Option A – Single tick (manual)**  
- Open the agent detail page → click **Trigger AI Trade** (or **Tick**).  
- One AI decision runs and, if confidence ≥ 0.6, an order is placed from the **agent’s** HL wallet (not the operator).

**Option B – Strategy / backtest**  
- **Strategy** page: pick an agent, run multiple ticks (simulated or live depending on config).

**Option C – Autonomous runner**  
- `POST /api/agents/[id]/tick` with body `{ "action": "start", "intervalMs": 60000 }` to start the runner.  
- It will tick every `intervalMs` and place trades from the agent’s wallet when the AI decides to trade.

## 4. Verify

- **Agent detail → Trades**: new row with decision (long/short/hold), confidence, and executed status.
- **Monitor** page: select the agent and check orders/positions for that agent’s HL address.
- HL testnet: [app.hyperliquid-testnet.xyz](https://app.hyperliquid-testnet.xyz) — look up the agent’s wallet address (shown on agent detail under **Hyperliquid Wallet**).

## 5. Notes

- Trades use the **agent’s** Hyperliquid wallet (key stored in `.data/accounts.json` and linked to the agent). The operator key is only used to fund agent wallets via `usdSend`.
- If the agent has no HL key (wallet never provisioned), the tick still runs (AI decision, log) but no order is sent; the server logs: `No HL key found for agent wallet ...; skipping order execution`.
- Minimum confidence for execution is **0.6** (see `lib/agent-runner.ts`). Market/limit/stop-loss/take-profit all use the agent’s exchange client.
