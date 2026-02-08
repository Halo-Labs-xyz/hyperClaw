/**
 * Indicator signal evaluation for agent trading decisions.
 * 
 * This module provides utilities for evaluating technical indicator signals
 * that agents can use as key decision inputs. The AI can then reason about
 * these signals and decide whether to follow or counter-trade them.
 */

import type { IndicatorConfig, IndicatorSignal, MarketData } from "./types";

/**
 * Evaluated indicator result with signal and reasoning
 */
export interface IndicatorEvaluation {
  signal: IndicatorSignal;
  confidence: number; // 0-1
  reasoning: string;
  rawValues?: Record<string, number>;
}

/**
 * Simple RSI calculation (Wilder's smoothing method)
 */
export function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 50; // neutral if not enough data
  
  let gains = 0;
  let losses = 0;
  
  // Calculate initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  // Apply Wilder's smoothing for remaining periods
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Calculate ATR (Average True Range)
 */
export function calculateATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): number {
  if (highs.length < period + 1) return 0;
  
  const trueRanges: number[] = [];
  
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }
  
  // Simple average of last 'period' true ranges
  const recentTRs = trueRanges.slice(-period);
  return recentTRs.reduce((a, b) => a + b, 0) / recentTRs.length;
}

/**
 * Detect RSI divergence
 */
export function detectRSIDivergence(
  prices: number[],
  rsiValues: number[],
  lookback: number = 20
): { bullish: boolean; bearish: boolean } {
  if (prices.length < lookback || rsiValues.length < lookback) {
    return { bullish: false, bearish: false };
  }
  
  const recentPrices = prices.slice(-lookback);
  const recentRSI = rsiValues.slice(-lookback);
  
  // Find local lows for bullish divergence
  const priceMinIdx = recentPrices.indexOf(Math.min(...recentPrices));
  const currentPrice = recentPrices[recentPrices.length - 1];
  const currentRSI = recentRSI[recentRSI.length - 1];
  
  // Bullish: price makes lower low, RSI makes higher low
  const bullish = currentPrice < recentPrices[priceMinIdx] * 1.02 && 
                  currentRSI > recentRSI[priceMinIdx];
  
  // Find local highs for bearish divergence
  const priceMaxIdx = recentPrices.indexOf(Math.max(...recentPrices));
  
  // Bearish: price makes higher high, RSI makes lower high
  const bearish = currentPrice > recentPrices[priceMaxIdx] * 0.98 && 
                  currentRSI < recentRSI[priceMaxIdx];
  
  return { bullish, bearish };
}

/**
 * Evaluate Adaptive RSI indicator signal
 */
export function evaluateAdaptiveRSI(
  marketData: MarketData,
  config: IndicatorConfig,
  historicalPrices?: number[]
): IndicatorEvaluation {
  const params = config.parameters || {};
  const rsiLength = (params.rsiLength as number) || 14;
  const buyTrigger = (params.buyTrigger as number) || 20;
  const sellTrigger = (params.sellTrigger as number) || 80;
  const enableDivergence = params.enableDivergence !== false;
  
  // If we have historical prices, calculate RSI
  let rsi = 50; // default neutral
  let divergence = { bullish: false, bearish: false };
  
  if (historicalPrices && historicalPrices.length > rsiLength) {
    rsi = calculateRSI(historicalPrices, rsiLength);
    
    if (enableDivergence) {
      // Calculate RSI for each point to detect divergence
      const rsiValues: number[] = [];
      for (let i = rsiLength; i <= historicalPrices.length; i++) {
        rsiValues.push(calculateRSI(historicalPrices.slice(0, i), rsiLength));
      }
      divergence = detectRSIDivergence(historicalPrices, rsiValues);
    }
  }
  
  // Determine signal
  let signal: IndicatorSignal = "neutral";
  let confidence = 0.5;
  let reasoning = "";
  
  if (rsi <= buyTrigger || divergence.bullish) {
    signal = "bullish";
    confidence = divergence.bullish ? 0.85 : 0.7 + (buyTrigger - rsi) / 100;
    reasoning = divergence.bullish
      ? `Bullish divergence detected: price making lower lows while RSI (${rsi.toFixed(1)}) making higher lows - potential reversal`
      : `RSI at ${rsi.toFixed(1)} is below oversold threshold (${buyTrigger}) - potential bounce`;
  } else if (rsi >= sellTrigger || divergence.bearish) {
    signal = "bearish";
    confidence = divergence.bearish ? 0.85 : 0.7 + (rsi - sellTrigger) / 100;
    reasoning = divergence.bearish
      ? `Bearish divergence detected: price making higher highs while RSI (${rsi.toFixed(1)}) making lower highs - potential reversal`
      : `RSI at ${rsi.toFixed(1)} is above overbought threshold (${sellTrigger}) - potential pullback`;
  } else {
    signal = "neutral";
    confidence = 0.5;
    reasoning = `RSI at ${rsi.toFixed(1)} is in neutral zone (${buyTrigger}-${sellTrigger}) - no clear directional signal`;
  }
  
  return {
    signal,
    confidence: Math.min(confidence, 1),
    reasoning,
    rawValues: { rsi, buyTrigger, sellTrigger },
  };
}

/**
 * Evaluate Smart Money Concepts indicator signal
 */
