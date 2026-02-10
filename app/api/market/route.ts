import { NextResponse } from "next/server";
import {
  getAllMids,
  getMarketData,
  getEnrichedMarketData,
  getL2Book,
  getAllAssets,
  getFundingHistory,
  getAllMarkets,
} from "@/lib/hyperliquid";

/**
 * GET /api/market
 *
 * Proxy for Hyperliquid market data.
 * Enhanced with funding rates, OI, and asset metadata.
 *
 * Actions: mids, markets, markets-enriched, book, assets, funding
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") || "mids";

  try {
    switch (action) {
      case "mids": {
        const mids = await getAllMids();
        return NextResponse.json({ mids });
      }

      case "markets": {
        const markets = await getMarketData();
        return NextResponse.json({ markets });
      }

      case "markets-enriched": {
        const markets = await getEnrichedMarketData();
        return NextResponse.json({ markets });
      }

      case "book": {
        const coin = searchParams.get("coin");
        if (!coin)
          return NextResponse.json(
            { error: "coin param required" },
            { status: 400 }
          );
        const book = await getL2Book(coin);
        return NextResponse.json({ book });
      }

      case "assets": {
        const assets = await getAllAssets();
        return NextResponse.json({ assets });
      }

      case "all-markets": {
        const allMarkets = await getAllMarkets();
        return NextResponse.json(allMarkets);
      }

      case "funding": {
        const coin = searchParams.get("coin");
        if (!coin)
          return NextResponse.json(
            { error: "coin param required" },
            { status: 400 }
          );
        const startTime =
          parseInt(searchParams.get("startTime") || "0") ||
          Date.now() - 24 * 60 * 60 * 1000; // default last 24h
        const history = await getFundingHistory(coin, startTime);
        return NextResponse.json({ funding: history });
      }

      default:
        return NextResponse.json(
          { error: "Unknown action. Use: mids, markets, markets-enriched, book, assets, funding, all-markets" },
          { status: 400 }
        );
    }
  } catch (error) {
    // Log concisely — no full stack traces for expected timeout/network errors
    const msg = error instanceof Error ? error.message : String(error);
    const isTimeout = msg.toLowerCase().includes("timeout");
    if (isTimeout) {
      console.warn(`[Market] HL API timeout for action="${action}" — returning empty data`);
    } else {
      console.error(`[Market] Error for action="${action}": ${msg.slice(0, 150)}`);
    }
    // Return empty data with stale flag instead of 500 — lets frontend degrade gracefully
    return NextResponse.json({
      error: isTimeout ? "Hyperliquid API timeout" : "Failed to fetch market data",
      stale: true,
      mids: {},
      markets: [],
      assets: [],
    });
  }
}
