"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NetworkToggle } from "@/app/components/NetworkToggle";
import { useNetwork } from "@/app/components/NetworkContext";
import { HyperclawLogo } from "@/app/components/HyperclawLogo";
import { HyperclawIcon } from "@/app/components/HyperclawIcon";
import { TelegramChatButton } from "@/app/components/TelegramChatButton";
import { AgentAvatar } from "@/app/components/AgentAvatar";
import type { Agent } from "@/lib/types";

type PnlPoint = { t: number; v: number };

const MAX_POINTS = 96;
const TICK_INTERVAL_MS = 4000;
const CHART_TRANSITION_MS = 3800;
const CHART_COLORS = ["#4AF0FF", "#30E8A0", "#FFB84A", "#FF4A6E", "#8AA4FF", "#FFD166"];
const TIMEFRAME_POINTS = { "1m": 24, "5m": 48, "15m": 72 } as const;
type TimeframeKey = keyof typeof TIMEFRAME_POINTS;

const AUTONOMY_META: Record<string, { icon: string; label: string }> = {
  full: { icon: "M13 10V3L4 14h7v7l9-11h-7z", label: "Full Auto" },
  semi: { icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", label: "Semi-Auto" },
  manual: { icon: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", label: "Manual" },
};

function formatUsd(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatAxisUsd(value: number): string {
  if (Math.abs(value) < 0.005) return "$0";
  const sign = value > 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function buildSmoothPath(points: Array<{ x: number; y: number }>): string {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const cpx = (prev.x + curr.x) / 2;
    d += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
  }
  return d;
}

function buildAreaPath(points: Array<{ x: number; y: number }>, baseY: number): string {
  if (points.length < 2) return "";
  const linePath = buildSmoothPath(points);
  const last = points[points.length - 1];
  const first = points[0];
  return `${linePath} L ${last.x} ${baseY} L ${first.x} ${baseY} Z`;
}

function normalizeHistory(history: PnlPoint[], desiredPoints: number, fallbackValue: number): PnlPoint[] {
  if (desiredPoints <= 0) return [];
  if (history.length === 0) {
    return Array.from({ length: desiredPoints }, () => ({ t: Date.now(), v: fallbackValue }));
  }
  const trimmed = history.slice(-desiredPoints);
  if (trimmed.length === desiredPoints) return trimmed;
  const padCount = desiredPoints - trimmed.length;
  const first = trimmed[0];
  const padding = Array.from({ length: padCount }, (_, idx) => ({
    t: first.t - (padCount - idx),
    v: first.v,
  }));
  return [...padding, ...trimmed];
}

function MedalIcon({ rank }: { rank: number }) {
  if (rank === 0) return <span className="text-lg leading-none drop-shadow-[0_0_6px_rgba(255,215,0,0.6)]">&#x1F947;</span>;
  if (rank === 1) return <span className="text-lg leading-none drop-shadow-[0_0_4px_rgba(192,192,192,0.5)]">&#x1F948;</span>;
  if (rank === 2) return <span className="text-lg leading-none drop-shadow-[0_0_4px_rgba(205,127,50,0.5)]">&#x1F949;</span>;
  return <span className="text-sm text-dim font-semibold mono-nums">#{rank + 1}</span>;
}

export default function ArenaPage() {
  const { monadTestnet } = useNetwork();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [pnlMap, setPnlMap] = useState<Record<string, number>>({});
  const [openPositionsMap, setOpenPositionsMap] = useState<Record<string, number>>({});
  const [historyMap, setHistoryMap] = useState<Record<string, PnlPoint[]>>({});
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number>(Date.now());
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<TimeframeKey>("15m");
  const [chartMode, setChartMode] = useState<"all" | "focus">("all");

  useEffect(() => {
    let mounted = true;
    const fetchAgents = async () => {
      try {
        const network = monadTestnet ? "testnet" : "mainnet";
        const res = await fetch(`/api/agents?network=${network}`);
        const data = await res.json();
        if (!mounted) return;
        setAgents(data.agents || []);
        setUpdatedAt(Date.now());
      } catch { /* keep previous state */ } finally {
        if (mounted) setLoading(false);
      }
    };
    fetchAgents();
    const interval = setInterval(fetchAgents, TICK_INTERVAL_MS);
    return () => { mounted = false; clearInterval(interval); };
  }, [monadTestnet]);

  useEffect(() => {
    if (agents.length === 0) return;
    let cancelled = false;
    const queue = [...agents];
    const concurrency = Math.min(4, queue.length);
    const fetchPnlSnapshot = async () => {
      const updates: Record<string, number> = {};
      const openPositionUpdates: Record<string, number> = {};
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
            if (cancelled) continue;
            if (typeof data.totalPnl === "number") updates[a.id] = data.totalPnl as number;
            if (typeof data.openPositions === "number") openPositionUpdates[a.id] = data.openPositions as number;
          } catch { /* non-critical */ }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => fetchOne()));
      if (cancelled) return;
      if (Object.keys(openPositionUpdates).length > 0) setOpenPositionsMap((prev) => ({ ...prev, ...openPositionUpdates }));
      if (Object.keys(updates).length === 0) return;
      const ts = Date.now();
      setPnlMap((prev) => ({ ...prev, ...updates }));
      setHistoryMap((prev) => {
        const nextMap = { ...prev };
        for (const [agentId, pnl] of Object.entries(updates)) {
          const current = nextMap[agentId] || [];
          nextMap[agentId] = [...current, { t: ts, v: pnl }].slice(-MAX_POINTS);
        }
        return nextMap;
      });
    };
    void fetchPnlSnapshot();
    return () => { cancelled = true; };
  }, [agents, updatedAt]);

  const getPnl = useCallback((a: Agent) => pnlMap[a.id] ?? a.totalPnl, [pnlMap]);
  const getOpenPositions = useCallback((a: Agent) => openPositionsMap[a.id] ?? 0, [openPositionsMap]);

  const arenaAgents = useMemo(
    () => agents.filter((a) => a.status === "active" || (a.status === "paused" && getOpenPositions(a) > 0)),
    [agents, getOpenPositions]
  );

  const ranked = useMemo(() => [...arenaAgents].sort((a, b) => getPnl(b) - getPnl(a)), [arenaAgents, getPnl]);
  const chartAgents = useMemo(() => ranked.slice(0, 6), [ranked]);

  useEffect(() => {
    if (!selectedAgentId && chartAgents.length > 0) { setSelectedAgentId(chartAgents[0].id); return; }
    if (selectedAgentId && !ranked.some((a) => a.id === selectedAgentId)) setSelectedAgentId(chartAgents[0]?.id ?? null);
  }, [chartAgents, ranked, selectedAgentId]);

  const selectedAgent = ranked.find((a) => a.id === selectedAgentId) || ranked[0] || null;

  const chartSeries = useMemo(() => {
    const visibleAgents = chartMode === "focus" && selectedAgent ? [selectedAgent] : chartAgents;
    const desiredPoints = TIMEFRAME_POINTS[timeframe];
    const withHistory = visibleAgents.map((agent) => ({
      agent,
      history: normalizeHistory(historyMap[agent.id] || [], desiredPoints, getPnl(agent)),
    }));
    const allValues = withHistory.flatMap((s) => s.history.map((p) => p.v));
    const rawMin = Math.min(0, ...allValues);
    const rawMax = Math.max(0, ...allValues);
    const base = Math.max(1, Math.abs(rawMin), Math.abs(rawMax));
    const margin = base * 0.15;
    let minValue = rawMin - margin;
    let maxValue = rawMax + margin;
    if (rawMin >= 0) minValue = Math.min(minValue, -base * 0.08);
    if (rawMax <= 0) maxValue = Math.max(maxValue, base * 0.08);
    const span = Math.max(0.0001, maxValue - minValue);
    const pointCount = Math.max(2, desiredPoints);

    const lines = withHistory.map((series, idx) => {
      const points = series.history.map((point, i) => ({
        x: 4 + (i / (pointCount - 1)) * 92,
        y: 92 - ((point.v - minValue) / span) * 84,
      }));
      const last = points[points.length - 1] || { x: 4, y: 92 };
      return {
        agent: series.agent,
        color: CHART_COLORS[idx % CHART_COLORS.length],
        path: buildSmoothPath(points),
        areaPath: buildAreaPath(points, 92),
        last,
        latestPnl: series.history[series.history.length - 1]?.v ?? 0,
      };
    });

    const zeroNormalized = (0 - minValue) / span;
    const zeroY = 92 - zeroNormalized * 84;
    return { lines, zeroY, minValue, maxValue };
  }, [chartAgents, chartMode, getPnl, historyMap, selectedAgent, timeframe]);

  const aggregatePnl = ranked.reduce((sum, a) => sum + getPnl(a), 0);
  const bestAgent = ranked[0];
  const worstAgent = ranked[ranked.length - 1];

  return (
    <div className="min-h-screen page-bg relative overflow-hidden">
      <div className="orb orb-green w-[500px] h-[500px] -top-[200px] right-[5%] fixed opacity-60" />
      <div className="orb orb-purple w-[450px] h-[450px] bottom-[5%] -left-[150px] fixed opacity-50" />

      <header className="glass sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-3 group">
              <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center group-hover:bg-accent/15 transition-all group-hover:border-accent/30 group-hover:shadow-[0_0_20px_rgba(48,232,160,0.1)]">
                <HyperclawIcon className="text-accent" size={24} />
              </div>
              <HyperclawLogo className="text-lg font-bold tracking-tight hidden sm:block" />
            </Link>
            <div className="hidden sm:flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-dim"><path d="M9 18l6-6-6-6" /></svg>
              <span className="text-sm font-semibold gradient-text">Live Arena</span>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <TelegramChatButton />
            <NetworkToggle />
            <Link href="/agents" className="btn-secondary px-4 py-2 text-sm hidden sm:inline-flex">All Agents</Link>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 md:py-8 relative z-10">
        {/* Hero Stats */}
        <section className="mb-6">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
            <div>
              <h1 className="text-3xl md:text-4xl font-extrabold mb-1.5 gradient-title tracking-tight">Live Arena</h1>
              <p className="text-sm text-muted max-w-lg">
                Real-time agent performance. Smooth PnL curves. Click any agent to inspect.
              </p>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent/10 border border-accent/20 text-accent text-[11px] font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              Live &middot; {new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="card p-4 flex flex-col justify-between">
              <p className="text-[11px] text-dim uppercase tracking-wider font-medium mb-2">Active Agents</p>
              <p className="text-2xl font-bold mono-nums">{ranked.length}</p>
            </div>
            <div className="card p-4 flex flex-col justify-between">
              <p className="text-[11px] text-dim uppercase tracking-wider font-medium mb-2">Aggregate PnL</p>
              <p className={`text-2xl font-bold mono-nums ${aggregatePnl >= 0 ? "text-success" : "text-danger"}`}>{formatUsd(aggregatePnl)}</p>
            </div>
            <div className="card p-4 flex flex-col justify-between">
              <p className="text-[11px] text-dim uppercase tracking-wider font-medium mb-2">Top Performer</p>
              <p className="text-sm font-semibold truncate">{bestAgent?.name ?? "---"}</p>
              {bestAgent && <p className={`text-lg font-bold mono-nums mt-0.5 ${getPnl(bestAgent) >= 0 ? "text-success" : "text-danger"}`}>{formatUsd(getPnl(bestAgent))}</p>}
            </div>
            <div className="card p-4 flex flex-col justify-between">
              <p className="text-[11px] text-dim uppercase tracking-wider font-medium mb-2">Needs Attention</p>
              <p className="text-sm font-semibold truncate">{worstAgent && ranked.length > 1 ? worstAgent.name : "---"}</p>
              {worstAgent && ranked.length > 1 && <p className={`text-lg font-bold mono-nums mt-0.5 ${getPnl(worstAgent) >= 0 ? "text-success" : "text-danger"}`}>{formatUsd(getPnl(worstAgent))}</p>}
            </div>
          </div>
        </section>

        {/* Main Grid */}
        <section className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-5">
          {/* Chart */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-[rgba(255,255,255,0.04)]">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-semibold">PnL Time-Series</h2>
                <div className="flex items-center gap-1">
                  {chartSeries.lines.map((line) => (
                    <button
                      key={line.agent.id}
                      type="button"
                      onClick={() => setSelectedAgentId(line.agent.id)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-medium transition-all ${
                        selectedAgentId === line.agent.id
                          ? "bg-white/10 text-foreground"
                          : "text-muted hover:text-foreground hover:bg-white/5"
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: line.color }} />
                      <span className="hidden md:inline truncate max-w-[80px]">{line.agent.name}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center bg-surface border border-card-border rounded-lg p-0.5">
                  {(["1m", "5m", "15m"] as TimeframeKey[]).map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => setTimeframe(tf)}
                      className={`px-2.5 py-1 rounded text-[10px] font-medium transition-all ${
                        timeframe === tf ? "bg-accent/15 text-accent border border-accent/20" : "text-muted hover:text-foreground border border-transparent"
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
                <div className="flex items-center bg-surface border border-card-border rounded-lg p-0.5">
                  {(["all", "focus"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setChartMode(m)}
                      className={`px-2.5 py-1 rounded text-[10px] font-medium capitalize transition-all ${
                        chartMode === m ? "bg-white/10 text-foreground" : "text-muted hover:text-foreground"
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {loading ? (
              <div className="h-[420px] md:h-[480px] bg-surface shimmer" />
            ) : chartSeries.lines.length === 0 ? (
              <div className="h-[420px] md:h-[480px] flex items-center justify-center text-sm text-muted">
                <div className="text-center">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-3 text-dim"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
                  <p>No agents in the arena yet</p>
                  <Link href="/agents/new" className="text-accent text-xs mt-2 inline-block hover:underline">Create your first agent</Link>
                </div>
              </div>
            ) : (
              <div className="h-[420px] md:h-[480px] relative overflow-hidden bg-[linear-gradient(180deg,#080a16_0%,#060810_50%,#060a10_100%)]">
                {/* Subtle dot grid */}
                <div className="absolute inset-0 pointer-events-none opacity-30" style={{
                  backgroundImage: "radial-gradient(rgba(255,255,255,0.12) 1px, transparent 1px)",
                  backgroundSize: "32px 32px",
                }} />

                {/* Ambient glow behind lines */}
                <div className="absolute inset-0 pointer-events-none">
                  {chartSeries.lines.slice(0, 3).map((line) => (
                    <div key={`glow-${line.agent.id}`} className="absolute rounded-full blur-[80px] opacity-20"
                      style={{
                        background: line.color,
                        width: "200px", height: "200px",
                        left: `${line.last.x}%`, top: `${line.last.y}%`,
                        transform: "translate(-50%, -50%)",
                        transition: `left ${CHART_TRANSITION_MS}ms linear, top ${CHART_TRANSITION_MS}ms linear`,
                      }}
                    />
                  ))}
                </div>

                {/* Y-axis labels */}
                <div className="absolute left-3 top-4 text-[9px] text-dim mono-nums opacity-60">
                  {formatAxisUsd(chartSeries.maxValue)}
                </div>
                <div className="absolute left-3 bottom-4 text-[9px] text-dim mono-nums opacity-60">
                  {formatAxisUsd(chartSeries.minValue)}
                </div>

                {/* Zero baseline */}
                <div className="absolute left-0 right-0 pointer-events-none" style={{ top: `${chartSeries.zeroY}%` }}>
                  <div className="h-px w-full" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.2) 15%, rgba(255,255,255,0.2) 85%, transparent)" }} />
                  <span className="absolute left-3 -translate-y-1/2 text-[9px] text-dim/60 mono-nums">$0</span>
                </div>

                {/* SVG chart */}
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
                  <defs>
                    {chartSeries.lines.map((line, idx) => (
                      <linearGradient key={`lg-${idx}`} id={`arena-grad-${idx}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={line.color} stopOpacity="0.25" />
                        <stop offset="100%" stopColor={line.color} stopOpacity="0" />
                      </linearGradient>
                    ))}
                    {chartSeries.lines.map((line, idx) => (
                      <linearGradient key={`stroke-${idx}`} id={`arena-stroke-${idx}`} x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor={line.color} stopOpacity="0.3" />
                        <stop offset="40%" stopColor={line.color} stopOpacity="0.8" />
                        <stop offset="100%" stopColor={line.color} stopOpacity="1" />
                      </linearGradient>
                    ))}
                    <filter id="glow-filter">
                      <feGaussianBlur stdDeviation="0.4" result="coloredBlur" />
                      <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                  </defs>

                  {/* Area fills */}
                  {chartSeries.lines.map((line, idx) => (
                    <path key={`area-${idx}`} d={line.areaPath} fill={`url(#arena-grad-${idx})`}
                      opacity={selectedAgentId === line.agent.id ? 0.6 : 0.15}
                      style={{ transition: `d ${CHART_TRANSITION_MS}ms linear, opacity 300ms` }}
                    />
                  ))}

                  {/* Line strokes */}
                  {chartSeries.lines.map((line, idx) => (
                    <path key={`line-${idx}`} d={line.path} fill="none"
                      stroke={`url(#arena-stroke-${idx})`}
                      strokeWidth={selectedAgentId === line.agent.id ? 0.7 : 0.4}
                      strokeLinecap="round" strokeLinejoin="round"
                      filter={selectedAgentId === line.agent.id ? "url(#glow-filter)" : undefined}
                      style={{ transition: `d ${CHART_TRANSITION_MS}ms linear, stroke-width 300ms` }}
                    />
                  ))}
                </svg>

                {/* Endpoint markers */}
                {chartSeries.lines.map((line) => {
                  const isActive = selectedAgentId === line.agent.id;
                  return (
                    <button
                      key={`dot-${line.agent.id}`}
                      type="button"
                      onClick={() => setSelectedAgentId(line.agent.id)}
                      className="absolute focus:outline-none group"
                      style={{
                        left: `${line.last.x}%`, top: `${line.last.y}%`,
                        transform: "translate(-50%, -50%)",
                        zIndex: isActive ? 40 : 25,
                        transition: `left ${CHART_TRANSITION_MS}ms linear, top ${CHART_TRANSITION_MS}ms linear`,
                        willChange: "left, top",
                      }}
                    >
                      {/* Pulse ring */}
                      <div className="absolute inset-0 rounded-full animate-ping opacity-30" style={{
                        background: line.color, width: isActive ? 20 : 14, height: isActive ? 20 : 14,
                        margin: "auto", top: 0, left: 0, right: 0, bottom: 0,
                      }} />
                      {/* Dot */}
                      <div className={`rounded-full border-2 relative ${isActive ? "border-white" : "border-white/50"}`}
                        style={{
                          width: isActive ? 14 : 10, height: isActive ? 14 : 10,
                          background: line.color,
                          boxShadow: `0 0 ${isActive ? 20 : 10}px ${line.color}88`,
                        }}
                      />
                      {/* Floating label */}
                      <div className={`absolute whitespace-nowrap pointer-events-none transition-all duration-200 ${
                        isActive ? "opacity-100 scale-100" : "opacity-0 scale-95 group-hover:opacity-100 group-hover:scale-100"
                      }`}
                        style={{
                          left: line.last.x > 75 ? "auto" : "calc(100% + 10px)",
                          right: line.last.x > 75 ? "calc(100% + 10px)" : "auto",
                          top: "50%", transform: "translateY(-50%)",
                        }}
                      >
                        <div className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium backdrop-blur-md bg-card/90 border border-white/15 shadow-xl">
                          <span className="font-semibold">{line.agent.name}</span>
                          <span className={`ml-2 mono-nums ${line.latestPnl >= 0 ? "text-success" : "text-danger"}`}>
                            {formatUsd(line.latestPnl)}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Leaderboard + Selected Agent */}
          <div className="space-y-4">
            {/* Leaderboard */}
            <div className="card overflow-hidden">
              <div className="px-5 py-3.5 border-b border-[rgba(255,255,255,0.04)]">
                <h2 className="text-sm font-semibold">Leaderboard</h2>
              </div>
              <div className="divide-y divide-[rgba(255,255,255,0.04)]">
                {ranked.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted">No active agents</div>
                ) : ranked.map((agent, idx) => {
                  const pnl = getPnl(agent);
                  const isSelected = selectedAgentId === agent.id;
                  const color = CHART_COLORS[chartAgents.findIndex((a) => a.id === agent.id)] ?? "#8AA4FF";
                  const mode = AUTONOMY_META[agent.autonomy?.mode ?? "manual"];
                  const positions = getOpenPositions(agent);

                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => setSelectedAgentId(agent.id)}
                      className={`w-full px-5 py-3.5 flex items-center gap-3 transition-all text-left group ${
                        isSelected
                          ? "bg-white/[0.04]"
                          : "hover:bg-white/[0.02]"
                      }`}
                    >
                      {/* Rank */}
                      <div className="w-8 shrink-0 flex items-center justify-center">
                        <MedalIcon rank={idx} />
                      </div>

                      {/* Avatar */}
                      <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0 border border-white/[0.06] group-hover:border-white/10 transition-colors"
                        style={{ boxShadow: isSelected ? `0 0 16px ${color}22` : undefined }}
                      >
                        <AgentAvatar name={agent.name} description={agent.description} size={40} />
                      </div>

                      {/* Name + Meta */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold truncate">{agent.name}</span>
                          {agent.status === "paused" && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-warning/10 text-warning border border-warning/20 font-medium uppercase tracking-wider">Paused</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-dim flex items-center gap-1">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={mode.icon} /></svg>
                            {mode.label}
                          </span>
                          {positions > 0 && (
                            <span className="text-[10px] text-accent/80 flex items-center gap-0.5">
                              <span className="w-1 h-1 rounded-full bg-accent/60" />
                              {positions} open
                            </span>
                          )}
                          <span className="text-[10px] text-dim">{(agent.winRate * 100).toFixed(0)}% win</span>
                        </div>
                      </div>

                      {/* PnL */}
                      <div className="text-right shrink-0">
                        <p className={`text-sm font-bold mono-nums ${pnl >= 0 ? "text-success" : "text-danger"}`}>{formatUsd(pnl)}</p>
                        <p className="text-[10px] text-dim mono-nums">{agent.totalTrades} trades</p>
                      </div>

                      {/* Color indicator */}
                      <div className="w-1 h-8 rounded-full shrink-0 opacity-60" style={{ background: color }} />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Selected Agent Detail */}
            {selectedAgent && (
              <div className="card overflow-hidden">
                <div className="px-5 py-3.5 border-b border-[rgba(255,255,255,0.04)] flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Agent Detail</h2>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    selectedAgent.status === "active"
                      ? "bg-success/10 text-success border border-success/20"
                      : "bg-warning/10 text-warning border border-warning/20"
                  }`}>
                    {selectedAgent.status}
                  </span>
                </div>
                <div className="p-5">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-14 h-14 rounded-2xl overflow-hidden border border-white/[0.08] shrink-0 shadow-lg">
                      <AgentAvatar name={selectedAgent.name} description={selectedAgent.description} size={56} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-bold truncate">{selectedAgent.name}</p>
                      <p className="text-xs text-muted truncate">{selectedAgent.description || "Trading agent"}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div className="bg-surface rounded-xl p-3 border border-card-border">
                      <p className="text-[10px] text-dim uppercase tracking-wider mb-1">PnL</p>
                      <p className={`text-lg font-bold mono-nums ${getPnl(selectedAgent) >= 0 ? "text-success" : "text-danger"}`}>
                        {formatUsd(getPnl(selectedAgent))}
                      </p>
                    </div>
                    <div className="bg-surface rounded-xl p-3 border border-card-border">
                      <p className="text-[10px] text-dim uppercase tracking-wider mb-1">Win Rate</p>
                      <p className="text-lg font-bold mono-nums">{(selectedAgent.winRate * 100).toFixed(1)}%</p>
                    </div>
                    {selectedAgent.vaultSocial?.isOpenVault ? (
                      <div className="bg-surface rounded-xl p-3 border border-card-border">
                        <p className="text-[10px] text-dim uppercase tracking-wider mb-1">Vault TVL</p>
                        <p className="text-lg font-bold mono-nums">${selectedAgent.vaultTvlUsd.toLocaleString()}</p>
                      </div>
                    ) : null}
                    <div className="bg-surface rounded-xl p-3 border border-card-border">
                      <p className="text-[10px] text-dim uppercase tracking-wider mb-1">Markets</p>
                      <p className="text-sm font-semibold truncate">{selectedAgent.markets.join(", ")}</p>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Link href={`/agents/${selectedAgent.id}`} className="btn-primary flex-1 py-2.5 text-sm text-center font-semibold">
                      Join Vault
                    </Link>
                    <Link href={`/agents/${selectedAgent.id}`} className="btn-secondary flex-1 py-2.5 text-sm text-center">
                      View Details
                    </Link>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
