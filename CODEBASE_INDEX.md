# HyperClaw Codebase Index

**Purpose:** Understand the application structure, data flow, and key modules.

---

## 1. Application Overview

**HyperClaw** = AI-powered autonomous trading agents on Hyperliquid, funded through Monad vaults.

**End-to-end flow:**
1. User deposits MON/ERC20 on Monad → `HyperclawVault.sol`
2. Deposit relay detects tx → converts to USDC value → sends to agent's HL wallet
3. Agent runner ticks on interval → fetches market data → AI decides → executes trades (or proposes)
4. In semi-auto mode: Telegram approval before execution
5. Frontend streams positions, orders, book via SSE

---

## 2. Project Structure

```
hyperClaw/
├── app/                      # Next.js App Router
│   ├── page.tsx              # Dashboard
│   ├── layout.tsx            # Root (Privy, Wagmi, QueryClient)
│   ├── agents/               # Agent CRUD pages
│   ├── monitor/              # Real-time trading monitor
│   ├── strategy/             # Backtester UI
│   ├── api/                  # API routes
│   └── components/           # Shared UI
├── lib/                      # Core logic (server & shared)
├── contracts/                # Solidity (HyperclawVault.sol)
├── hyperliquid/              # @nktkas/hyperliquid SDK (embedded)
└── .data/                    # JSON storage (agents, accounts, trades)
```

---

## 3. Lib Modules (Core Logic)

### 3.1 Agent Lifecycle

| File | Purpose | Key Exports |
|------|---------|-------------|
| **agent-runner.ts** | Autonomous tick loop | `startAgent`, `stopAgent`, `executeTick`, `executeApprovedTrade` |
| **ai.ts** | LLM trade decision | `getTradeDecision(params) → TradeDecision` |
| **store.ts** | Agent/trade persistence | `getAgent`, `createAgent`, `updateAgent`, `appendTradeLog`, `setPendingApproval` |

**Agent tick flow:**
```
executeTick(agentId)
  → getEnrichedMarketData()
  → getAccountState(hlAddress)
  → getTradeDecision({ markets, positions, balance, riskLevel, ... })
  → if decision.action !== "hold" && confidence >= 0.6:
       → full_auto: execute immediately
       → semi_auto: setPendingApproval + sendApprovalRequest(Telegram)
  → appendTradeLog
```

### 3.2 Trading & Exchange

| File | Purpose | Key Exports |
|------|---------|-------------|
| **hyperliquid.ts** | HL SDK wrapper | `getInfoClient`, `getExchangeClient`, `placeOrder`, `placeMarketOrder`, `executeOrder`, `getExchangeClientForAgent`, `provisionAgentWallet`, `sendUsdToAgent` |
| **account-manager.ts** | Encrypted key storage | `addAccount`, `getAccountForAgent`, `getPrivateKeyForAgent`, `linkAccountToAgent` |

### 3.3 Deposit & Funding

| File | Purpose | Key Exports |
|------|---------|-------------|
| **deposit-relay.ts** | Monad → HL bridge | `processDepositTx`, `startDepositPoller`, `getDepositsForAgent`, `getUserSharePercent`, `getVaultTvlOnChain` |
| **vault.ts** | Vault contract helpers | `getVaultAddress`, `agentIdToBytes32`, `VAULT_ABI` |

**Deposit flow:**
```
User deposits on Monad
  → Poller / POST /api/deposit with txHash
  → processDepositTx() parses Deposited event
  → Converts MON→USDC via CoinGecko/DeFiLlama
  → provisionAgentWallet() creates/funds HL wallet
  → sendUsdToAgent() sends USDC to agent
```

### 3.4 $HCLAW Token & Tiers

| File | Purpose | Key Exports |
|------|---------|-------------|
| **hclaw.ts** | nad.fun bonding curve | `getHclawState`, `getTierForMcap`, `getProgressToNextTier` |

Tiers: Hatchling ($0→$100), Hunter ($1K), Striker ($10K), Apex ($100K) max deposit.

