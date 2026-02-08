"use client";

import { useState } from "react";
import type { OrderType, OrderSide, TimeInForce } from "@/lib/types";

export function QuickTrade() {
  const [coin, setCoin] = useState("BTC");
  const [side, setSide] = useState<OrderSide>("buy");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [size, setSize] = useState("");
  const [price, setPrice] = useState("");
  const [triggerPrice, setTriggerPrice] = useState("");
  const [slippage, setSlippage] = useState("1");
  const [tif, setTif] = useState<TimeInForce>("Gtc");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const handleSubmit = async () => {
    if (!size || parseFloat(size) <= 0) return;
    setSubmitting(true);
    setResult(null);

    try {
      const body: Record<string, unknown> = {
        coin: coin.toUpperCase(),
        side,
        size: parseFloat(size),
        orderType,
        reduceOnly,
      };

      if (orderType === "limit") {
        body.price = parseFloat(price);
        body.tif = tif;
      }
      if (orderType === "market") {
        body.slippagePercent = parseFloat(slippage);
      }
      if (orderType === "stop-loss" || orderType === "take-profit") {
        body.price = parseFloat(price);
        body.triggerPrice = parseFloat(triggerPrice);
        body.isTpsl = true;
      }

      const res = await fetch("/api/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (res.ok) {
        setResult({ success: true, message: "Order placed" });
        setSize("");
        setPrice("");
        setTriggerPrice("");
      } else {
        setResult({ success: false, message: data.error || "Order failed" });
      }
    } catch (e) {
      setResult({
        success: false,
        message: e instanceof Error ? e.message : "Network error",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-card-border">
        <h3 className="font-bold text-sm uppercase tracking-wider">
          Quick Trade
        </h3>
      </div>

      <div className="p-4 space-y-3">
        {/* Coin */}
        <div>
          <label className="block text-xs text-muted mb-1">Asset</label>
          <input
            type="text"
            value={coin}
            onChange={(e) => setCoin(e.target.value)}
            className="w-full bg-background border border-card-border rounded-lg px-3 py-2 text-sm font-bold uppercase focus:outline-none focus:border-accent"
          />
        </div>

        {/* Side */}
        <div>
          <label className="block text-xs text-muted mb-1">Side</label>
          <div className="grid grid-cols-2 gap-1">
            <button
              onClick={() => setSide("buy")}
              className={`py-2 rounded-lg text-sm font-bold transition-all ${
                side === "buy" || side === "long"
                  ? "bg-success text-white"
                  : "bg-background border border-card-border text-muted hover:border-success/50"
              }`}
            >
              Long / Buy
            </button>
            <button
              onClick={() => setSide("sell")}
              className={`py-2 rounded-lg text-sm font-bold transition-all ${
                side === "sell" || side === "short"
                  ? "bg-danger text-white"
                  : "bg-background border border-card-border text-muted hover:border-danger/50"
              }`}
            >
              Short / Sell
            </button>
          </div>
        </div>

        {/* Order Type */}
        <div>
          <label className="block text-xs text-muted mb-1">Order Type</label>
          <div className="grid grid-cols-4 gap-1">
            {(["market", "limit", "stop-loss", "take-profit"] as OrderType[]).map(
              (type) => (
                <button
                  key={type}
                  onClick={() => setOrderType(type)}
                  className={`py-1.5 rounded text-xs font-medium transition-all capitalize ${
                    orderType === type
                      ? "bg-accent text-white"
                      : "bg-background border border-card-border text-muted"
                  }`}
                >
                  {type === "stop-loss" ? "SL" : type === "take-profit" ? "TP" : type}
                </button>
              )
            )}
          </div>
        </div>

        {/* Size */}
        <div>
          <label className="block text-xs text-muted mb-1">Size</label>
          <input
            type="number"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            placeholder="0.001"
            className="w-full bg-background border border-card-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
          />
        </div>

        {/* Price (for limit, SL, TP) */}
        {orderType !== "market" && (
          <div>
            <label className="block text-xs text-muted mb-1">Price</label>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              className="w-full bg-background border border-card-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
            />
          </div>
        )}

        {/* Trigger Price (for SL, TP) */}
        {(orderType === "stop-loss" || orderType === "take-profit") && (
          <div>
            <label className="block text-xs text-muted mb-1">
              Trigger Price
            </label>
            <input
              type="number"
              value={triggerPrice}
              onChange={(e) => setTriggerPrice(e.target.value)}
              placeholder="0.00"
              className="w-full bg-background border border-card-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
            />
          </div>
        )}

        {/* Slippage (for market) */}
        {orderType === "market" && (
          <div>
            <label className="block text-xs text-muted mb-1">
              Slippage %
            </label>
            <input
              type="number"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
              className="w-full bg-background border border-card-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
            />
          </div>
        )}

        {/* TIF (for limit) */}
        {orderType === "limit" && (
          <div>
            <label className="block text-xs text-muted mb-1">
              Time in Force
            </label>
            <div className="grid grid-cols-3 gap-1">
              {(["Gtc", "Ioc", "Alo"] as TimeInForce[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTif(t)}
                  className={`py-1.5 rounded text-xs font-medium transition-all ${
                    tif === t
                      ? "bg-accent text-white"
                      : "bg-background border border-card-border text-muted"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Reduce Only */}
        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={reduceOnly}
            onChange={(e) => setReduceOnly(e.target.checked)}
            className="rounded border-card-border"
          />
          Reduce Only
        </label>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={submitting || !size}
          className={`w-full py-3 rounded-lg font-bold text-sm transition-all ${
            side === "buy" || side === "long"
              ? "bg-success hover:bg-success/80 text-white"
              : "bg-danger hover:bg-danger/80 text-white"
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {submitting
            ? "Placing..."
            : `${side === "buy" || side === "long" ? "Buy" : "Sell"} ${coin.toUpperCase()}`}
        </button>

        {/* Result */}
        {result && (
          <div
            className={`text-xs p-2 rounded ${
              result.success
                ? "bg-success/20 text-success"
                : "bg-danger/20 text-danger"
            }`}
          >
            {result.message}
          </div>
        )}
      </div>
    </div>
  );
}
