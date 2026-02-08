"use client";

import { useState } from "react";
import { useSSE } from "@/lib/hooks/useSSE";
import type { StreamBook } from "@/lib/types";

interface Props {
  defaultCoin?: string;
}

export function BookPanel({ defaultCoin = "BTC" }: Props) {
  const [coin, setCoin] = useState(defaultCoin);
  const [inputCoin, setInputCoin] = useState(defaultCoin);

  const { data: book, connected } = useSSE<StreamBook>({
    url: `/api/stream/book?coin=${coin}`,
    event: "book",
  });

  const handleChangeCoin = () => {
    const normalized = inputCoin.toUpperCase().trim();
    if (normalized && normalized !== coin) {
      setCoin(normalized);
    }
  };

  const maxDepth = 10;

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="font-bold text-sm uppercase tracking-wider">
            Order Book
          </h3>
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={inputCoin}
              onChange={(e) => setInputCoin(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleChangeCoin()}
              onBlur={handleChangeCoin}
              aria-label="Market symbol"
              className="bg-background border border-card-border rounded px-2 py-0.5 text-xs w-16 text-center font-bold focus:outline-none focus:border-accent"
            />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className={`w-2 h-2 rounded-full ${
              connected ? "bg-success pulse-live" : "bg-danger"
            }`}
            aria-label={connected ? "Connected" : "Disconnected"}
            role="status"
          />
          <span className="text-xs text-muted">
            {connected ? "Live" : "..."}
          </span>
        </div>
      </div>

      {!book ? (
        <div className="p-8 text-center text-muted text-sm">
          Loading order book...
        </div>
      ) : (
        <div className="p-2">
          {/* Spread indicator */}
          <div className="text-center py-1 mb-1">
            <span className="text-xs text-muted">Spread: </span>
            <span className="text-xs font-mono font-bold">
              ${book.spread.toFixed(2)}
            </span>
            <span className="text-xs text-muted ml-1">
              ({book.spreadPercent.toFixed(4)}%)
            </span>
          </div>

          {/* Asks (reversed - lowest at bottom) */}
          <div className="space-y-0.5 mb-1">
            {book.asks
              .slice(0, maxDepth)
              .reverse()
              .map((level, i) => (
                <div
                  key={`ask-${i}`}
                  className="relative flex items-center justify-between px-2 py-0.5 text-xs font-mono"
                >
                  <div
                    className="absolute inset-0 bg-danger/10 origin-right"
                    style={{ width: `${Math.min(level.percent, 100)}%` }}
                  />
                  <span className="relative text-danger">
                    ${level.price.toLocaleString()}
                  </span>
                  <span className="relative text-muted">
                    {level.size.toFixed(4)}
                  </span>
                  <span className="relative text-muted/60">
                    {level.cumulative.toFixed(2)}
                  </span>
                </div>
              ))}
          </div>

          {/* Mid price */}
          <div className="text-center py-1.5 border-y border-card-border my-1">
            <span className="font-bold font-mono text-lg">
              ${book.midPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>

          {/* Bids */}
          <div className="space-y-0.5 mt-1">
            {book.bids.slice(0, maxDepth).map((level, i) => (
              <div
                key={`bid-${i}`}
                className="relative flex items-center justify-between px-2 py-0.5 text-xs font-mono"
              >
                <div
                  className="absolute inset-0 bg-success/10 origin-right"
                  style={{ width: `${Math.min(level.percent, 100)}%` }}
                />
                <span className="relative text-success">
                  ${level.price.toLocaleString()}
                </span>
                <span className="relative text-muted">
                  {level.size.toFixed(4)}
                </span>
                <span className="relative text-muted/60">
                  {level.cumulative.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
