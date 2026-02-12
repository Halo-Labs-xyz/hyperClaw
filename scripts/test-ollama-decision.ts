/**
 * Test getTradeDecision directly with Ollama (glm-4.7-flash).
 * Bypasses agent/store - just tests AI model integration.
 * Usage: pnpm exec tsx scripts/test-ollama-decision.ts
 */

import "dotenv/config";
import { getTradeDecision } from "../lib/ai";

async function main() {
  console.log("\n🧪 Testing Ollama (glm-4.7-flash) trade decision\n");
  console.log("OPENAI_API_BASE_URL:", process.env.OPENAI_API_BASE_URL || "(not set)");
  console.log("AI_MODEL_CHAIN:", process.env.AI_MODEL_CHAIN || "(default)");
  console.log("");

  const mockMarkets = [
    {
      coin: "BTC",
      price: 97050,
      change24h: 0.52,
      volume24h: 1_000_000_000,
      fundingRate: 0.01,
      openInterest: 500_000_000,
    },
    {
      coin: "ETH",
      price: 3505,
      change24h: 0.72,
      volume24h: 500_000_000,
      fundingRate: -0.005,
      openInterest: 200_000_000,
    },
  ];

  try {
    const decision = await getTradeDecision({
      markets: mockMarkets,
      currentPositions: [],
      availableBalance: 1000,
      allowedMarkets: ["BTC", "ETH"],
      maxLeverage: 5,
      riskLevel: "moderate",
      aggressiveness: 50,
    });

    console.log("✅ Decision received:");
    console.log(JSON.stringify(decision, null, 2));
  } catch (err) {
    console.error("❌ Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
