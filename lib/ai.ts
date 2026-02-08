import OpenAI from "openai";
import { type TradeDecision, type MarketData } from "./types";

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

ANALYSIS FRAMEWORK:
1. Price trend (current price vs recent levels)
2. Funding rate (positive = longs paying shorts, negative = shorts paying longs)
3. Open interest changes
4. Volume analysis
5. Cross-asset correlation

OUTPUT FORMAT (strict JSON, no markdown):
{
  "action": "long" | "short" | "close" | "hold",
  "asset": "<coin symbol>",
  "size": <0.0 to 1.0, fraction of available capital>,
  "leverage": <integer>,
  "confidence": <0.0 to 1.0>,
  "reasoning": "<1-2 sentence explanation>",
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
}): Promise<TradeDecision> {
  const openai = getOpenAI();

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
- Max leverage: ${params.maxLeverage}x
- Allowed markets: ${params.allowedMarkets.join(", ")}

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

  const decision = JSON.parse(content) as TradeDecision;

  // Safety clamps
  decision.leverage = Math.min(decision.leverage, params.maxLeverage);
  decision.size = Math.max(0, Math.min(1, decision.size));
  decision.confidence = Math.max(0, Math.min(1, decision.confidence));

  return decision;
}
