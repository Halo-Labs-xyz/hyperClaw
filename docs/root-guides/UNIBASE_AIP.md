# Unibase AIP Integration Guide

Complete guide to deploying HyperClaw trading agents on the Unibase AIP platform.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Deployment Modes](#deployment-modes)
- [Setup](#setup)
- [Deployment](#deployment)
- [Agent Invocation](#agent-invocation)
- [Advanced Configuration](#advanced-configuration)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

---

## Overview

The Unibase AIP (Agent Interaction Protocol) integration enables HyperClaw trading agents to:

- **Be discovered** on the AIP platform registry (ERC-8004 on-chain)
- **Earn micropayments** via X402 protocol for each agent invocation
- **Store context** in Membase for conversation continuity
- **Communicate** with other agents via A2A protocol
- **Scale globally** via Gateway routing

### Key Benefits

✅ **Monetization**: Earn per-invocation fees in micropayments
✅ **Discoverability**: Listed in AIP agent marketplace
✅ **Interoperability**: Standard protocol for agent communication
✅ **Security**: Built-in payment verification and rate limiting
✅ **Flexibility**: Public or private deployment modes

---

## Architecture

### System Components

1. **HyperClaw Agent** - Your trading agent with AI brain
2. **AIP Platform** - On-chain registry and orchestration
3. **Gateway** - Routes invocations and handles payments (X402)
4. **Membase** - Stores conversation context and memory
5. **Client** - End user invoking the agent

### Data Flow

```
Client → AIP Platform → Gateway → HyperClaw Agent
                                       ↓
                                   AI Brain → Hyperliquid
                                       ↓
Gateway ← Response ← HyperClaw Agent
   ↓
Membase (store context)
   ↓
Client (deliver result)
```

---

## Deployment Modes

### DIRECT Mode (Public Agent)

**When to use:**
- Production deployments with stable infrastructure
- Low latency requirements
- Cloud services (Vercel, AWS, GCP, Azure)
- Publicly accessible agents

**Requirements:**
- Public IP or domain name
- Accessible HTTP endpoint from internet
- SSL/TLS certificate recommended

**Pros:**
- ✅ Lower latency (direct HTTP calls)
- ✅ Real-time responses
- ✅ Better for high-volume invocations

**Cons:**
- ❌ Requires public endpoint
- ❌ Must handle inbound traffic
- ❌ Firewall configuration needed

---

### POLLING Mode (Private Agent)

**When to use:**
- Development and testing
- Behind corporate firewall
- No public IP available (NAT, private network)
- Enhanced security requirements

**Requirements:**
- None! No public endpoint needed
- Agent polls Gateway for tasks

**Pros:**
- ✅ No public endpoint required
- ✅ Works behind firewall/NAT
- ✅ Enhanced security (no inbound connections)
- ✅ Perfect for local development

**Cons:**
- ❌ Slightly higher latency (polling delay)
- ❌ Polling overhead

---

## Setup

### 1. Environment Variables

Add to `.env.local`:

```bash
# ============================================
# Unibase AIP Platform
# ============================================

# AIP Platform endpoint (mainnet or testnet)
AIP_ENDPOINT=http://api.aip.unibase.com

# Gateway endpoint (routes agent invocations)
GATEWAY_URL=http://gateway.aip.unibase.com

# Your agent's publicly accessible URL (required for DIRECT mode only)
AGENT_PUBLIC_URL=https://hyperclaw.com/api/unibase

# Membase account (wallet address for X402 payments and memory)
# Test account for development: 0x5ea13664c5ce67753f208540d25b913788aa3daa
MEMBASE_ACCOUNT=your_wallet_address_for_aip_payments

# Deployment mode: "DIRECT" (public endpoint) or "POLLING" (private/firewall)
AIP_DEPLOYMENT_MODE=POLLING
```

### 2. Create a HyperClaw Agent

#### Via UI (Recommended)

1. Navigate to `/agents/new`
2. Configure agent:
   - **Name**: "BTC Guardian"
   - **Markets**: BTC
   - **Risk Level**: Conservative
   - **Max Leverage**: 3x
   - **Autonomy Mode**: Semi-auto
   - **Aggressiveness**: 30
3. Click "Create Agent"
4. Note the agent ID (e.g., `agent_abc123`)

#### Via API

```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "BTC Guardian",
    "description": "Conservative BTC trading agent",
    "markets": ["BTC"],
    "maxLeverage": 3,
    "riskLevel": "conservative",
    "stopLossPercent": 3,
    "autonomy": {
      "mode": "semi",
      "aggressiveness": 30,
      "maxTradesPerDay": 5,
      "approvalTimeoutMs": 300000
    }
  }'
```

### 3. Fund the Agent

Fund agent's Hyperliquid wallet:

```bash
curl -X POST http://localhost:3000/api/fund \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "agent_abc123",
    "action": "deposit",
    "amount": 1000
  }'
```

Or via UI at `/agents/[id]` → Deposit tab.

### 4. Activate Agent

Set agent status to "active":

```bash
curl -X PATCH http://localhost:3000/api/agents/agent_abc123 \
  -H "Content-Type: application/json" \
  -d '{ "status": "active" }'
```

Or via UI agent detail page.

---

## Deployment

### Deploy Public Agent (DIRECT Mode)

**Prerequisites:**
- Public endpoint accessible from internet
- SSL certificate configured (recommended)
- Firewall allows inbound HTTPS traffic

**Deploy:**

```bash
# Single agent
npm run deploy:aip:public -- \
  --agent-id agent_abc123 \
  --endpoint https://hyperclaw.com/api/unibase

# All active agents
npm run deploy:aip:public -- \
  --all \
  --endpoint https://hyperclaw.com/api/unibase
```

**Output:**

```
🚀 HyperClaw → Unibase AIP Deployment (PUBLIC Mode)

Environment Configuration:
  AIP Endpoint:    http://api.aip.unibase.com
  Gateway URL:     http://gateway.aip.unibase.com
  Public Endpoint: https://hyperclaw.com/api/unibase
  Wallet:          0x5ea13664c5ce67753f208540d25b913788aa3daa

Step 1: Checking AIP Platform Health...
✅ AIP platform is healthy

Step 2: Registering Agents...
✅ Successfully registered agent:

   Name:         BTC Guardian
   AIP Agent ID: aip_agent_xyz789
   Handle:       @hyperclaw_abc12345
   Endpoint:     https://hyperclaw.com/api/unibase/invoke/agent_abc123
   Cost:         $0.01 per call
   Skills:       Market Analysis, Trading Decision, Portfolio Status

✅ Deployment complete!

Next steps:
  1. Start your agent service: npm run dev
  2. Ensure your public endpoint is accessible
  3. Test agent invocation via AIP Gateway
  4. Monitor agent logs for incoming requests
```

---

### Deploy Private Agent (POLLING Mode)

**Prerequisites:**
- None! No public endpoint needed

**Deploy:**

```bash
# Single agent
npm run deploy:aip:private -- --agent-id agent_abc123

# All active agents with custom polling interval
npm run deploy:aip:private -- --all --poll-interval 3

# With help
npm run deploy:aip:private -- --help
```

**Output:**

```
🚀 HyperClaw → Unibase AIP Deployment (PRIVATE Mode)

Environment Configuration:
  AIP Endpoint:    http://api.aip.unibase.com
  Gateway URL:     http://gateway.aip.unibase.com
  Mode:            POLLING (no public endpoint required)
  Wallet:          0x5ea13664c5ce67753f208540d25b913788aa3daa
  Poll Interval:   5s

Step 1: Checking AIP Platform Health...
✅ AIP platform is healthy

Step 2: Registering Agents (POLLING mode)...
✅ Successfully registered agent:

   Name:         BTC Guardian
   AIP Agent ID: aip_agent_xyz789
   Handle:       @hyperclaw_abc12345
   Mode:         POLLING (gateway polling)
   Cost:         $0.01 per call
   Skills:       Market Analysis, Trading Decision, Portfolio Status

✅ Registration complete!

Benefits of POLLING mode:
  ✅ No public endpoint required
  ✅ Works behind firewall/NAT
  ✅ Enhanced security (no inbound connections)
  ✅ Perfect for local/private networks

🔄 Starting polling loop (5s interval)...

[2026-02-08T15:30:00.000Z] Agent aip_agent_xyz789: No tasks (heartbeat)
[2026-02-08T15:30:05.000Z] Agent aip_agent_xyz789: No tasks (heartbeat)
[2026-02-08T15:30:10.000Z] Agent aip_agent_xyz789: Processing 1 task(s)
  ✅ Task task_001 completed
```

The script will run continuously, polling for tasks every N seconds.

---

## Agent Invocation

### Via AIP Gateway (Production)

End users invoke your agent via the Gateway:

```bash
curl -X POST https://gateway.aip.unibase.com/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "agent_handle": "hyperclaw_abc12345",
    "message": "What is your BTC analysis?",
    "user_id": "user:0x1234567890abcdef",
    "payment": {
      "amount": 0.01,
      "currency": "USDC",
      "proof": "0x..."
    }
  }'
```

**Response:**

```json
{
  "success": true,
  "agent_id": "aip_agent_xyz789",
  "response": "📈 **Market Analysis for BTC**\n\n**BTC**\n• Price: $42,350.25 (+2.35%)\n• Trend: 🟢 Uptrend\n• Funding: 0.0085% ✅ Balanced\n• 24h Volume: $12,450.50M\n• Open Interest: $8,230.10M\n\n",
  "metadata": {
    "type": "market_analysis",
    "markets": [...]
  },
  "memory_update": { ... },
  "timestamp": 1707409800000
}
```

### Via Direct API (Testing)

For testing, you can invoke agents directly:

```bash
# Register agent first
curl -X POST http://localhost:3000/api/unibase/register \
  -H "Content-Type: application/json" \
  -d '{
    "hyperClawAgentId": "agent_abc123",
    "mode": "DIRECT",
    "publicEndpoint": "http://localhost:3000/api/unibase/invoke/agent_abc123"
  }'

# Invoke agent
curl -X POST http://localhost:3000/api/unibase/invoke/aip_agent_xyz789 \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Give me a trade recommendation",
    "user_id": "user:test",
    "payment_verified": true
  }'
```

---

## Advanced Configuration

### Custom Agent Configuration

See [`lib/unibase-agent-configs.ts`](./lib/unibase-agent-configs.ts) for examples:

```typescript
export const conservativeBTCAgent: HyperClawAgentConfig = {
  name: "BTC Guardian",
  description: "Conservative BTC trading agent with risk-first approach",
  markets: ["BTC"],
  maxLeverage: 3,
  riskLevel: "conservative",
  stopLossPercent: 3,
  autonomy: {
    mode: "semi",
    aggressiveness: 30,
    maxTradesPerDay: 3,
    approvalTimeoutMs: 300000,
  },
};
```

### Pricing Strategy

Pricing is calculated as:

```
base_call_fee = base_fee × autonomy_multiplier × risk_multiplier

Where:
  base_fee = $0.005 (semi-auto) or $0.01 (full-auto)
  autonomy_multiplier = 1.0 (semi) or 2.0 (full)
  risk_multiplier = 1.0 (conservative) | 1.2 (moderate) | 1.5 (aggressive)
```

**Examples:**
- Conservative + Semi = $0.005 × 1.0 × 1.0 = **$0.005/call**
- Moderate + Full = $0.01 × 1.0 × 1.2 = **$0.012/call**
- Aggressive + Full = $0.01 × 1.0 × 1.5 = **$0.015/call**

### Skills Configuration

Agents expose three core skills:

```typescript
skills: [
  {
    id: "trading.analysis",
    name: "Market Analysis",
    description: "Analyze BTC, ETH, SOL markets",
    tags: ["trading", "market-analysis", "btc", "eth", "sol"],
    examples: [
      "What's your analysis on BTC?",
      "Tell me about ETH market conditions",
    ],
  },
  {
    id: "trading.decision",
    name: "Trading Decision",
    description: "Generate trade decisions with AI",
    tags: ["trading", "decision", "signals"],
    examples: [
      "Give me a trade recommendation",
      "Should I long or short BTC?",
    ],
  },
  {
    id: "portfolio.status",
    name: "Portfolio Status",
    description: "Report positions and PnL",
    tags: ["portfolio", "performance", "pnl"],
    examples: [
      "What's my current position?",
      "Show me the portfolio performance",
    ],
  },
]
```

---

## Monitoring

### Check Registered Agents

```bash
curl http://localhost:3000/api/unibase/agents
```

**Response:**

```json
{
  "success": true,
  "count": 3,
  "agents": [
    {
      "aipAgentId": "aip_agent_xyz789",
      "hyperClawAgentId": "agent_abc123",
      "name": "BTC Guardian",
      "handle": "hyperclaw_abc12345",
      "description": "Conservative BTC trading agent",
      "mode": "DIRECT",
      "skills": ["Market Analysis", "Trading Decision", "Portfolio Status"],
      "cost_model": { "base_call_fee": 0.01, "per_token_fee": 0.00001 },
      "endpoint_url": "https://hyperclaw.com/api/unibase/invoke/agent_abc123",
      "registered_at": 1707409800000,
      "metadata": { ... }
    },
    ...
  ]
}
```

### Health Check

```bash
curl http://localhost:3000/api/unibase/health
```

**Response:**

```json
{
  "healthy": true,
  "registered_agents": 3,
  "endpoint": "http://api.aip.unibase.com",
  "timestamp": 1707409800000
}
```

### Monitor Logs

**DIRECT Mode:**
- Watch for incoming POST requests to `/api/unibase/invoke/[agentId]`
- Check response times and error rates

**POLLING Mode:**
- Monitor polling loop output
- Check task processing success rate

---

## Troubleshooting

### Agent Not Receiving Invocations (DIRECT Mode)

**Symptoms:**
- No requests hitting your endpoint
- Gateway returns "agent unavailable"

**Solutions:**
1. **Verify endpoint is accessible:**
   ```bash
   curl https://hyperclaw.com/api/unibase/invoke/agent_abc123
   ```
   Should return 405 (Method Not Allowed) for GET, not timeout/error

2. **Check firewall rules:**
   - Allow inbound HTTPS traffic (port 443)
   - Allow from Gateway IPs

3. **Verify SSL certificate:**
   - Gateway requires valid SSL for production
   - Test with `curl -v https://...`

4. **Check agent status:**
   ```bash
   curl http://localhost:3000/api/agents/agent_abc123
   ```
   Ensure status is "active"

### Agent Not Polling Tasks (POLLING Mode)

**Symptoms:**
- Polling script runs but never processes tasks
- No tasks appearing in logs

**Solutions:**
1. **Verify registration:**
   ```bash
   curl http://localhost:3000/api/unibase/agents
   ```
   Ensure agent is registered in POLLING mode

2. **Check polling interval:**
   - Default 5s may be too slow for testing
   - Use `--poll-interval 2` for faster polls

3. **Test task queue manually:**
   ```bash
   curl -X POST http://localhost:3000/api/unibase/poll \
     -H "Content-Type: application/json" \
     -d '{ "agent_id": "aip_agent_xyz789" }'
   ```

### Payment Verification Failed

**Symptoms:**
- Agent returns "Payment verification failed"
- X402 payment errors

**Solutions:**
1. **Check MEMBASE_ACCOUNT:**
   ```bash
   echo $MEMBASE_ACCOUNT
   ```
   Should be valid wallet address

2. **For testing, bypass verification:**
   - In `lib/unibase-aip.ts`, handler already sets `payment_verified = true` for local testing
   - In production, Gateway handles payment verification

3. **Use test account:**
   ```bash
   export MEMBASE_ACCOUNT=0x5ea13664c5ce67753f208540d25b913788aa3daa
   ```

### Agent Returns Generic Errors

**Symptoms:**
- "Processing failed" or generic error messages
- No trade decisions returned

**Solutions:**
1. **Check agent has HL wallet funded:**
   ```bash
   curl http://localhost:3000/api/agents/agent_abc123
   ```
   Verify `hlAddress` and balance > 0

2. **Verify AI API key:**
   ```bash
   echo $OPENAI_API_KEY
   ```
   Must be valid OpenAI API key

3. **Check agent runner logs:**
   - Look for tick execution errors
   - Verify Hyperliquid API connectivity

4. **Test agent tick manually:**
   ```bash
   curl -X POST http://localhost:3000/api/agents/agent_abc123/tick
   ```

---

## Best Practices

### 1. Security

- **Never commit** `.env` files with real API keys
- **Use HTTPS** for public endpoints (DIRECT mode)
- **Rotate** MEMBASE_ACCOUNT periodically
- **Monitor** for unusual invocation patterns

### 2. Pricing

- **Conservative agents**: Higher fees ($0.01-0.015) justify safety
- **Aggressive agents**: Moderate fees ($0.008-0.012) for volume
- **Open vault/social**: Lower fees ($0.005-0.008) for community

### 3. Deployment

- **Development**: Use POLLING mode for testing
- **Production**: Use DIRECT mode for low latency
- **Staging**: Test with DIRECT mode on staging domain first

### 4. Monitoring

- **Track metrics**: Invocation count, revenue, error rate
- **Set alerts**: For payment failures, high error rates
- **Review logs**: Daily for unusual patterns

### 5. Agent Configuration

- **Start conservative**: Low leverage, high confidence threshold
- **Iterate**: Adjust based on performance and user feedback
- **Document**: Skills and capabilities clearly for users

---

## Resources

- [Unibase AIP Documentation](https://docs.unibase.com/aip)
- [A2A Protocol Spec](https://docs.unibase.com/a2a)
- [X402 Payment Protocol](https://docs.unibase.com/x402)
- [Membase Memory System](https://docs.unibase.com/membase)
- [ERC-8004 Agent Registry](https://docs.unibase.com/erc8004)

---

## Support

For issues or questions:
- **GitHub Issues**: [hyperClaw/issues](https://github.com/your-org/hyperClaw/issues)
- **Discord**: [hyperClaw Community](https://discord.gg/hyperclaw)
- **Email**: support@hyperclaw.com

---

**Happy Agent Building! 🚀**
