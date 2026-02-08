/**
 * Example Unibase AIP Agent Configurations
 * 
 * This file demonstrates how to configure hyperClaw trading agents
 * for deployment on the Unibase AIP platform.
 */

import type { AgentConfig as HyperClawAgentConfig } from "@/lib/types";

// ============================================
// Example 1: Conservative BTC Agent (Public)
// ============================================

export const conservativeBTCAgent: HyperClawAgentConfig = {
  name: "BTC Guardian",
  description: "Conservative BTC trading agent with risk-first approach. Ideal for steady, low-risk exposure to Bitcoin futures.",
  markets: ["BTC"],
  maxLeverage: 3,
  riskLevel: "conservative",
  stopLossPercent: 3,
  autonomy: {
    mode: "semi", // Requires approval for trades
    aggressiveness: 30, // Very selective
    maxTradesPerDay: 3,
    approvalTimeoutMs: 300000, // 5 minutes
  },
};

// Unibase AIP Config:
// - Mode: DIRECT (public endpoint)
// - Pricing: $0.01 per call (conservative premium)
// - Skills: Market analysis, trade decisions, portfolio status
// - Use case: Investors wanting AI-guided BTC exposure with human oversight

// ============================================
// Example 2: Aggressive Multi-Market Agent (Private)
// ============================================

export const aggressiveMultiMarketAgent: HyperClawAgentConfig = {
  name: "Hyper Trader Alpha",
  description: "High-conviction, multi-market trading agent. Trades BTC, ETH, SOL with momentum strategies and higher leverage.",
  markets: ["BTC", "ETH", "SOL"],
  maxLeverage: 15,
  riskLevel: "aggressive",
  stopLossPercent: 8,
  autonomy: {
    mode: "full", // Fully autonomous
    aggressiveness: 80, // Trades frequently on signals
    maxTradesPerDay: 20,
    approvalTimeoutMs: 0,
  },
};

// Unibase AIP Config:
// - Mode: POLLING (private, no public endpoint)
// - Pricing: $0.015 per call (aggressive premium)
// - Skills: Advanced market analysis, multi-asset correlation, portfolio rebalancing
// - Use case: Experienced traders seeking high-frequency AI agent behind firewall

// ============================================
// Example 3: Moderate ETH Agent (Public)
// ============================================

export const moderateETHAgent: HyperClawAgentConfig = {
  name: "ETH Strategist",
  description: "Balanced ETH trading agent. Combines technical analysis with fundamental market conditions for moderate risk/reward.",
  markets: ["ETH"],
  maxLeverage: 8,
  riskLevel: "moderate",
  stopLossPercent: 5,
  autonomy: {
    mode: "full",
    aggressiveness: 60,
    maxTradesPerDay: 10,
    approvalTimeoutMs: 0,
  },
};

// Unibase AIP Config:
// - Mode: DIRECT (public endpoint)
// - Pricing: $0.012 per call (moderate premium)
// - Skills: ETH ecosystem analysis, DeFi correlation, market sentiment
// - Use case: ETH-focused investors wanting automated trading with reasonable risk

// ============================================
// Example 4: Open Vault Social Agent (Public)
// ============================================

export const openVaultSocialAgent: HyperClawAgentConfig = {
  name: "Community Alpha Fund",
  description: "Community-driven trading agent. Open vault with Telegram chat room where investors discuss strategies with AI.",
  markets: ["BTC", "ETH"],
  maxLeverage: 5,
  riskLevel: "moderate",
  stopLossPercent: 4,
  autonomy: {
    mode: "semi", // Community approval via Telegram
    aggressiveness: 50,
    maxTradesPerDay: 8,
    approvalTimeoutMs: 600000, // 10 minutes for community discussion
  },
  isOpenVault: true,
  telegramChatId: "your_telegram_group_id",
};

