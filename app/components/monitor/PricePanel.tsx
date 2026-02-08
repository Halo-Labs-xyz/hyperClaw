"use client";

import { useState, useRef, useEffect } from "react";
import { useSSE } from "@/lib/hooks/useSSE";
import type { StreamPrice } from "@/lib/types";

interface Props {
  coins?: string[];
}

export function PricePanel({ coins }: Props) {
  const coinsParam = coins ? `&coins=${coins.join(",")}` : "";
  const { data: prices, connected } = useSSE<Record<string, StreamPrice>>({
    url: `/api/stream/prices?_t=${Date.now()}${coinsParam}`,
    event: "prices",
  });

  const prevPrices = useRef<Record<string, number>>({});
  const [flashes, setFlashes] = useState<Record<string, "up" | "down">>({});

  // Flash animation on price change
  useEffect(() => {
    if (!prices) return;
    const newFlashes: Record<string, "up" | "down"> = {};

    for (const [coin, priceData] of Object.entries(prices)) {
      const prev = prevPrices.current[coin];
      if (prev !== undefined && prev !== priceData.price) {
        newFlashes[coin] = priceData.price > prev ? "up" : "down";
      }
      prevPrices.current[coin] = priceData.price;
    }

    if (Object.keys(newFlashes).length > 0) {
      setFlashes(newFlashes);
      const timer = setTimeout(() => setFlashes({}), 500);
      return () => clearTimeout(timer);
    }
  }, [prices]);

  const sortedCoins = prices
    ? Object.entries(prices)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(0, coins?.length ?? 20)
    : [];

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
        <h3 className="font-bold text-sm uppercase tracking-wider">
          Live Prices
        </h3>
        <div className="flex items-center gap-1.5">
          <div
            className={`w-2 h-2 rounded-full ${
              connected ? "bg-success pulse-live" : "bg-danger"
            }`}
          />
          <span className="text-xs text-muted">
            {connected ? "Live" : "Connecting"}
          </span>
        </div>
      </div>

      <div className="max-h-[400px] overflow-y-auto">
        {sortedCoins.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm">
            Waiting for price data...
          </div>
        ) : (
          <div className="divide-y divide-card-border/30">
            {sortedCoins.map(([coin, priceData]) => (
              <div
                key={coin}
                className={`px-4 py-2.5 flex items-center justify-between transition-colors duration-300 ${
                  flashes[coin] === "up"
                    ? "bg-success/10"
                    : flashes[coin] === "down"
                    ? "bg-danger/10"
                    : ""
                }`}
              >
                <span className="font-bold text-sm">{coin}</span>
                <span
                  className={`font-mono text-sm font-medium ${
                    flashes[coin] === "up"
                      ? "text-success"
                      : flashes[coin] === "down"
                      ? "text-danger"
                      : ""
                  }`}
                >
                  $
                  {priceData.price.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits:
                      priceData.price < 1 ? 6 : priceData.price < 100 ? 4 : 2,
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