export function evaluateSMC(
  marketData: MarketData,
  config: IndicatorConfig,
  historicalPrices?: number[],
  historicalHighs?: number[],
  historicalLows?: number[]
): IndicatorEvaluation {
  const params = config.parameters || {};
  
  // Simple structure analysis based on available data
  let signal: IndicatorSignal = "neutral";
  let confidence = 0.5;
  let reasoning = "";
  
  if (!historicalPrices || historicalPrices.length < 20) {
    return {
      signal: "neutral",
      confidence: 0.5,
      reasoning: "Insufficient historical data for Smart Money Concepts analysis",
    };
  }
  
  const prices = historicalPrices;
  const highs = historicalHighs || prices;
  const lows = historicalLows || prices;
  const len = prices.length;
  
  // Find swing highs and lows (simplified)
  const lookback = Math.min(10, Math.floor(len / 3));
  const recentHigh = Math.max(...highs.slice(-lookback));
  const recentLow = Math.min(...lows.slice(-lookback));
  const prevHigh = Math.max(...highs.slice(-lookback * 2, -lookback));
  const prevLow = Math.min(...lows.slice(-lookback * 2, -lookback));
  
  const currentPrice = prices[len - 1];
  const range = recentHigh - recentLow;
  
  // Premium/Discount zone calculation
  const equilibrium = (recentHigh + recentLow) / 2;
  const premiumZone = equilibrium + range * 0.25;
  const discountZone = equilibrium - range * 0.25;
  
  // Break of Structure detection
  const bullishBOS = currentPrice > prevHigh && prices[len - 2] <= prevHigh;
  const bearishBOS = currentPrice < prevLow && prices[len - 2] >= prevLow;
  
  // Change of Character (simplified - trend reversal)
  const wasDowntrend = prevLow < lows.slice(-lookback * 3, -lookback * 2).reduce((a, b) => Math.min(a, b), Infinity);
  const wasUptrend = prevHigh > highs.slice(-lookback * 3, -lookback * 2).reduce((a, b) => Math.max(a, b), 0);
  
  const bullishCHoCH = wasDowntrend && bullishBOS;
  const bearishCHoCH = wasUptrend && bearishBOS;
  
  // Generate signal
  if (bullishCHoCH) {
    signal = "bullish";
    confidence = 0.85;
    reasoning = "Bullish Change of Character (CHoCH) - trend reversal from downtrend to uptrend confirmed";
  } else if (bearishCHoCH) {
    signal = "bearish";
    confidence = 0.85;
    reasoning = "Bearish Change of Character (CHoCH) - trend reversal from uptrend to downtrend confirmed";
  } else if (bullishBOS) {
    signal = "bullish";
    confidence = 0.75;
    reasoning = "Bullish Break of Structure (BOS) - price broke above recent swing high, continuation expected";
  } else if (bearishBOS) {
    signal = "bearish";
    confidence = 0.75;
    reasoning = "Bearish Break of Structure (BOS) - price broke below recent swing low, continuation expected";
  } else if (currentPrice < discountZone) {
    signal = "bullish";
    confidence = 0.65;
    reasoning = `Price in discount zone (below ${discountZone.toFixed(2)}) - potential buy opportunity`;
  } else if (currentPrice > premiumZone) {
    signal = "bearish";
    confidence = 0.65;
    reasoning = `Price in premium zone (above ${premiumZone.toFixed(2)}) - potential sell opportunity`;
  } else {
    signal = "neutral";
    confidence = 0.5;
    reasoning = `Price at ${currentPrice.toFixed(2)} is in equilibrium zone - no clear SMC signal`;
  }
  
  return {
    signal,
    confidence,
    reasoning,
    rawValues: {
      currentPrice,
      equilibrium,
      premiumZone,
      discountZone,
      recentHigh,
      recentLow,
    },
  };
}

/**
 * Main function to evaluate any configured indicator
 */
export function evaluateIndicator(
  indicator: IndicatorConfig,
  marketData: MarketData,
  historicalData?: {
    prices: number[];
    highs?: number[];
    lows?: number[];
  }
): IndicatorEvaluation {
  if (!indicator.enabled) {
    return {
      signal: "neutral",
      confidence: 0,
      reasoning: "Indicator is disabled",
    };
  }
  
  const prices = historicalData?.prices || [];
  const highs = historicalData?.highs;
  const lows = historicalData?.lows;
  
  switch (indicator.name) {
    case "Adaptive RSI with Divergence":
      return evaluateAdaptiveRSI(marketData, indicator, prices);
    
    case "Smart Money Concepts":
      return evaluateSMC(marketData, indicator, prices, highs, lows);
    
    case "Custom Indicator":
      // For custom indicators, we can't compute - just pass the config to AI
      return {
        signal: "neutral",
        confidence: 0.5,
        reasoning: `Custom indicator configured: ${indicator.description}. Bullish when: ${indicator.signals.bullishCondition}. Bearish when: ${indicator.signals.bearishCondition}`,
      };
    
    default:
      return {
        signal: "neutral",
        confidence: 0.5,
        reasoning: `Unknown indicator: ${indicator.name}`,
      };
  }
}

/**
 * Format indicator evaluation for AI prompt
 */
export function formatIndicatorForAI(
  indicator: IndicatorConfig,
  evaluation: IndicatorEvaluation
): string {
  const lines = [
    `=== INDICATOR SIGNAL: ${indicator.name} ===`,
    `Description: ${indicator.description}`,
    `Current Signal: ${evaluation.signal.toUpperCase()} (${(evaluation.confidence * 100).toFixed(0)}% confidence)`,
    `Analysis: ${evaluation.reasoning}`,
    ``,
    `Signal Conditions:`,
    `  - Bullish: ${indicator.signals.bullishCondition}`,
    `  - Bearish: ${indicator.signals.bearishCondition}`,
    ``,
    `Weight: ${indicator.weight}% influence on decision`,
    `Mode: ${indicator.strictMode ? "STRICT - strongly follow this signal unless clear counter-evidence" : "ADVISORY - use as one of many inputs"}`,
  ];
  
  if (evaluation.rawValues) {
    lines.push(``, `Raw Values: ${JSON.stringify(evaluation.rawValues)}`);
  }
  
  return lines.join("\n");
}
