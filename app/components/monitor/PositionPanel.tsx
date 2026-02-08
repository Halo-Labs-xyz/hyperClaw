"use client";

import { useSSE } from "@/lib/hooks/useSSE";
import type { StreamPosition } from "@/lib/types";
import type { Address } from "viem";

interface Props {
  user: Address;
}

export function PositionPanel({ user }: Props) {
  const { data: positions, connected } = useSSE<StreamPosition[]>({
    url: `/api/stream/positions?user=${user}`,
    event: "positions",
    enabled: !!user,
  });

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
        <h3 className="font-bold text-sm uppercase tracking-wider">
          Positions
        </h3>
        <StatusDot connected={connected} />
      </div>

      {!positions || positions.length === 0 ? (
        <div className="p-8 text-center text-muted text-sm">
          No open positions
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted text-left text-xs border-b border-card-border">
                <th className="px-4 py-2 font-medium">Coin</th>
                <th className="px-4 py-2 font-medium">Side</th>
                <th className="px-4 py-2 font-medium">Size</th>
                <th className="px-4 py-2 font-medium">Entry</th>
                <th className="px-4 py-2 font-medium">Value</th>
                <th className="px-4 py-2 font-medium">uPnL</th>
                <th className="px-4 py-2 font-medium">Lev</th>
                <th className="px-4 py-2 font-medium">Liq.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-card-border/50">
              {positions.map((pos) => (
                <tr key={pos.coin} className="hover:bg-background/30">
                  <td className="px-4 py-2 font-bold">{pos.coin}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`text-xs font-bold uppercase px-2 py-0.5 rounded ${
                        pos.side === "long"
                          ? "bg-success/20 text-success"
                          : "bg-danger/20 text-danger"
                      }`}
                    >
                      {pos.side}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono">
                    {pos.size.toFixed(4)}
                  </td>
                  <td className="px-4 py-2 font-mono">
                    ${pos.entryPrice.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 font-mono">
                    ${pos.positionValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </td>
                  <td
                    className={`px-4 py-2 font-mono font-bold ${
                      pos.unrealizedPnl >= 0 ? "text-success" : "text-danger"
                    }`}
                  >
                    {pos.unrealizedPnl >= 0 ? "+" : ""}
                    ${pos.unrealizedPnl.toFixed(2)}
                    <span className="text-xs ml-1 opacity-70">
                      ({pos.unrealizedPnlPercent >= 0 ? "+" : ""}
                      {pos.unrealizedPnlPercent.toFixed(2)}%)
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <span className="bg-accent/20 text-accent-light text-xs px-1.5 py-0.5 rounded">
                      {pos.leverage}x
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-muted">
                    {pos.liquidationPrice
                      ? `$${pos.liquidationPrice.toLocaleString()}`
                      : "---"}
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
        {connected ? "Live" : "Connecting"}
      </span>
    </div>
  );
}