### 3.5 Real-Time Streaming

| File | Purpose | Key Exports |
|------|---------|-------------|
| **watchers.ts** | WebSocket → SSE bridge | `watchPositions`, `watchOrders`, `watchBalances`, `watchPrices`, `watchBook`, `fetchPositionsSnapshot` |
| **sse.ts** | SSE response builder | `createSSEResponse(setup)` |
| **hooks/useSSE.ts** | Client hook | `useSSE`, `useSSEMulti` |

### 3.6 Notifications

| File | Purpose | Key Exports |
|------|---------|-------------|
| **telegram.ts** | Telegram Bot API | `notifyTradeExecuted`, `sendApprovalRequest`, `postToVaultGroup`, `handleInvestorQuestion` |

### 3.7 Infrastructure

| File | Purpose | Key Exports |
|------|---------|-------------|
| **store-backend.ts** | Persistence | `readJSON`, `writeJSON` (file or S3) |
| **network.ts** | Network state | `getNetworkState`, `isHlTestnet`, `isMonadTestnet`, `setNetworkState`, `onNetworkChange` |
| **auth.ts** | API auth | `verifyOrchestratorAuth`, `verifyApiKey` |
| **env.ts** | Env helpers | `isEnvSet`, `getVaultAddressIfDeployed` |

---

## 4. API Routes

### Agents

| Route | Method | Handler | Purpose |
|-------|--------|---------|---------|
| `/api/agents` | GET | `getAgents()` | List agents |
| `/api/agents` | POST | `createAgent()` + `generateAgentWallet()` + `addAccount()` | Create agent + HL wallet |
| `/api/agents/[id]` | GET | `getAgent()` + trade logs | Agent detail |
| `/api/agents/[id]` | PATCH | `updateAgent()` | Update config |
| `/api/agents/[id]/tick` | POST | `executeTick` / `startAgent` / `stopAgent` | Tick or runner control |
| `/api/agents/[id]/approve` | POST | `executeApprovedTrade()` | Approve/reject semi-auto trade |
| `/api/agents/[id]/chat` | GET/POST | Vault chat | Fetch/post vault messages |
| `/api/agents/orchestrator` | GET | Active agent IDs | For EC2 orchestrator |

### Trading

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/trade` | POST | Place order (market/limit/SL/TP) |
| `/api/trade/cancel` | POST | Cancel order(s) |
| `/api/trade/leverage` | POST | Set leverage |

### Funding & Deposit

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/deposit` | POST | Confirm deposit tx (`txHash`) |
| `/api/deposit` | GET | Query deposits, shares, TVL |
| `/api/fund` | POST | Provision/fund agent wallets |

### Streaming (SSE)

| Route | Data |
|-------|------|
| `/api/stream/positions` | Live positions for user |
| `/api/stream/orders` | Live orders |
| `/api/stream/balances` | Live balances |
| `/api/stream/prices` | Live mid prices |
| `/api/stream/book` | L2 order book |

### Other

| Route | Purpose |
|-------|---------|
| `/api/market` | Mid prices, L2 book, funding |
| `/api/token` | $HCLAW token state |
| `/api/network` | Get/set network |
| `/api/accounts` | List/add HL accounts |
| `/api/telegram/webhook` | Telegram bot webhook |

---

## 5. Pages & UI

| Route | Purpose |
|-------|---------|
| `/` | Dashboard: agents, TVL, PnL, $HCLAW tier, HL wallets |
| `/agents` | Agent list |
| `/agents/new` | Create agent form |
| `/agents/[id]` | Agent detail: overview, trades, deposit, vault chat |
| `/monitor` | Real-time: positions, orders, book, prices, runner panel |
| `/strategy` | Strategy backtester |
| `/~offline` | PWA offline fallback |

---

## 6. Data Model

### Agent

