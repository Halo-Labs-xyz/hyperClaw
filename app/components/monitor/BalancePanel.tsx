"use client";

import { useSSE } from "@/lib/hooks/useSSE";
import type { StreamBalance } from "@/lib/types";
import type { Address } from "viem";

interface Props {
  user: Address;
}

export function BalancePanel({ user }: Props) {
  const { data: balance, connected } = useSSE<StreamBalance>({
    url: `/api/stream/balances?user=${user}`,
    event: "balance",
    enabled: !!user,
  });

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
        <h3 className="font-bold text-sm uppercase tracking-wider">
          Account Balance
        </h3>
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
      </div>

      {!balance ? (
        <div className="p-6 text-center text-muted text-sm">
          Loading balance...
        </div>
      ) : (
        <div className="p-4 grid grid-cols-2 gap-3">
          <BalanceStat
            label="Account Value"
            value={`$${balance.accountValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
            highlight
          />
          <BalanceStat
            label="Available"
            value={`$${balance.availableBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          />
          <BalanceStat
            label="Margin Used"
            value={`$${balance.marginUsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          />
          <BalanceStat
            label="Unrealized PnL"
            value={`${balance.unrealizedPnl >= 0 ? "+" : ""}$${balance.unrealizedPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
            positive={balance.unrealizedPnl >= 0}
          />
        </div>
      )}
    </div>
  );
}

function BalanceStat({
  label,
  value,
  positive,
  highlight,
}: {
  label: string;
  value: string;
  positive?: boolean;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-muted mb-0.5">{label}</div>
      <div
        className={`font-mono font-bold text-sm ${
          highlight
            ? "gradient-text"
            : positive === true
            ? "text-success"
            : positive === false
            ? "text-danger"
            : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}
