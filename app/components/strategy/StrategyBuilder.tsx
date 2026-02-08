"use client";

import { useState, useEffect } from "react";
import type { StrategyConfig } from "@/lib/types";

interface Props {
  onSubmit: (config: StrategyConfig) => void;
  loading?: boolean;
}

const FALLBACK_MARKETS = ["BTC", "ETH", "SOL", "DOGE", "ARB", "OP", "AVAX", "MATIC", "LINK", "UNI"];

export function StrategyBuilder({ onSubmit, loading }: Props) {
  const [name, setName] = useState("");
  const [markets, setMarkets] = useState<string[]>(["BTC", "ETH"]);
  const [availableMarkets, setAvailableMarkets] = useState<string[]>(FALLBACK_MARKETS);
  const [marketSearch, setMarketSearch] = useState("");

  useEffect(() => {
    async function loadMarkets() {
      try {
        const res = await fetch("/api/market?action=all-markets");
        const data = await res.json();
        const perps: string[] = (data.perps || [])
          .filter((p: { isDelisted?: boolean }) => !p.isDelisted)
          .map((p: { name: string }) => p.name);
        if (perps.length > 0) setAvailableMarkets(perps);
      } catch {
        // keep fallback
      }
    }
    loadMarkets();
  }, []);
  const [maxLeverage, setMaxLeverage] = useState(5);
  const [riskLevel, setRiskLevel] = useState<"conservative" | "moderate" | "aggressive">("moderate");
  const [stopLossPercent, setStopLossPercent] = useState(5);
  const [takeProfitPercent, setTakeProfitPercent] = useState(10);
  const [tickIntervalMs, setTickIntervalMs] = useState(60000);
  const [useTestnet] = useState(true);

  const toggleMarket = (coin: string) => {
    setMarkets((prev) =>
      prev.includes(coin) ? prev.filter((c) => c !== coin) : [...prev, coin]
    );
  };

  const handleSubmit = () => {
    onSubmit({
      name,
      markets,
      maxLeverage,
      riskLevel,
      stopLossPercent,
      takeProfitPercent,
      tickIntervalMs,
      useTestnet,
    });
  };

  return (
    <div className="bg-card border border-card-border rounded-xl p-6 space-y-5">
      <h3 className="font-bold text-lg">Strategy Configuration</h3>

      {/* Name */}
      <div>
        <label className="block text-xs text-muted mb-1 font-medium">
          Strategy Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-background border border-card-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent"
        />
      </div>

      {/* Markets */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-muted font-medium">
            Markets ({markets.length} selected)
          </label>
          <button
            onClick={() => {
              if (markets.length === availableMarkets.length) {
                setMarkets([]);
              } else {
                setMarkets([...availableMarkets]);
              }
            }}
            className="text-[10px] text-accent hover:text-accent/80 font-medium"
          >
            {markets.length === availableMarkets.length ? "Deselect All" : "Select All"}
          </button>
        </div>
        <input
          type="text"
          value={marketSearch}
          onChange={(e) => setMarketSearch(e.target.value)}
          placeholder="Search markets..."
          className="w-full bg-background border border-card-border rounded-lg px-3 py-1.5 text-xs mb-2 focus:outline-none focus:border-accent"
        />
        <div className="flex flex-wrap gap-1.5 max-h-[160px] overflow-y-auto">
          {availableMarkets
            .filter((coin) => !marketSearch || coin.toLowerCase().includes(marketSearch.toLowerCase()))
            .map((coin) => (
              <button
                key={coin}
                onClick={() => toggleMarket(coin)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                  markets.includes(coin)
                    ? "bg-accent text-white"
                    : "bg-background border border-card-border text-muted hover:border-accent/50"
                }`}
              >
                {coin}
              </button>
            ))}
        </div>
      </div>

      {/* Risk + Leverage */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-muted mb-1 font-medium">
            Risk Level
          </label>
          <div className="grid grid-cols-3 gap-1">
            {(["conservative", "moderate", "aggressive"] as const).map((level) => (
              <button
                key={level}
                onClick={() => setRiskLevel(level)}
                className={`py-1.5 rounded text-xs font-medium transition-all capitalize ${
                  riskLevel === level
                    ? level === "conservative"
                      ? "bg-success text-white"
                      : level === "moderate"
                      ? "bg-warning text-black"
                      : "bg-danger text-white"
                    : "bg-background border border-card-border text-muted"
                }`}
              >
                {level.slice(0, 4)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs text-muted mb-1 font-medium">
            Max Leverage: {maxLeverage}x
          </label>
          <input
            type="range"
            min={1}
            max={50}
            value={maxLeverage}
            onChange={(e) => setMaxLeverage(parseInt(e.target.value))}
            className="w-full accent-accent"
          />
        </div>
      </div>

      {/* SL / TP */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-muted mb-1 font-medium">
            Stop Loss: {stopLossPercent}%
          </label>
          <input
            type="range"
            min={1}
            max={25}
            value={stopLossPercent}
            onChange={(e) => setStopLossPercent(parseInt(e.target.value))}
            className="w-full accent-danger"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1 font-medium">
            Take Profit: {takeProfitPercent}%
          </label>
          <input
            type="range"
            min={1}
            max={50}
            value={takeProfitPercent}
            onChange={(e) => setTakeProfitPercent(parseInt(e.target.value))}
            className="w-full accent-success"
          />
        </div>
      </div>

      {/* Tick Interval */}
      <div>
        <label className="block text-xs text-muted mb-1 font-medium">
          Tick Interval
        </label>
        <div className="grid grid-cols-4 gap-1">
          {[
            { label: "30s", value: 30000 },
            { label: "1m", value: 60000 },
            { label: "5m", value: 300000 },
            { label: "15m", value: 900000 },
          ].map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setTickIntervalMs(value)}
              className={`py-1.5 rounded text-xs font-medium transition-all ${
                tickIntervalMs === value
                  ? "bg-accent text-white"
                  : "bg-background border border-card-border text-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={loading || markets.length === 0}
        className="w-full bg-accent hover:bg-accent/80 disabled:bg-muted text-white py-3 rounded-lg font-bold text-sm transition-all"
      >
        {loading ? "Running Test..." : "Run Strategy Test"}
      </button>
    </div>
  );
}
