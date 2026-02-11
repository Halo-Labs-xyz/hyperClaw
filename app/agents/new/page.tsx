"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { NetworkToggle } from "@/app/components/NetworkToggle";
import { HyperclawIcon } from "@/app/components/HyperclawIcon";
import type { AutonomyMode } from "@/lib/types";
import type { PerpMarketInfo, SpotMarketInfo } from "@/lib/hyperliquid";

const RISK_CONFIG = {
  conservative: { color: "text-success", bg: "bg-success/10", border: "border-success/30", glow: "shadow-none" },
  moderate: { color: "text-warning", bg: "bg-warning/10", border: "border-warning/30", glow: "shadow-none" },
  aggressive: { color: "text-danger", bg: "bg-danger/10", border: "border-danger/30", glow: "shadow-none" },
} as const;

const AUTONOMY_MODES: { value: AutonomyMode; label: string; desc: string; icon: string; color: string; bg: string; border: string }[] = [
  {
    value: "manual",
    label: "Manual",
    desc: "You trigger every trade",
    icon: "👤",
    color: "text-muted",
    bg: "bg-muted/10",
    border: "border-muted/30",
  },
  {
    value: "semi",
    label: "Semi-Auto",
    desc: "Agent proposes, you approve",
    icon: "🤝",
    color: "text-accent",
    bg: "bg-accent/10",
    border: "border-accent/30",
  },
  {
    value: "full",
    label: "Full Auto",
    desc: "Agent trades on its own",
    icon: "🤖",
    color: "text-success",
    bg: "bg-success/10",
    border: "border-success/30",
  },
];

// Top perp markets shown first (pinned)
const PINNED_PERPS = ["BTC", "ETH", "SOL", "DOGE", "AVAX", "ARB", "OP", "LINK", "UNI", "AAVE"];

