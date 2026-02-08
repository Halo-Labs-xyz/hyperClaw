"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { NetworkToggle } from "@/app/components/NetworkToggle";
import type { Agent } from "@/lib/types";

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "active" | "paused" | "stopped">("all");

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => setAgents(data.agents || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filtered = filter === "all" ? agents : agents.filter((a) => a.status === filter);

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {/* Ambient */}
      <div className="orb orb-green w-[400px] h-[400px] -top-[150px] right-[20%] fixed" />
      <div className="orb orb-purple w-[350px] h-[350px] bottom-[20%] -left-[100px] fixed" />

      {/* Header */}
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
              <span className="text-foreground font-medium">Agents</span>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <NetworkToggle />
            <Link href="/agents/new" className="btn-primary px-4 py-2 text-sm">
              + Create Agent
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 md:py-12 relative z-10">
        {/* Page title */}
        <div className="mb-8">
          <h2 className="text-2xl md:text-3xl font-bold mb-2">Trading Agents</h2>
          <p className="text-muted text-sm">
            Browse AI agents and deposit into their vaults to start earning
          </p>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-1 mb-8 bg-surface rounded-xl p-1 w-fit border border-card-border">
          {(["all", "active", "paused", "stopped"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-all capitalize ${
                filter === f
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {f}
              {f !== "all" && (
                <span className="ml-1.5 text-dim">
                  {agents.filter((a) => a.status === f).length}
                </span>
              )}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="card rounded-2xl p-6 h-56 shimmer" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="card rounded-2xl p-16 text-center">
            <div className="w-16 h-16 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto mb-6">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent">
                <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" strokeLinecap="round" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold mb-2">
              {filter === "all" ? "No agents yet" : `No ${filter} agents`}
            </h3>
            <p className="text-muted text-sm mb-6 max-w-sm mx-auto">
              {filter === "all"
                ? "Be the first to create an AI trading agent"
                : "Try a different filter or create a new agent"}
            </p>
            <Link href="/agents/new" className="btn-primary px-6 py-3 text-sm inline-block">
              Create Your First Agent
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((agent, idx) => (
              <Link key={agent.id} href={`/agents/${agent.id}`}>
                <div
                  className="glass-card p-5 md:p-6 cursor-pointer h-full flex flex-col animate-fade-in-up"
                  style={{ animationDelay: `${idx * 50}ms` }}
                >
                  {/* Header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-sm font-bold text-accent">
                        {agent.name.charAt(0)}
                      </div>
                      <div>
                        <h3 className="font-semibold text-sm">{agent.name}</h3>
                        <span className="text-xs text-accent-light">
                          {agent.markets.length > 5
                            ? `All Markets (${agent.markets.length})`
                            : agent.markets.join(", ")}
                        </span>
                      </div>
                    </div>
                    <span className={`chip ${
                      agent.status === "active" ? "chip-active" : agent.status === "paused" ? "chip-paused" : "chip-stopped"
                    }`}>
                      {agent.status === "active" && (
                        <span className="w-1.5 h-1.5 rounded-full bg-current pulse-live" />
                      )}
                      {agent.status}
                    </span>
                  </div>

                  {/* Description */}
                  <p className="text-xs text-muted mb-4 line-clamp-2 leading-relaxed flex-1">
                    {agent.description}
                  </p>

                  {/* Stats */}
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-dim">PnL</span>
                      <span className={`font-medium mono-nums ${agent.totalPnl >= 0 ? "text-success" : "text-danger"}`}>
                        {agent.totalPnl >= 0 ? "+" : ""}${agent.totalPnl.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-dim">Win Rate</span>
                      <span className="font-medium mono-nums">{(agent.winRate * 100).toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-dim">Vault TVL</span>
                      <span className="font-medium mono-nums">${agent.vaultTvlUsd.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-dim">Risk</span>
                      <span className={`font-medium capitalize ${
                        agent.riskLevel === "conservative" ? "text-success" : agent.riskLevel === "moderate" ? "text-warning" : "text-danger"
                      }`}>
                        {agent.riskLevel}
                      </span>
                    </div>
                  </div>

                  {/* Autonomy + Social Badges */}
                  <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                      agent.autonomy?.mode === "full" ? "bg-success/10 text-success border border-success/20" :
                      agent.autonomy?.mode === "semi" ? "bg-accent/10 text-accent border border-accent/20" :
                      "bg-muted/10 text-muted border border-muted/20"
                    }`}>
                      {agent.autonomy?.mode === "full" ? "🤖" : agent.autonomy?.mode === "semi" ? "🤝" : "👤"}
                      {agent.autonomy?.mode === "full" ? "Auto" : agent.autonomy?.mode === "semi" ? "Semi" : "Manual"}
                    </span>
                    {agent.telegram?.enabled && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#229ED9]/10 text-[#229ED9] border border-[#229ED9]/20">
                        TG
                      </span>
                    )}
                    {agent.vaultSocial?.isOpenVault && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-warning/10 text-warning border border-warning/20">
                        Open Vault
                      </span>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="mt-3 pt-3 border-t border-card-border flex items-center justify-between text-[11px] text-dim">
                    <span className="mono-nums">{agent.totalTrades} trades</span>
                    <span className="mono-nums">{agent.depositorCount} depositors</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
