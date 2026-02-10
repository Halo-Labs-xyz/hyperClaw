"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NetworkToggle } from "@/app/components/NetworkToggle";
import type { Agent } from "@/lib/types";

type PnlPoint = {
  t: number;
  v: number;
};

const MAX_POINTS = 96;
const CHART_COLORS = [
  "#4AF0FF",
  "#30E8A0",
  "#FFB84A",
  "#FF4A6E",
  "#8AA4FF",
  "#FFD166",
];
const TIMEFRAME_POINTS = {
  "1m": 24,
  "5m": 48,
  "15m": 72,
} as const;
type TimeframeKey = keyof typeof TIMEFRAME_POINTS;

function formatUsd(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatAxisUsd(value: number): string {
  if (Math.abs(value) < 0.005) return "$0";
  const sign = value > 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function buildPath(points: Array<{ x: number; y: number }>): string {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

export default function ArenaPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [pnlMap, setPnlMap] = useState<Record<string, number>>({});
  const [historyMap, setHistoryMap] = useState<Record<string, PnlPoint[]>>({});
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number>(Date.now());
  const [autoJoinTargetId, setAutoJoinTargetId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<TimeframeKey>("15m");
  const [chartMode, setChartMode] = useState<"all" | "focus">("all");

  useEffect(() => {
    let mounted = true;

    const fetchAgents = async () => {
      try {
        const res = await fetch("/api/agents");
        const data = await res.json();
        if (!mounted) return;
        setAgents(data.agents || []);
        setUpdatedAt(Date.now());
      } catch {
        // keep previous state on transient failures
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchAgents();
    const interval = setInterval(fetchAgents, 4000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (agents.length === 0) return;

    let cancelled = false;
    const queue = [...agents];
    const concurrency = Math.min(4, queue.length);

    const fetchOne = async () => {
      while (!cancelled) {
        const a = queue.shift();
        if (!a) return;

        try {
          const res = await fetch("/api/fund", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "agent-balance", agentId: a.id, includePnl: true }),
            signal: AbortSignal.timeout(7000),
          });
          const data = await res.json();
          if (cancelled || typeof data.totalPnl !== "number") continue;

          const ts = Date.now();
          setPnlMap((prev) => ({ ...prev, [a.id]: data.totalPnl as number }));
          setHistoryMap((prev) => {
            const current = prev[a.id] || [];
            const next = [...current, { t: ts, v: data.totalPnl as number }].slice(-MAX_POINTS);
            return { ...prev, [a.id]: next };
          });
        } catch {
          // non-critical
        }
      }
    };

    Promise.all(Array.from({ length: concurrency }, () => fetchOne()));

    return () => {
      cancelled = true;
    };
  }, [agents, updatedAt]);

  const getPnl = (a: Agent) => pnlMap[a.id] ?? a.totalPnl;

  const ranked = useMemo(
    () => [...agents].sort((a, b) => getPnl(b) - getPnl(a)),
    [agents, pnlMap]
  );

  const chartAgents = useMemo(() => ranked.slice(0, 6), [ranked]);

  useEffect(() => {
    if (!selectedAgentId && chartAgents.length > 0) {
      setSelectedAgentId(chartAgents[0].id);
      return;
    }

    if (selectedAgentId && !ranked.some((a) => a.id === selectedAgentId)) {
      setSelectedAgentId(chartAgents[0]?.id ?? null);
    }
  }, [chartAgents, ranked, selectedAgentId]);

  const openVaults = ranked.filter((a) => a.vaultSocial?.isOpenVault);
  const autoJoinEligible = ranked.filter(
    (a) =>
      a.status === "active" &&
      a.vaultSocial?.isOpenVault &&
      a.autonomy?.mode === "full" &&
      getPnl(a) > 0
  );

  useEffect(() => {
    if (!autoJoinEligible.length) {
      setAutoJoinTargetId(null);
      return;
    }
    setAutoJoinTargetId((prev) => prev ?? autoJoinEligible[0].id);
  }, [autoJoinEligible]);

  const autoTarget =
    autoJoinEligible.find((a) => a.id === autoJoinTargetId) || autoJoinEligible[0] || null;
  const selectedAgent = ranked.find((a) => a.id === selectedAgentId) || ranked[0] || null;

  const chartSeries = useMemo(() => {
    const visibleAgents =
      chartMode === "focus" && selectedAgent ? [selectedAgent] : chartAgents;

    const withHistory = visibleAgents.map((agent) => ({
      agent,
      history: (historyMap[agent.id] || [{ t: Date.now(), v: getPnl(agent) }]).slice(
        -TIMEFRAME_POINTS[timeframe]
      ),
    }));

    const allValues = withHistory.flatMap((s) => s.history.map((p) => p.v));
    const rawMin = Math.min(0, ...allValues);
    const rawMax = Math.max(0, ...allValues);
    const base = Math.max(1, Math.abs(rawMin), Math.abs(rawMax));
    const margin = base * 0.12;
    let minValue = rawMin - margin;
    let maxValue = rawMax + margin;
    if (rawMin >= 0) minValue = Math.min(minValue, -base * 0.08);
    if (rawMax <= 0) maxValue = Math.max(maxValue, base * 0.08);
    const span = Math.max(0.0001, maxValue - minValue);

    const pointCount = Math.max(2, Math.max(...withHistory.map((s) => s.history.length)));

    const lines = withHistory.map((series, idx) => {
      const points = series.history.map((point, i) => {
        const x = 6 + (i / (pointCount - 1)) * 88;
        const normalized = (point.v - minValue) / span;
        const y = 88 - normalized * 78;
        return { x, y };
      });

      const last = points[points.length - 1] || { x: 6, y: 88 };

      return {
        agent: series.agent,
        color: CHART_COLORS[idx % CHART_COLORS.length],
        path: buildPath(points),
        last,
      };
    });

    const zeroNormalized = (0 - minValue) / span;
    const zeroY = 88 - zeroNormalized * 78;

    return {
      lines,
      zeroY,
      minValue,
      maxValue,
    };
  }, [chartAgents, chartMode, historyMap, pnlMap, selectedAgent, timeframe]);

  const aggregatePnl = ranked.reduce((sum, a) => sum + getPnl(a), 0);

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      <div className="orb orb-green w-[460px] h-[460px] -top-[180px] right-[8%] fixed" />
      <div className="orb orb-purple w-[420px] h-[420px] bottom-[6%] -left-[130px] fixed" />

      <header className="glass sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-3 group">
              <div className="w-9 h-9 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center group-hover:bg-accent/15 transition-colors">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
                  <path d="M6 3v12" /><path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M15 6a9 9 0 0 0-9 9" /><path d="M18 15v6" /><path d="M21 18h-6" />
                </svg>
              </div>
              <span className="text-lg font-bold tracking-tight gradient-text">Hyperclaw</span>
            </Link>
            <div className="hidden sm:flex items-center gap-1 text-sm text-muted">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-dim"><path d="M9 18l6-6-6-6" /></svg>
              <span className="text-foreground font-medium">Live Arena</span>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <NetworkToggle />
            <Link href="/agents" className="btn-secondary px-4 py-2 text-sm">
              Browse Agents
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 md:py-10 relative z-10">
        <section className="mb-7">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
            <div>
              <h1 className="text-2xl md:text-3xl font-bold mb-2">Arena: Live Time-Series</h1>
              <p className="text-sm text-muted">
                TradingView-inspired multi-line PnL chart. Time flows left to right. Zero baseline separates positive and negative regions.
              </p>
            </div>
            <div className="chip chip-active text-[11px]">
              <span className="w-1.5 h-1.5 rounded-full bg-current pulse-live" />
              Updated {new Date(updatedAt).toLocaleTimeString()}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card p-4">
              <p className="text-xs text-dim mb-1">Tracked Agents</p>
              <p className="text-xl font-semibold mono-nums">{ranked.length}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs text-dim mb-1">Open Vaults</p>
              <p className="text-xl font-semibold mono-nums">{openVaults.length}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs text-dim mb-1">Auto-Join Eligible</p>
              <p className="text-xl font-semibold mono-nums text-success">{autoJoinEligible.length}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs text-dim mb-1">Aggregate PnL</p>
              <p className={`text-xl font-semibold mono-nums ${aggregatePnl >= 0 ? "text-success" : "text-danger"}`}>
                {formatUsd(aggregatePnl)}
              </p>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-3 gap-4 md:gap-5">
          <div className="xl:col-span-2 card p-4 md:p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold">PnL Time-Series</h2>
              <div className="flex items-center gap-2">
                <div className="hidden sm:flex items-center bg-surface border border-card-border rounded-lg p-0.5">
                  {(["1m", "5m", "15m"] as TimeframeKey[]).map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => setTimeframe(tf)}
                      className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                        timeframe === tf ? "bg-card text-foreground" : "text-muted hover:text-foreground"
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
                <div className="hidden sm:flex items-center bg-surface border border-card-border rounded-lg p-0.5">
                  <button
                    type="button"
                    onClick={() => setChartMode("all")}
                    className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                      chartMode === "all" ? "bg-card text-foreground" : "text-muted hover:text-foreground"
                    }`}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setChartMode("focus")}
                    className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                      chartMode === "focus" ? "bg-card text-foreground" : "text-muted hover:text-foreground"
                    }`}
                  >
                    Focus
                  </button>
                </div>
                <span className="text-xs text-dim">Smooth update-only movement</span>
              </div>
            </div>

            {loading ? (
              <div className="h-[500px] rounded-2xl bg-surface shimmer" />
            ) : chartSeries.lines.length === 0 ? (
              <div className="h-[500px] rounded-2xl bg-surface/70 flex items-center justify-center text-sm text-muted">
                No agents available yet.
              </div>
            ) : (
              <div className="h-[500px] rounded-2xl relative overflow-hidden border border-card-border bg-[linear-gradient(180deg,#090c18_0%,#070913_44%,#070a11_100%)]">
                <div className="absolute inset-0 pointer-events-none" style={{
                  backgroundImage:
                    "linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px)",
                  backgroundSize: "48px 48px",
                }} />

                <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_15%_12%,rgba(74,240,255,0.10),transparent_34%),radial-gradient(circle_at_82%_18%,rgba(48,232,160,0.10),transparent_32%)]" />

                <div className="absolute left-4 top-3 text-[10px] text-dim">PnL (USD)</div>
                <div className="absolute right-4 top-3 text-[10px] text-dim">Time</div>
                <div className="absolute left-4 bottom-3 text-[10px] text-dim">Older</div>
                <div className="absolute right-4 bottom-3 text-[10px] text-dim">Now</div>

                <div
                  className="absolute left-0 right-0 h-px bg-white/40 pointer-events-none"
                  style={{ top: `${chartSeries.zeroY}%` }}
                />
                <div
                  className="absolute left-4 -translate-y-1/2 px-2 py-0.5 text-[10px] rounded bg-black/55 border border-white/10 text-muted pointer-events-none"
                  style={{ top: `${chartSeries.zeroY}%` }}
                >
                  break-even (0 PnL)
                </div>

                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
                  <defs>
                    {chartSeries.lines.map((line, idx) => (
                      <linearGradient key={line.agent.id} id={`hc-line-${idx}`} x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor={line.color} stopOpacity="0.45" />
                        <stop offset="100%" stopColor={line.color} stopOpacity="1" />
                      </linearGradient>
                    ))}
                  </defs>

                  {chartSeries.lines.map((line, idx) => (
                    <path
                      key={line.agent.id}
                      d={line.path}
                      fill="none"
                      stroke={`url(#hc-line-${idx})`}
                      strokeWidth={selectedAgent?.id === line.agent.id ? 0.85 : 0.55}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ transition: "d 650ms cubic-bezier(0.22, 0.61, 0.36, 1)" }}
                    />
                  ))}
                </svg>

                {chartSeries.lines.map((line, idx) => {
                  const active = selectedAgent?.id === line.agent.id;
                  const showLabel = chartMode === "focus" || active || idx < 2;
                  const labelToLeft = line.last.x > 82;
                  const labelShiftY = (idx % 3) * 14 - 14;

                  return (
                    <button
                      key={line.agent.id}
                      type="button"
                      onClick={() => setSelectedAgentId(line.agent.id)}
                      className="absolute focus:outline-none"
                      style={{
                        left: `${line.last.x}%`,
                        top: `${line.last.y}%`,
                        transform: "translate(-50%, -50%)",
                        zIndex: active ? 40 : 25,
                        transition: "left 650ms cubic-bezier(0.22, 0.61, 0.36, 1), top 650ms cubic-bezier(0.22, 0.61, 0.36, 1)",
                      }}
                      title={`${line.agent.name} ${formatUsd(getPnl(line.agent))}`}
                    >
                      <div
                        className={`rounded-full border ${active ? "border-white" : "border-white/40"}`}
                        style={{
                          width: active ? 14 : 10,
                          height: active ? 14 : 10,
                          background: line.color,
                          boxShadow: active
                            ? `0 0 0 4px ${line.color}33, 0 0 24px ${line.color}99`
                            : `0 0 14px ${line.color}77`,
                        }}
                      />
                      {showLabel && (
                        <div
                          className={`absolute top-1/2 px-2 py-0.5 rounded text-[10px] whitespace-nowrap backdrop-blur-sm ${
                            labelToLeft ? "right-[calc(100%+8px)]" : "left-[calc(100%+8px)]"
                          } ${active ? "bg-card/90 text-foreground border border-white/30" : "bg-black/55 text-muted border border-white/10"}`}
                          style={{ transform: `translateY(calc(-50% + ${labelShiftY}px))` }}
                        >
                          {line.agent.name} {formatUsd(getPnl(line.agent))}
                        </div>
                      )}
                    </button>
                  );
                })}

                <div className="absolute right-3 top-10 space-y-1.5">
                  <div className="px-2 py-1 rounded bg-black/45 border border-white/10 text-[10px] text-muted mono-nums">
                    Hi {formatAxisUsd(chartSeries.maxValue)}
                  </div>
                  <div className="px-2 py-1 rounded bg-black/45 border border-white/10 text-[10px] text-muted mono-nums">
                    Lo {formatAxisUsd(chartSeries.minValue)}
                  </div>
                </div>

                <div className="absolute left-3 top-10 flex flex-wrap gap-1.5 max-w-[70%]">
                  {chartSeries.lines.map((line) => (
                    <button
                      key={line.agent.id}
                      type="button"
                      onClick={() => setSelectedAgentId(line.agent.id)}
                      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] ${
                        selectedAgent?.id === line.agent.id
                          ? "bg-card/90 border-white/30 text-foreground"
                          : "bg-black/35 border-white/10 text-muted hover:text-foreground"
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: line.color }} />
                      {line.agent.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="card p-4 md:p-5">
              <h2 className="text-sm font-semibold mb-2">Selected Agent</h2>
              {selectedAgent ? (
                <div>
                  <p className="text-sm font-semibold">{selectedAgent.name}</p>
                  <p className="text-xs text-muted mb-3">
                    {selectedAgent.status} • {(selectedAgent.winRate * 100).toFixed(1)}% win rate
                  </p>
                  <div className="space-y-1.5 text-xs mb-3">
                    <div className="flex justify-between">
                      <span className="text-dim">PnL</span>
                      <span className={getPnl(selectedAgent) >= 0 ? "text-success font-semibold mono-nums" : "text-danger font-semibold mono-nums"}>
                        {formatUsd(getPnl(selectedAgent))}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-dim">Vault TVL</span>
                      <span className="mono-nums">${selectedAgent.vaultTvlUsd.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-dim">Autonomy</span>
                      <span>{selectedAgent.autonomy?.mode ?? "manual"}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link href={`/agents/${selectedAgent.id}`} className="btn-primary px-3 py-2 text-xs">
                      Join Vault
                    </Link>
                    <Link href={`/agents/${selectedAgent.id}`} className="btn-secondary px-3 py-2 text-xs">
                      View Agent
                    </Link>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted">No agent selected.</p>
              )}
            </div>

            <div className="card p-4 md:p-5">
              <h2 className="text-sm font-semibold mb-1">Auto-Join Policy</h2>
              <p className="text-xs text-muted mb-3">
                Automatic selection chooses active full-auto agents with open vaults and positive PnL.
              </p>
              {autoTarget ? (
                <div className="rounded-xl border border-success/25 bg-success/10 p-3">
                  <p className="text-[11px] text-success mb-1">Current Auto Target</p>
                  <p className="text-sm font-semibold">{autoTarget.name}</p>
                  <p className="text-xs text-muted mb-3">
                    {formatUsd(getPnl(autoTarget))} • TVL ${autoTarget.vaultTvlUsd.toLocaleString()}
                  </p>
                  <Link href={`/agents/${autoTarget.id}`} className="btn-primary px-3 py-2 text-xs inline-flex">
                    Join Target Vault
                  </Link>
                </div>
              ) : (
                <div className="rounded-xl border border-card-border bg-surface/70 p-3 text-xs text-muted">
                  No current auto-join target.
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
