"use client";

import { useState } from "react";
import { useSSE } from "@/lib/hooks/useSSE";
import type { StreamOrder } from "@/lib/types";
import type { Address } from "viem";

interface Props {
  user: Address;
}

export function OrderPanel({ user }: Props) {
  const { data: orders, connected } = useSSE<StreamOrder[]>({
    url: `/api/stream/orders?user=${user}`,
    event: "orders",
    enabled: !!user,
  });
  const [cancelling, setCancelling] = useState<number | null>(null);

  const handleCancel = async (coin: string, oid: number) => {
    setCancelling(oid);
    try {
      await fetch("/api/trade/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coin, oid }),
      });
    } catch (e) {
      console.error("Cancel failed:", e);
    } finally {
      setCancelling(null);
    }
  };

  const handleCancelAll = async () => {
    try {
      await fetch("/api/trade/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
    } catch (e) {
      console.error("Cancel all failed:", e);
    }
  };

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="font-bold text-sm uppercase tracking-wider">
            Open Orders
          </h3>
          {orders && orders.length > 0 && (
            <span className="text-xs bg-accent/20 text-accent-light px-1.5 py-0.5 rounded">
              {orders.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {orders && orders.length > 0 && (
            <button
              onClick={handleCancelAll}
              aria-label="Cancel all open orders"
              className="text-xs text-danger hover:text-danger/80 transition-colors"
            >
              Cancel All
            </button>
          )}
          <StatusDot connected={connected} />
        </div>
      </div>

      {!orders || orders.length === 0 ? (
        <div className="p-8 text-center text-muted text-sm">
          No open orders
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Open orders">
            <thead>
              <tr className="text-muted text-left text-xs border-b border-card-border">
                <th className="px-4 py-2 font-medium">Coin</th>
                <th className="px-4 py-2 font-medium">Side</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Price</th>
                <th className="px-4 py-2 font-medium">Size</th>
                <th className="px-4 py-2 font-medium">Filled</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-card-border/50">
              {orders.map((order) => (
                <tr key={order.oid} className="hover:bg-background/30">
                  <td className="px-4 py-2 font-bold">{order.coin}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`text-xs font-bold uppercase ${
                        order.side === "buy" ? "text-success" : "text-danger"
                      }`}
                    >
                      {order.side}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted">
                    {order.orderType}
                    {order.reduceOnly && (
                      <span className="ml-1 text-warning">(RO)</span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono">
                    ${order.price.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 font-mono">
                    {order.size.toFixed(4)}
                  </td>
                  <td className="px-4 py-2 font-mono text-muted">
                    {(
                      ((order.originalSize - order.size) /
                        order.originalSize) *
                      100
                    ).toFixed(0)}
                    %
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => handleCancel(order.coin, order.oid)}
                      disabled={cancelling === order.oid}
                      className="text-xs text-danger hover:text-danger/80 disabled:text-muted transition-colors"
                    >
                      {cancelling === order.oid ? "..." : "Cancel"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`w-2 h-2 rounded-full ${
          connected ? "bg-success pulse-live" : "bg-danger"
        }`}
      />
      <span className="text-xs text-muted">
        {connected ? "Live" : "..."}
      </span>
    </div>
  );
}