// Unibase AIP Config:
// - Mode: DIRECT (public endpoint)
// - Pricing: $0.008 per call (discounted for community)
// - Skills: Market analysis, community Q&A, trade proposals, performance reporting
// - Use case: Social trading experiment where AI agent interacts with community
// - Special: Vault chat room integration, agent responds to investor questions

// ============================================
// Deployment Examples
// ============================================

/*
# Deploy conservative BTC agent (public)
npm run deploy:aip:public -- \
  --agent-id <btc-guardian-id> \
  --endpoint https://hyperclaw.com/api/unibase

# Deploy aggressive multi-market agent (private)
npm run deploy:aip:private -- \
  --agent-id <hyper-trader-id> \
  --poll-interval 3

# Deploy all active agents (public)
npm run deploy:aip:public -- \
  --all \
  --endpoint https://hyperclaw.com/api/unibase

# Deploy all active agents (private, behind firewall)
npm run deploy:aip:private -- --all
*/

// ============================================
// Integration with Existing hyperClaw Agents
// ============================================

/*
To convert an existing hyperClaw agent to an AIP agent:

1. Create the agent via UI or API (/api/agents)
2. Fund the agent's HL wallet (/api/fund)
3. Set agent to "active" status
4. Deploy to AIP:
   - Public: npm run deploy:aip:public --agent-id <id> --endpoint <url>
   - Private: npm run deploy:aip:private --agent-id <id>
5. Agent is now accessible via A2A protocol on Unibase AIP platform
6. Users can invoke agent via Gateway, pay with X402 micropayments
7. Conversation context stored in Membase
8. Agent metadata on-chain via ERC-8004

API Invocation Example:
POST https://gateway.aip.unibase.com/invoke
{
  "agent_id": "hyperclaw_abc12345",
  "message": "What's your BTC trade recommendation?",
  "user_id": "user:0x...",
  "payment": { ... } // X402 payment proof
}

Response:
{
  "response": "🤖 **BTC Guardian Trading Decision**\n\n**Action:** LONG\n**Confidence:** 78.5%\n...",
  "metadata": { "decision": { ... } }
}
*/

// ============================================
// Best Practices
// ============================================

/*
1. PRICING STRATEGY
   - Conservative agents: Higher fee ($0.01-0.015) for safety premium
   - Aggressive agents: Moderate fee ($0.008-0.012) for volume
   - Open vault/social: Lower fee ($0.005-0.008) for community access
   - Per-token fee: $0.00001 for detailed responses

2. DEPLOYMENT MODE SELECTION
   - Use DIRECT (public) for:
     * Production agents with stable infrastructure
     * Low-latency requirements
     * Cloud deployments (Vercel, AWS, etc)
   
   - Use POLLING (private) for:
     * Development/testing
     * Behind corporate firewall
     * Enhanced security requirements
     * No public IP available

3. AUTONOMY CONFIGURATION
   - Full auto: High confidence threshold (0.7+), conservative leverage
   - Semi auto: Telegram approval, longer timeout for decisions
   - Manual: AI suggestions only, human executes

4. RISK MANAGEMENT
   - Always set appropriate maxLeverage per risk level
   - Conservative: 1-5x
   - Moderate: 3-10x
   - Aggressive: 5-20x
   
   - Stop losses MUST be set:
     * Conservative: 2-5%
     * Moderate: 3-8%
     * Aggressive: 5-15%

5. SKILL DEFINITIONS
   - Be specific about agent capabilities
   - Include clear examples for user queries
   - Tag appropriately for discoverability
   - Highlight unique features (e.g., "DeFi correlation analysis")

6. MEMORY & CONTEXT
   - Leverage Membase for conversation history
   - Store key decisions and rationale
   - Enable context-aware follow-up queries
   - Preserve user preferences across sessions

7. MONITORING
   - Track invocation count and revenue (X402 payments)
   - Monitor agent performance (PnL, win rate)
   - Review user feedback and common queries
   - Adjust pricing/skills based on demand
*/
