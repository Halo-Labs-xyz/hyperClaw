import OpenAI from "openai";
import { type TradeDecision, type MarketData, type IndicatorConfig } from "./types";
import { evaluateIndicator, formatIndicatorForAI } from "./indicators";

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

// ============================================
// System Prompt
// ============================================

const SYSTEM_PROMPT = `You are an elite quantitative trading AI agent operating on Hyperliquid perpetual futures.

ROLE: Analyze market data and produce a single trading decision in strict JSON format.

RISK MANAGEMENT RULES:
- Never exceed the max leverage provided
- Always set stop losses based on the risk level
- Conservative: 2-5% stop loss, low leverage (1-3x), high-confidence entries only
- Moderate: 3-8% stop loss, medium leverage (3-10x), balanced approach
- Aggressive: 5-15% stop loss, higher leverage (5-20x), momentum-driven

IMPORTANT: In testnet/low-volatility conditions where 24h_change is 0% or very small, still look for opportunities:
- Use funding rate direction as a signal (positive funding = consider shorts, negative = consider longs)
- Open interest changes can indicate accumulation
- Even with stable prices, you can take positions when other signals align

ANALYSIS FRAMEWORK:
1. Price trend (current price vs recent levels)
2. Funding rate (positive = longs paying shorts, negative = shorts paying longs)
3. Open interest changes
4. Volume analysis
5. Cross-asset correlation

INDICATOR-BASED TRADING:
When a key indicator is provided, it becomes a primary signal source:
- STRICT MODE + STRONG SIGNAL (>60% confidence): Follow the indicator signal unless there is overwhelming evidence against it
- STRICT MODE + WEAK/NEUTRAL SIGNAL (<60% confidence): You MAY look at other signals (funding, OI, strategy) to make a decision
- ADVISORY MODE: Use the indicator as one of many inputs, weighing it by its configured weight
- You may REASON AGAINST the indicator if market conditions clearly contradict it
- NEUTRAL indicator signals are NOT actionable on their own - look for other opportunities
- Always explain your reasoning when agreeing or disagreeing with indicator signals

STRATEGY EXECUTION:
When a custom strategy is provided, it is your PRIMARY trading directive:
- Parse the strategy for timeframes, entry/exit rules, and market patterns
- Adapt your risk management and position sizing to match the strategy
- If the strategy mentions specific behaviors (e.g., "secure profit in 1 hour", "break every hour"), incorporate this into your reasoning
- The strategy overrides general guidance - follow it as the agent's personality

OUTPUT FORMAT (strict JSON, no markdown):
{
  "action": "long" | "short" | "close" | "hold",
  "asset": "<coin symbol>",
  "size": <0.0 to 1.0, fraction of available capital>,
  "leverage": <integer>,
  "confidence": <0.0 to 1.0>,
  "reasoning": "<1-2 sentence explanation including indicator analysis if applicable>",
  "stopLoss": <price or null>,
  "takeProfit": <price or null>
}

If no high-confidence opportunity exists, output action "hold" with reasoning.`;

// ============================================
// Trading Decision
// ============================================

