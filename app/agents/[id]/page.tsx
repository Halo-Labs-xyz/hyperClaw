"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount } from "wagmi";
import { NetworkToggle } from "@/app/components/NetworkToggle";
import { useNetwork } from "@/app/components/NetworkContext";
import { HyperclawIcon } from "@/app/components/HyperclawIcon";
import { AgentAvatar } from "@/app/components/AgentAvatar";

type AgentSummary = {
  id: string;
  name: string;
  description: string;
  status: "active" | "paused" | "stopped";
  createdAt: number;
  markets: string[];
  maxLeverage: number;
  riskLevel: "conservative" | "moderate" | "aggressive";
  totalPnl: number;
  totalTrades: number;
  winRate: number;
  vaultTvlUsd: number;
};

function formatUsd(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function statusClass(status: AgentSummary["status"]): string {
  if (status === "active") return "chip-active";
  if (status === "paused") return "chip-paused";
  return "chip-stopped";
}

function riskClass(riskLevel: AgentSummary["riskLevel"]): string {
  if (riskLevel === "conservative") return "text-success";
  if (riskLevel === "moderate") return "text-warning";
  return "text-danger";
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }) {
  return (
    <div className="card rounded-2xl p-4 md:p-5">
      <div className="text-xs text-muted mb-2 uppercase tracking-wider">{label}</div>
      <div
        className={`text-lg md:text-xl font-bold mono-nums ${
          tone === "positive" ? "text-success" : tone === "negative" ? "text-danger" : "text-foreground"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string | string[] }>();
  const agentId = useMemo(() => {
    if (!params?.id) return "";
    return Array.isArray(params.id) ? params.id[0] : params.id;
  }, [params?.id]);

  const { user } = usePrivy();
  const { address } = useAccount();
  const { monadTestnet } = useNetwork();

  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!agentId) return;

    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError("");

      try {
        const headers: Record<string, string> = {};
        if (address) headers["x-owner-wallet-address"] = address.toLowerCase();
        if (user?.id) headers["x-owner-privy-id"] = user.id;

        const network = monadTestnet ? "testnet" : "mainnet";
        const res = await fetch(`/api/agents/${agentId}?view=summary&network=${network}`, {
          headers,
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error ?? "Failed to load agent");
        }

        if (!cancelled) {
          setAgent(data?.agent ?? null);
          setIsOwner(Boolean(data?.viewer?.isOwner));
        }
      } catch (error_) {
        if ((error_ as Error)?.name === "AbortError" || cancelled) return;
        console.error("Failed to load agent summary:", error_);
        setError((error_ as Error)?.message || "Failed to load agent");
        setAgent(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [address, agentId, monadTestnet, user?.id]);

  if (loading) {
    return (
      <div className="min-h-screen page-bg flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="min-h-screen page-bg relative overflow-hidden">
        <header className="glass sticky top-0 z-50">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
            <Link href="/agents" className="flex items-center gap-3 group">
              <div className="w-9 h-9 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center group-hover:bg-accent/15 transition-colors">
                <HyperclawIcon className="text-accent" size={18} />
              </div>
              <span className="text-sm font-semibold">Back to Agents</span>
            </Link>
          </div>
        </header>

        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-16">
          <div className="card rounded-2xl p-8 text-center">
            <h2 className="text-xl font-semibold mb-2">Agent unavailable</h2>
            <p className="text-sm text-muted">{error || "This agent is not available in explore mode."}</p>
          </div>
        </main>
      </div>
    );
  }

  const pnlTone = agent.totalPnl >= 0 ? "positive" : "negative";

  return (
    <div className="min-h-screen page-bg relative overflow-hidden">
      <div className="orb orb-green w-[380px] h-[380px] -top-[150px] right-[15%] fixed" />
      <div className="orb orb-purple w-[320px] h-[320px] bottom-[10%] -left-[120px] fixed" />

      <header className="glass sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link href="/agents" className="flex items-center gap-3 group">
            <div className="w-9 h-9 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center group-hover:bg-accent/15 transition-colors">
              <HyperclawIcon className="text-accent" size={18} />
            </div>
            <span className="text-sm font-semibold">Back to Agents</span>
          </Link>
          <NetworkToggle />
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 md:py-10 relative z-10">
        <section className="glass-card rounded-2xl p-5 md:p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-12 h-12 rounded-xl overflow-hidden border border-accent/20 shrink-0">
                <AgentAvatar name={agent.name} description={agent.description} size={48} />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-bold truncate">{agent.name}</h1>
                <p className="text-sm text-muted mt-1 line-clamp-2">{agent.description || "No description"}</p>
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <span className={`chip ${statusClass(agent.status)}`}>
                    {agent.status === "active" ? <span className="w-1.5 h-1.5 rounded-full bg-current pulse-live" /> : null}
                    {agent.status}
                  </span>
                  <span className={`text-xs font-medium capitalize ${riskClass(agent.riskLevel)}`}>
                    {agent.riskLevel}
                  </span>
                  {isOwner ? <span className="chip chip-active">Owner</span> : null}
                </div>
              </div>
            </div>
            <div className="text-xs text-dim mono-nums">
              Created {new Date(agent.createdAt).toLocaleDateString()}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-6">
          <StatCard label="Total PnL" value={formatUsd(agent.totalPnl)} tone={pnlTone} />
          <StatCard label="Vault TVL" value={`$${agent.vaultTvlUsd.toLocaleString()}`} />
          <StatCard label="Total Trades" value={String(agent.totalTrades)} />
          <StatCard label="Win Rate" value={`${(agent.winRate * 100).toFixed(1)}%`} />
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card rounded-2xl p-5">
            <h2 className="text-sm font-semibold mb-3">Markets</h2>
            <div className="flex flex-wrap gap-2">
              {agent.markets.map((market) => (
                <span key={market} className="px-2.5 py-1 rounded-lg border border-card-border bg-surface text-xs mono-nums">
                  {market}
                </span>
              ))}
            </div>
          </div>

          <div className="card rounded-2xl p-5">
            <h2 className="text-sm font-semibold mb-3">Strategy Profile</h2>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted">Risk Level</span>
                <span className={`font-medium capitalize ${riskClass(agent.riskLevel)}`}>{agent.riskLevel}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Max Leverage</span>
                <span className="font-medium mono-nums">{agent.maxLeverage}x</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Markets Traded</span>
                <span className="font-medium mono-nums">{agent.markets.length}</span>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