export default function CreateAgentPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [markets, setMarkets] = useState<string[]>(["BTC", "ETH"]);
  const [maxLeverage, setMaxLeverage] = useState(5);
  const [riskLevel, setRiskLevel] = useState<"conservative" | "moderate" | "aggressive">("moderate");
  const [stopLoss, setStopLoss] = useState(5);

  // Autonomy
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>("semi");
  const [aggressiveness, setAggressiveness] = useState(50);
  const [maxTradesPerDay, setMaxTradesPerDay] = useState(10);
  const [approvalTimeout, setApprovalTimeout] = useState(5); // minutes

  // Telegram
  const [telegramChatId, setTelegramChatId] = useState("");

  // Vault Social
  const [isOpenVault, setIsOpenVault] = useState(false);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  // Market data from Hyperliquid
  const [perpMarkets, setPerpMarkets] = useState<PerpMarketInfo[]>([]);
  const [spotMarkets, setSpotMarkets] = useState<SpotMarketInfo[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [marketSearch, setMarketSearch] = useState("");
  const [marketTab, setMarketTab] = useState<"perps" | "spot">("perps");
  const [showAllPerps, setShowAllPerps] = useState(false);

  // Fetch all markets on mount
  useEffect(() => {
    async function loadMarkets() {
      try {
        const res = await fetch("/api/market?action=all-markets");
        const data = await res.json();
        // Filter out delisted perps
        setPerpMarkets((data.perps || []).filter((p: PerpMarketInfo) => !p.isDelisted));
        // Show verified spot markets
        setSpotMarkets(data.spots || []);
      } catch {
        // Fallback if API fails
        setPerpMarkets([]);
        setSpotMarkets([]);
      } finally {
        setMarketsLoading(false);
      }
    }
    loadMarkets();
  }, []);

  // Filtered markets based on search + tab
  const filteredPerps = useMemo(() => {
    const q = marketSearch.toLowerCase().trim();
    const active = perpMarkets.filter((p) => !q || p.name.toLowerCase().includes(q));
    if (!showAllPerps && !q) {
      // Show pinned first, then rest
      const pinned = active.filter((p) => PINNED_PERPS.includes(p.name));
      const rest = active.filter((p) => !PINNED_PERPS.includes(p.name));
      // Sort pinned by PINNED_PERPS order
      pinned.sort((a, b) => PINNED_PERPS.indexOf(a.name) - PINNED_PERPS.indexOf(b.name));
      return [...pinned, ...rest.slice(0, 10)]; // Show pinned + 10 more
    }
    return active;
  }, [perpMarkets, marketSearch, showAllPerps]);

  const filteredSpots = useMemo(() => {
    const q = marketSearch.toLowerCase().trim();
    return spotMarkets.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [spotMarkets, marketSearch]);

  const verifiedSpots = useMemo(
    () => filteredSpots.filter((s) => s.isCanonical),
    [filteredSpots]
  );
  const unverifiedSpots = useMemo(
    () => filteredSpots.filter((s) => !s.isCanonical),
    [filteredSpots]
  );

  const toggleMarket = (m: string) => {
    setMarkets((prev) => prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]);
  };

  const selectAllPerps = () => {
    const perpNames = perpMarkets.filter((p) => !p.isDelisted).map((p) => p.name);
    // Merge with existing selections (keep any spots that are selected)
    setMarkets((prev) => {
      const existing = new Set(prev);
      perpNames.forEach((n) => existing.add(n));
      return Array.from(existing);
    });
  };

  const deselectAllPerps = () => {
    const perpNames = new Set(perpMarkets.map((p) => p.name));
    setMarkets((prev) => prev.filter((m) => !perpNames.has(m)));
  };

  const selectAllVerifiedSpots = () => {
    const spotNames = verifiedSpots.map((s) => s.name);
    setMarkets((prev) => {
      const existing = new Set(prev);
      spotNames.forEach((n) => existing.add(n));
      return Array.from(existing);
    });
  };

  const deselectAllSpots = () => {
    const spotNames = new Set(spotMarkets.map((s) => s.name));
    setMarkets((prev) => prev.filter((m) => !spotNames.has(m)));
  };

  const allPerpsSelected = perpMarkets.length > 0 &&
    perpMarkets.filter((p) => !p.isDelisted).every((p) => markets.includes(p.name));
  const allVerifiedSpotsSelected = verifiedSpots.length > 0 &&
    verifiedSpots.every((s) => markets.includes(s.name));

  // Count selected by category
  const perpSelectedCount = markets.filter((m) => perpMarkets.some((p) => p.name === m)).length;
  const spotSelectedCount = markets.filter((m) => spotMarkets.some((s) => s.name === m)).length;

  // Derived values
  const minConfidence = 1 - (aggressiveness / 100) * 0.5;
  const aggressivenessLabel =
    aggressiveness <= 20 ? "Very Selective" :
    aggressiveness <= 40 ? "Selective" :
    aggressiveness <= 60 ? "Balanced" :
    aggressiveness <= 80 ? "Opportunistic" : "Maximum";

  const handleCreate = async () => {
    if (!name.trim()) { setError("Agent name is required"); return; }
    if (markets.length === 0) { setError("Select at least one market"); return; }
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          markets,
          maxLeverage,
          riskLevel,
          stopLossPercent: stopLoss,
          autonomy: {
            mode: autonomyMode,
            aggressiveness,
            maxTradesPerDay,
            approvalTimeoutMs: approvalTimeout * 60000,
          },
          telegramChatId: telegramChatId.trim() || undefined,
          isOpenVault,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data?.detail ?? data?.error ?? "Failed to create agent";
        throw new Error(msg);
      }
      const data = await res.json();
      router.push(`/agents/${data.agent.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create agent. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  const leveragePercent = ((maxLeverage - 1) / 49) * 100;
  const stopLossPercent = ((stopLoss - 1) / 24) * 100;
  const aggressivenessPercent = aggressiveness;

  return (
    <div className="min-h-screen page-bg relative overflow-hidden">
      {/* Ambient */}
      <div className="orb orb-purple w-[500px] h-[500px] -top-[200px] left-[20%] fixed" />
      <div className="orb orb-green w-[300px] h-[300px] bottom-[20%] right-[10%] fixed" />
      <div className="orb orb-purple w-[350px] h-[350px] bottom-[30%] right-[25%] fixed" />

      {/* Header */}
      <header className="glass sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-2 text-sm">
          <div className="flex items-center gap-2">
            <Link href="/" className="flex items-center gap-3 group shrink-0">
              <div className="w-9 h-9 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center group-hover:bg-accent/15 transition-colors">
                <HyperclawIcon className="text-accent" size={18} />
              </div>
            </Link>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-dim"><path d="M9 18l6-6-6-6" /></svg>
            <Link href="/agents" className="text-muted hover:text-foreground transition-colors">Agents</Link>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-dim"><path d="M9 18l6-6-6-6" /></svg>
            <span className="text-foreground font-medium">Create</span>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <NetworkToggle />
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-8 md:py-12 relative z-10">
        {/* Title */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-12 h-12 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
                <circle cx="12" cy="12" r="10" /><path d="M12 8v8m-4-4h8" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <h2 className="text-2xl md:text-3xl font-bold gradient-title">Create Agent</h2>
              <p className="text-muted text-sm">Configure an AI-powered perpetual futures trader</p>
            </div>
          </div>
        </div>

        <div className="space-y-8">
          {/* ═══════════ SECTION: Identity ═══════════ */}
          <div className="space-y-6">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-dim border-b border-card-border pb-2">Identity</h3>
            {/* Name */}
            <div>
              <label className="block text-xs font-medium text-muted uppercase tracking-wider mb-2.5">Agent Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Alpha Seeker"
                className="input w-full px-4 py-3.5"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-medium text-muted uppercase tracking-wider mb-2.5">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this agent do? What&apos;s its strategy?"
                rows={3}
                className="input w-full px-4 py-3.5 resize-none"
              />
            </div>
          </div>

          {/* ═══════════ SECTION: Autonomy ═══════════ */}
          <div className="space-y-6">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-dim border-b border-card-border pb-2">Autonomy</h3>

            {/* Autonomy Mode */}
            <div>
              <label className="block text-xs font-medium text-muted uppercase tracking-wider mb-2.5">Control Mode</label>
              <div className="grid grid-cols-3 gap-3">
                {AUTONOMY_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    onClick={() => setAutonomyMode(mode.value)}
                    className={`py-3.5 px-3 rounded-xl text-center transition-all ${
                      autonomyMode === mode.value
                        ? `${mode.bg} border ${mode.border} ${mode.color}`
                        : "bg-surface border border-card-border text-dim hover:text-muted"
                    }`}
                  >
                    <div className="text-xl mb-1">{mode.icon}</div>
                    <div className="text-sm font-medium">{mode.label}</div>
                    <div className="text-[10px] text-dim mt-0.5">{mode.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Aggressiveness */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <label className="text-xs font-medium text-muted uppercase tracking-wider">Aggressiveness</label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-dim">{aggressivenessLabel}</span>
                  <span className="text-sm font-bold mono-nums text-foreground">{aggressiveness}%</span>
                </div>
              </div>
              <div className="relative">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={aggressiveness}
                  onChange={(e) => setAggressiveness(Number(e.target.value))}
                  className="w-full h-1 bg-surface rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-glow [&::-webkit-slider-thumb]:cursor-pointer"
                />
                <div
                  className="absolute top-1/2 -translate-y-1/2 left-0 h-1 bg-accent/40 rounded-full pointer-events-none"
                  style={{ width: `${aggressivenessPercent}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-dim mt-2 mono-nums">
                <span>Selective</span>
                <span>Balanced</span>
                <span>Maximum</span>
              </div>
              <p className="text-[11px] text-dim mt-2">
                Min confidence to trade: <span className="text-accent mono-nums">{(minConfidence * 100).toFixed(0)}%</span>
                {" "} &mdash; {aggressiveness <= 30 ? "Only acts on high-conviction setups" : aggressiveness <= 70 ? "Balanced between conviction and opportunity" : "Trades on most signals above minimum threshold"}
              </p>
            </div>

            {/* Max trades per day */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted uppercase tracking-wider mb-2.5">Max Trades / Day</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={maxTradesPerDay}
                  onChange={(e) => setMaxTradesPerDay(Number(e.target.value))}
                  className="input w-full px-4 py-3"
                />
              </div>

              {/* Approval timeout (only for semi) */}
              {autonomyMode === "semi" && (
                <div>
                  <label className="block text-xs font-medium text-muted uppercase tracking-wider mb-2.5">Approval Timeout</label>
                  <div className="relative">
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={approvalTimeout}
                      onChange={(e) => setApprovalTimeout(Number(e.target.value))}
                      className="input w-full px-4 py-3 pr-12"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-dim">min</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ═══════════ SECTION: Trading ═══════════ */}
          <div className="space-y-6">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-dim border-b border-card-border pb-2">Trading</h3>

            {/* Markets */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <label className="text-xs font-medium text-muted uppercase tracking-wider">
                  Markets <span className="text-accent">({markets.length} selected)</span>
                </label>
              </div>

              {/* Search */}
              <div className="relative mb-3">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-3 top-1/2 -translate-y-1/2 text-dim">
                  <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                </svg>
                <input
                  type="text"
                  value={marketSearch}
                  onChange={(e) => setMarketSearch(e.target.value)}
                  placeholder="Search markets..."
                  className="input w-full pl-9 pr-4 py-2.5 text-xs"
                />
              </div>

              {/* Tabs: Perps / Spot */}
              <div className="flex gap-1 mb-3 bg-surface rounded-lg p-0.5">
                <button
                  onClick={() => setMarketTab("perps")}
                  className={`flex-1 py-2 rounded-md text-xs font-medium transition-all ${
                    marketTab === "perps"
                      ? "bg-accent/15 text-accent border border-accent/30"
                      : "text-dim hover:text-muted"
                  }`}
                >
                  Perpetuals
                  {perpSelectedCount > 0 && (
                    <span className="ml-1.5 bg-accent/20 text-accent text-[10px] px-1.5 py-0.5 rounded-full">
                      {perpSelectedCount}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setMarketTab("spot")}
                  className={`flex-1 py-2 rounded-md text-xs font-medium transition-all ${
                    marketTab === "spot"
                      ? "bg-accent/15 text-accent border border-accent/30"
                      : "text-dim hover:text-muted"
                  }`}
                >
                  Spot
                  {spotSelectedCount > 0 && (
                    <span className="ml-1.5 bg-accent/20 text-accent text-[10px] px-1.5 py-0.5 rounded-full">
                      {spotSelectedCount}
                    </span>
                  )}
                </button>
              </div>

              {marketsLoading ? (
                <div className="py-8 text-center text-dim text-xs animate-pulse">
                  Loading markets from Hyperliquid...
                </div>
              ) : marketTab === "perps" ? (
                /* ═══ Perp Markets ═══ */
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] text-dim">
                      {perpMarkets.filter((p) => !p.isDelisted).length} perpetual markets
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={allPerpsSelected ? deselectAllPerps : selectAllPerps}
                        className="text-[10px] text-accent hover:text-accent/80 transition-colors font-medium"
                      >
                        {allPerpsSelected ? "Deselect All" : "Select All"}
                      </button>
                      {!showAllPerps && !marketSearch && (
                        <button
                          onClick={() => setShowAllPerps(true)}
                          className="text-[10px] text-muted hover:text-foreground transition-colors"
                        >
                          Show All
                        </button>
                      )}
                      {showAllPerps && !marketSearch && (
                        <button
                          onClick={() => setShowAllPerps(false)}
                          className="text-[10px] text-muted hover:text-foreground transition-colors"
                        >
                          Show Less
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 max-h-[280px] overflow-y-auto p-0.5">
                    {filteredPerps.map((p) => (
                      <button
                        key={p.name}
                        onClick={() => toggleMarket(p.name)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1 ${
                          markets.includes(p.name)
                            ? "bg-accent/15 border border-accent/40 text-accent"
                            : "bg-surface border border-card-border text-dim hover:text-muted hover:border-accent/20"
                        }`}
                      >
                        {p.name}
                        <span className="text-[9px] text-dim opacity-60">{p.maxLeverage}x</span>
                      </button>
                    ))}
                  </div>
                  {!showAllPerps && !marketSearch && filteredPerps.length < perpMarkets.filter((p) => !p.isDelisted).length && (
                    <p className="text-[10px] text-dim mt-2">
                      Showing {filteredPerps.length} of {perpMarkets.filter((p) => !p.isDelisted).length} markets.{" "}
                      <button onClick={() => setShowAllPerps(true)} className="text-accent hover:underline">
                        Show all
                      </button>
                    </p>
                  )}
                </div>
              ) : (
                /* ═══ Spot Markets ═══ */
                <div>
                  {/* Verified Spot Markets */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-dim">Verified Markets</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-accent">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                        </svg>
                      </div>
                      <button
                        onClick={allVerifiedSpotsSelected ? deselectAllSpots : selectAllVerifiedSpots}
                        className="text-[10px] text-accent hover:text-accent/80 transition-colors font-medium"
                      >
                        {allVerifiedSpotsSelected ? "Deselect All" : "Select All Verified"}
                      </button>
                    </div>
                    {verifiedSpots.length === 0 ? (
                      <p className="text-[10px] text-dim py-3">No verified spot markets found{marketSearch ? " matching search" : ""}</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5 max-h-[200px] overflow-y-auto p-0.5">
                        {verifiedSpots.map((s) => (
                          <button
                            key={s.name}
                            onClick={() => toggleMarket(s.name)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1 ${
                              markets.includes(s.name)
                                ? "bg-success/15 border border-success/40 text-success"
                                : "bg-surface border border-card-border text-dim hover:text-muted hover:border-success/20"
                            }`}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={markets.includes(s.name) ? "text-success" : "text-dim/40"}>
                              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                            </svg>
                            {s.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Unverified Spot Markets */}
                  {unverifiedSpots.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1.5 mb-2">
                        <span className="text-[10px] text-dim">Other Spot Markets</span>
                        <span className="text-[9px] bg-warning/10 text-warning px-1.5 py-0.5 rounded-full border border-warning/20">
                          unverified
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 max-h-[160px] overflow-y-auto p-0.5">
                        {unverifiedSpots.slice(0, 50).map((s) => (
                          <button
                            key={s.name}
                            onClick={() => toggleMarket(s.name)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                              markets.includes(s.name)
                                ? "bg-warning/10 border border-warning/30 text-warning"
                                : "bg-surface border border-card-border text-dim hover:text-muted hover:border-warning/20"
                            }`}
                          >
                            {s.name}
                          </button>
                        ))}
                        {unverifiedSpots.length > 50 && (
                          <span className="px-3 py-1.5 text-[10px] text-dim">
                            +{unverifiedSpots.length - 50} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Selected summary */}
              {markets.length > 0 && (
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] text-dim">Selected:</span>
                  {markets.slice(0, 15).map((m) => (
                    <span
                      key={m}
                      className="inline-flex items-center gap-1 text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded border border-accent/20"
                    >
                      {m}
                      <button
                        onClick={() => toggleMarket(m)}
                        className="hover:text-danger transition-colors"
                      >
                        x
                      </button>
                    </span>
                  ))}
                  {markets.length > 15 && (
                    <span className="text-[10px] text-dim">+{markets.length - 15} more</span>
                  )}
                </div>
              )}
            </div>

            {/* Risk Level */}
            <div>
              <label className="block text-xs font-medium text-muted uppercase tracking-wider mb-2.5">Risk Level</label>
              <div className="grid grid-cols-3 gap-3">
                {(["conservative", "moderate", "aggressive"] as const).map((level) => {
                  const cfg = RISK_CONFIG[level];
                  return (
                    <button
                      key={level}
                      onClick={() => setRiskLevel(level)}
                      className={`py-3 rounded-xl text-sm font-medium transition-all capitalize ${
                        riskLevel === level
                          ? `${cfg.bg} border ${cfg.border} ${cfg.color}`
                          : "bg-surface border border-card-border text-dim hover:text-muted"
                      }`}
                    >
                      {level}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Max Leverage */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <label className="text-xs font-medium text-muted uppercase tracking-wider">Max Leverage</label>
                <span className="text-sm font-bold mono-nums text-foreground">{maxLeverage}x</span>
              </div>
              <div className="relative">
                <input
                  type="range"
                  min={1}
                  max={50}
                  value={maxLeverage}
                  onChange={(e) => setMaxLeverage(Number(e.target.value))}
                  className="w-full h-1 bg-surface rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-glow [&::-webkit-slider-thumb]:cursor-pointer"
                />
                <div
                  className="absolute top-1/2 -translate-y-1/2 left-0 h-1 bg-accent/40 rounded-full pointer-events-none"
                  style={{ width: `${leveragePercent}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-dim mt-2 mono-nums">
                <span>1x</span><span>25x</span><span>50x</span>
              </div>
            </div>

            {/* Stop Loss */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <label className="text-xs font-medium text-muted uppercase tracking-wider">Stop Loss</label>
                <span className="text-sm font-bold mono-nums text-foreground">{stopLoss}%</span>
              </div>
              <div className="relative">
                <input
                  type="range"
                  min={1}
                  max={25}
                  value={stopLoss}
                  onChange={(e) => setStopLoss(Number(e.target.value))}
                  className="w-full h-1 bg-surface rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-warning [&::-webkit-slider-thumb]:cursor-pointer"
                />
                <div
                  className="absolute top-1/2 -translate-y-1/2 left-0 h-1 bg-warning/40 rounded-full pointer-events-none"
                  style={{ width: `${stopLossPercent}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-dim mt-2 mono-nums">
                <span>1%</span><span>12%</span><span>25%</span>
              </div>
            </div>
          </div>

          {/* ═══════════ SECTION: Notifications ═══════════ */}
          <div className="space-y-6">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-dim border-b border-card-border pb-2">Telegram</h3>

            <div>
              <label className="block text-xs font-medium text-muted uppercase tracking-wider mb-2.5">Telegram Chat ID</label>
              <input
                type="text"
                value={telegramChatId}
                onChange={(e) => setTelegramChatId(e.target.value)}
                placeholder="e.g. 123456789"
                className="input w-full px-4 py-3.5"
              />
              <p className="text-[11px] text-dim mt-2">
                Message <span className="text-accent">@HyperclawBot</span> on Telegram with /start to get your Chat ID. The agent will send trade notifications, edge explanations, and approval requests here.
              </p>
            </div>
          </div>

          {/* ═══════════ SECTION: Vault Social ═══════════ */}
          <div className="space-y-6">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-dim border-b border-card-border pb-2">Vault &amp; Community</h3>

            <div className="card rounded-2xl p-5">
              <div className="flex items-center justify-between">
                <div className="flex-1 mr-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium">Open Vault</span>
                    {isOpenVault && <span className="text-[10px] bg-success/10 text-success px-2 py-0.5 rounded-full border border-success/20">Active</span>}
                  </div>
                  <p className="text-xs text-dim leading-relaxed">
                    Allow other users to deposit into your agent&apos;s vault. Creates a Telegram chat room where the agent discusses trades with investors, building a semi-autonomous community around your strategy.
                  </p>
                </div>
                <button
                  onClick={() => setIsOpenVault(!isOpenVault)}
                  className={`relative w-12 h-7 rounded-full transition-colors shrink-0 ${
                    isOpenVault ? "bg-accent" : "bg-surface border border-card-border"
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-6 h-6 rounded-full transition-all ${
                      isOpenVault ? "left-[22px] bg-background" : "left-0.5 bg-dim"
                    }`}
                  />
                </button>
              </div>

              {isOpenVault && (
                <div className="mt-4 pt-4 border-t border-card-border space-y-3">
                  <div className="p-3 rounded-xl bg-warning/5 border border-warning/20 text-xs">
                    <p className="font-semibold text-warning mb-1.5">Hyperliquid vault rules</p>
                    <ul className="text-muted space-y-1 list-disc list-inside">
                      <li>Deposit a minimum of 100 USDC from your account to open the vault.</li>
                      <li>As the leader, you must maintain greater than 5% of the liquidity in the vault at all times.</li>
                      <li>Leaders receive a 10% profit share.</li>
                      <li>The vault creation fee is 100 USDC. This fee is not refunded even if you close the vault.</li>
                    </ul>
                    <p className="text-dim mt-1.5">You cannot withdraw if it would cause your share to fall below 5%.</p>
                    <p className="text-dim mt-1">Note: the name and description of your vault are permanent and cannot be changed.</p>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent shrink-0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                    Agent posts trade proposals to the vault chat
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent shrink-0"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                    Investors can discuss strategies in the group
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent shrink-0"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
                    Agent answers investor questions via AI
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="bg-danger/10 border border-danger/20 rounded-xl p-4 text-sm text-danger flex items-center gap-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                <circle cx="12" cy="12" r="10" /><path d="M12 8v4m0 4h.01" strokeLinecap="round" />
              </svg>
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            onClick={handleCreate}
            disabled={creating}
            className="btn-primary w-full py-4 text-sm mt-2"
          >
            {creating ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                Creating Agent...
              </span>
            ) : "Launch Agent"}
          </button>

          {/* Summary preview */}
          <div className="card rounded-2xl p-5 mt-4">
            <h4 className="text-xs font-medium text-dim uppercase tracking-wider mb-3">Preview</h4>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="flex justify-between">
                <span className="text-dim">Name</span>
                <span className="font-medium text-foreground truncate ml-2">{name || "---"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Markets</span>
                <span className="font-medium text-accent">{markets.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Risk</span>
                <span className={`font-medium capitalize ${RISK_CONFIG[riskLevel].color}`}>{riskLevel}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Leverage</span>
                <span className="font-medium mono-nums">{maxLeverage}x</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Stop Loss</span>
                <span className="font-medium mono-nums">{stopLoss}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Mode</span>
                <span className="font-medium">{AUTONOMY_MODES.find((m) => m.value === autonomyMode)?.icon} {AUTONOMY_MODES.find((m) => m.value === autonomyMode)?.label}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Aggressiveness</span>
                <span className="font-medium mono-nums">{aggressiveness}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Telegram</span>
                <span className="font-medium">{telegramChatId ? "Connected" : "Not set"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Open Vault</span>
                <span className={`font-medium ${isOpenVault ? "text-success" : "text-dim"}`}>{isOpenVault ? "Yes" : "No"}</span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