```ts
Agent {
  id, name, description, status ("active"|"paused"|"stopped")
  markets: string[], maxLeverage, riskLevel, stopLossPercent
  autonomy: { mode, aggressiveness, minConfidence, maxTradesPerDay, approvalTimeoutMs }
  telegram?: { chatId, notifyOnTrade, notifyOnPnl, ... }
  vaultSocial?: { isOpenVault, telegramGroupId, ... }
  hlAddress, hlVaultAddress?
  totalPnl, totalPnlPercent, totalTrades, winRate
  vaultTvlUsd, depositorCount
  pendingApproval?: PendingTradeApproval
}
```

### TradeDecision (from AI)

```ts
{ action: "long"|"short"|"close"|"hold", asset, size, leverage, confidence, reasoning, stopLoss?, takeProfit? }
```

### Storage Files

| File | Contents |
|------|----------|
| `.data/agents.json` | Agent records |
| `.data/accounts.json` | HL accounts (encrypted keys) |
| `.data/trades.json` | Trade logs |

Backend: file (dev) or S3 (prod when `AWS_S3_BUCKET` set).

---

## 7. Smart Contract

**`contracts/HyperclawVault.sol`**

- Multi-token vault on Monad
- Deposit caps scale with $HCLAW market cap (nad.fun lens)
- Share-based accounting
- Functions: `depositMON`, `depositERC20`, `withdraw`, `getUserSharePercent`, `getVaultTvl`

---

## 8. Key Dependencies

| Package | Role |
|---------|------|
| Next.js 14 | App framework |
| Privy + Wagmi | Auth, embedded wallets |
| @nktkas/hyperliquid | HL SDK |
| OpenAI | LLM (gpt-4o) |
| viem | Blockchain, contract calls |
| TanStack Query | Client state |
| Serwist | PWA / service worker |
| @aws-sdk/client-s3 | Prod storage |

---

## 9. Environment Variables

| Var | Purpose |
|-----|---------|
| `OPENAI_API_KEY` | LLM |
| `HYPERLIQUID_PRIVATE_KEY` | Operator HL wallet (funding agents) |
| `ACCOUNT_ENCRYPTION_KEY` | Encrypt agent keys |
| `TELEGRAM_BOT_TOKEN` | Telegram bot |
| `ORCHESTRATOR_SECRET` | Tick API auth (EC2) |
| `AWS_S3_BUCKET` | Prod storage |
| `NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS` | $HCLAW for tier lookup |

---

## 10. Data Flow Diagram (Simplified)

```
[Monad Wallet] --deposit--> [HyperclawVault]
                                  |
                                  v
[deposit-relay] <--poll/confirm-- [processDepositTx]
       |
       v
[provisionAgentWallet] --> [sendUsdToAgent] --> [Agent HL Wallet]
       |
       v
[agent-runner] <--tick--> [executeTick]
       |                        |
       v                        v
[getEnrichedMarketData]   [getTradeDecision (AI)]
       |                        |
       v                        v
[getAccountState]         [executeOrder] or [setPendingApproval]
       |                        |
       v                        v
[Telegram] <--approve--> [executeApprovedTrade]
```

---

## 11. Quick Reference: Where Is X?

| Need | Location |
|------|----------|
| AI trade logic | `lib/ai.ts` |
| Agent tick loop | `lib/agent-runner.ts` |
| HL orders | `lib/hyperliquid.ts` |
| Agent persistence | `lib/store.ts` |
| Encrypted keys | `lib/account-manager.ts` |
| Deposit processing | `lib/deposit-relay.ts` |
| SSE streams | `lib/watchers.ts` + `app/api/stream/*` |
| Telegram | `lib/telegram.ts` |
| $HCLAW tiers | `lib/hclaw.ts` |
| Create agent API | `app/api/agents/route.ts` |
| Tick/approve API | `app/api/agents/[id]/tick`, `approve/route.ts` |
| Dashboard | `app/page.tsx` |
| Monitor UI | `app/monitor/page.tsx` |

---

**Last indexed:** Feb 2026
