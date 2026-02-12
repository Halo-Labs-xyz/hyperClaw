"use client";

import { useState } from "react";
import type { TradeLog } from "@/lib/types";

function ReasoningCell({ reasoning }: { reasoning?: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = reasoning?.trim() || "—";
  const isLong = text.length > 60;
  return (
    <button
      type="button"
      onClick={() => isLong && setExpanded((e) => !e)}
      className={`text-left w-full block max-w-[280px] ${isLong ? "cursor-pointer hover:text-foreground/80" : ""}`}
      title={isLong ? (expanded ? "Click to collapse" : "Click to see full reasoning") : undefined}
    >
      {expanded ? (
        <span className="whitespace-pre-wrap break-words block max-h-32 overflow-y-auto text-xs">{text}</span>
      ) : (
        <span className={isLong ? "truncate block" : ""}>{text}</span>
      )}
      {isLong && <span className="text-[10px] text-muted ml-1">{expanded ? "▲" : "⋯"}</span>}
    </button>
  );
}

interface Props {
  trades: TradeLog[];
  startTime: number;
  endTime?: number;
}

export function BacktestResults({ trades, startTime, endTime }: Props) {
  const executedTrades = trades.filter((t) => t.executed);
  const holdDecisions = trades.filter((t) => t.decision.action === "hold");

  // Calculate stats
  const totalTrades = executedTrades.length;
  const longs = executedTrades.filter((t) => t.decision.action === "long").length;
  const shorts = executedTrades.filter((t) => t.decision.action === "short").length;
  const closes = executedTrades.filter((t) => t.decision.action === "close").length;

  const avgConfidence =
    trades.length > 0
      ? trades.reduce((sum, t) => sum + t.decision.confidence, 0) / trades.length
      : 0;

  const avgLeverage =
    executedTrades.length > 0
      ? executedTrades.reduce((sum, t) => sum + t.decision.leverage, 0) /
        executedTrades.length
      : 0;

  const duration = (endTime || Date.now()) - startTime;
  const durationStr =
    duration < 60000
      ? `${Math.floor(duration / 1000)}s`
      : duration < 3600000
      ? `${Math.floor(duration / 60000)}m`
      : `${(duration / 3600000).toFixed(1)}h`;

  // Unique assets traded
  const uniqueAssets = Array.from(
    new Set(executedTrades.map((t) => t.decision.asset))
  );

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-card-border">
        <h3 className="font-bold text-sm uppercase tracking-wider">
          Test Results
        </h3>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 border-b border-card-border">
        <Stat label="Total Ticks" value={trades.length.toString()} />
        <Stat label="Executed Trades" value={totalTrades.toString()} />
        <Stat label="Hold Decisions" value={holdDecisions.length.toString()} />
        <Stat label="Duration" value={durationStr} />
        <Stat label="Longs" value={longs.toString()} color="success" />
        <Stat label="Shorts" value={shorts.toString()} color="danger" />
        <Stat label="Closes" value={closes.toString()} color="warning" />
        <Stat
          label="Avg Confidence"
          value={`${(avgConfidence * 100).toFixed(0)}%`}
        />
        <Stat
          label="Avg Leverage"
          value={`${avgLeverage.toFixed(1)}x`}
        />
        <Stat
          label="Assets Traded"
          value={uniqueAssets.join(", ") || "None"}
        />
      </div>

      {/* Trade Log */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted text-left text-xs border-b border-card-border">
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Asset</th>
              <th className="px-4 py-2 font-medium">Size</th>
              <th className="px-4 py-2 font-medium">Lev</th>
              <th className="px-4 py-2 font-medium">Conf</th>
              <th className="px-4 py-2 font-medium">Exec</th>
              <th className="px-4 py-2 font-medium">Reasoning</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-card-border/50">
            {trades.map((trade) => (
              <tr key={trade.id} className="hover:bg-background/30">
                <td className="px-4 py-2 text-xs text-muted font-mono">
                  {new Date(trade.timestamp).toLocaleTimeString()}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`text-xs font-bold uppercase ${
                      trade.decision.action === "long"
                        ? "text-success"
                        : trade.decision.action === "short"
                        ? "text-danger"
                        : trade.decision.action === "close"
                        ? "text-warning"
                        : "text-muted"
                    }`}
                  >
                    {trade.decision.action}
                  </span>
                </td>
                <td className="px-4 py-2 font-bold text-xs">
                  {trade.decision.asset}
                </td>
                <td className="px-4 py-2 font-mono text-xs">
                  {(trade.decision.size * 100).toFixed(0)}%
                </td>
                <td className="px-4 py-2 text-xs">
                  {trade.decision.leverage}x
                </td>
                <td className="px-4 py-2 text-xs">
                  <span
                    className={
                      trade.decision.confidence >= 0.8
                        ? "text-success"
                        : trade.decision.confidence >= 0.6
                        ? "text-warning"
                        : "text-muted"
                    }
                  >
                    {(trade.decision.confidence * 100).toFixed(0)}%
                  </span>
                </td>
                <td className="px-4 py-2 text-xs">
                  {trade.executed ? (
                    <span className="text-success">Yes</span>
                  ) : (
                    <span className="text-muted">No</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-muted max-w-[200px]">
                  <ReasoningCell reasoning={trade.decision.reasoning} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div
        className={`font-bold text-sm ${
          color === "success"
            ? "text-success"
            : color === "danger"
            ? "text-danger"
            : color === "warning"
            ? "text-warning"
            : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}