export async function getTradeDecision(params: {
  markets: MarketData[];
  currentPositions: Array<{
    coin: string;
    size: number;
    entryPrice: number;
    unrealizedPnl: number;
    leverage: number;
  }>;
  availableBalance: number;
  riskLevel: "conservative" | "moderate" | "aggressive";
  maxLeverage: number;
  allowedMarkets: string[];
  aggressiveness?: number; // 0-100, higher = more willing to take trades
  indicator?: IndicatorConfig; // Key indicator for decision making
  historicalPrices?: Record<string, number[]>; // coin -> price history
  // Agent identity and strategy
  agentName?: string;
  agentStrategy?: string; // The agent's custom strategy description
}): Promise<TradeDecision> {
  const openai = getOpenAI();

  // Evaluate indicator if configured
  let indicatorSection = "";
  if (params.indicator?.enabled) {
    const primaryMarket = params.allowedMarkets[0];
    const marketData = params.markets.find(m => m.coin === primaryMarket);
    
    if (marketData) {
      const historicalData = params.historicalPrices?.[primaryMarket] 
        ? { prices: params.historicalPrices[primaryMarket] }
        : undefined;
      
      const evaluation = evaluateIndicator(params.indicator, marketData, historicalData);
      indicatorSection = `

${formatIndicatorForAI(params.indicator, evaluation)}

IMPORTANT: The above indicator is configured as a KEY signal source. ${
  params.indicator.strictMode 
    ? "You MUST follow this signal unless you have extremely strong counter-evidence. Explain your reasoning if you disagree."
    : `Weight this signal at ${params.indicator.weight}% in your decision. You may reason against it if other factors strongly contradict.`
}
`;
    }
  }

  // Build strategy section if agent has custom strategy
  let strategySection = "";
  if (params.agentStrategy && params.agentStrategy.trim()) {
    strategySection = `
=== YOUR TRADING STRATEGY ===
${params.agentName ? `Agent: ${params.agentName}` : ""}
Strategy: ${params.agentStrategy}

IMPORTANT: You MUST follow this strategy as your primary trading approach. This defines how you should trade.
Parse the strategy for:
- Timeframes mentioned (e.g., "3 minute chart", "1 hour")
- Entry/exit rules
- Risk parameters
- Market behavior patterns to watch for
`;
  }

  const userPrompt = `CURRENT MARKET DATA:
${params.markets
  .filter((m) => params.allowedMarkets.includes(m.coin))
  .map(
    (m) =>
      `${m.coin}: price=$${m.price}, 24h_change=${m.change24h}%, funding=${m.fundingRate}%, OI=$${m.openInterest}`
  )
  .join("\n")}

CURRENT POSITIONS:
${
  params.currentPositions.length === 0
    ? "None"
    : params.currentPositions
        .map(
          (p) =>
            `${p.coin}: size=${p.size}, entry=$${p.entryPrice}, uPnL=$${p.unrealizedPnl}, leverage=${p.leverage}x`
        )
        .join("\n")
}

ACCOUNT:
- Available balance: $${params.availableBalance.toFixed(2)}
- Risk level: ${params.riskLevel}
- Max leverage: ${params.maxLeverage}x (IMPORTANT: leverage must be an integer between 1 and ${params.maxLeverage})
- Allowed markets: ${params.allowedMarkets.join(", ")}
- Aggressiveness: ${params.aggressiveness ?? 50}% (higher = more willing to take trades even with weaker signals)
${strategySection}
${(params.aggressiveness ?? 50) >= 80 ? 'NOTE: High aggressiveness - be willing to take trades with moderate signals. Do not require strong momentum.' : ''}
${indicatorSection}
Provide your trading decision as JSON:`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 500,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("No response from AI");

  let decision: TradeDecision;
  try {
    decision = JSON.parse(content) as TradeDecision;
  } catch {
    console.error("[AI] Failed to parse response:", content);
    // Return safe hold decision on parse failure
    return {
      action: "hold",
      asset: params.allowedMarkets[0] || "BTC",
      size: 0,
      leverage: 1,
      confidence: 0,
      reasoning: "AI response parsing failed; holding position.",
    };
  }

  // Validate required fields
  if (!decision.action || !decision.asset) {
    return {
      action: "hold",
      asset: params.allowedMarkets[0] || "BTC",
      size: 0,
      leverage: 1,
      confidence: 0,
      reasoning: "AI returned incomplete decision; holding position.",
    };
  }

  // Safety clamps
  decision.leverage = Math.min(
    Math.max(1, Math.round(decision.leverage || 1)),
    params.maxLeverage
  );
  decision.size = Math.max(0, Math.min(1, decision.size || 0));
  decision.confidence = Math.max(0, Math.min(1, decision.confidence || 0));

  return decision;
}
