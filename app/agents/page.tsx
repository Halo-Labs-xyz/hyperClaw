"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount } from "wagmi";
import { NetworkToggle } from "@/app/components/NetworkToggle";
import { useNetwork } from "@/app/components/NetworkContext";
import { HyperclawLogo } from "@/app/components/HyperclawLogo";
import { HyperclawIcon } from "@/app/components/HyperclawIcon";
import { AgentAvatar } from "@/app/components/AgentAvatar";

type ExploreAgent = {
  id: string;
  name: string;
  description: string;
  status: "active" | "paused" | "stopped";
  markets: string[];
  riskLevel: "conservative" | "moderate" | "aggressive";
};

function formatMarkets(markets: string[]): string {
  if (markets.length <= 3) return markets.join(", ");
  return `${markets.slice(0, 3).join(", ")} +${markets.length - 3}`;
}

function riskClass(riskLevel: ExploreAgent["riskLevel"]): string {
  if (riskLevel === "conservative") return "text-success";
  if (riskLevel === "moderate") return "text-warning";
  return "text-danger";
}

function statusClass(status: ExploreAgent["status"]): string {
  if (status === "active") return "chip-active";
  if (status === "paused") return "chip-paused";
  return "chip-stopped";
}

export default function AgentsPage() {
  const { user } = usePrivy();
  const { address, isConnected } = useAccount();
  const { monadTestnet } = useNetwork();
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [agents, setAgents] = useState<ExploreAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const canFilterMine = useMemo(() => Boolean(address || user?.id), [address, user?.id]);

  useEffect(() => {
    if (scope === "mine" && !canFilterMine) {
      setAgents([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError("");

      try {
        const params = new URLSearchParams({
          view: "explore",
          scope: scope === "mine" ? "owned" : "all",
          network: monadTestnet ? "testnet" : "mainnet",
        });

        const headers: Record<string, string> = {};
        if (address) headers["x-owner-wallet-address"] = address.toLowerCase();
        if (user?.id) headers["x-owner-privy-id"] = user.id;

        const res = await fetch(`/api/agents?${params.toString()}`, {
          headers,
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error ?? "Failed to load agents");
        }

        if (!cancelled) {
          setAgents(Array.isArray(data?.agents) ? data.agents : []);
        }
      } catch (error_) {
        if ((error_ as Error)?.name === "AbortError" || cancelled) return;
        console.error("Failed to load explore agents:", error_);
        setAgents([]);
        setError("Failed to load agents");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [address, canFilterMine, monadTestnet, scope, user?.id]);

  const emptyTitle = scope === "mine" ? "No owned agents" : "No active agents";
  const emptyCopy = scope === "mine"
    ? "Create an agent with your connected wallet to see it here."
    : "No active agents are available right now.";

  return (
    <div className="min-h-screen page-bg relative overflow-hidden">
      <div className="orb orb-green w-[400px] h-[400px] -top-[150px] right-[20%] fixed" />
      <div className="orb orb-purple w-[350px] h-[350px] bottom-[20%] -left-[100px] fixed" />

      <header className="glass sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-3 group">
<div className="w-11 h-11 rounded-lg bg-white/20 border border-white/30 flex items-center justify-center group-hover:bg-white/25 transition-colors">
              <HyperclawIcon className="text-accent" size={28} />
              </div>
              <HyperclawLogo className="text-lg font-bold tracking-tight" />
            </Link>
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
        <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl md:text-3xl font-bold mb-2 gradient-title">Explore Agents</h2>
            <p className="text-muted text-sm">All Active shows public active agents. My Agents includes your paused and stopped agents.</p>
          </div>

          <div className="flex items-center gap-1 bg-surface rounded-xl p-1 border border-card-border w-fit">
            <button
              onClick={() => setScope("all")}
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                scope === "all" ? "bg-card text-foreground shadow-sm" : "text-muted hover:text-foreground"
              }`}
            >
              All Active
            </button>
            <button
              onClick={() => setScope("mine")}
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                scope === "mine" ? "bg-card text-foreground shadow-sm" : "text-muted hover:text-foreground"
              }`}
            >
              My Agents
            </button>
          </div>
        </div>

        {!canFilterMine && scope === "mine" && (
          <div className="mb-6 p-3 rounded-lg border border-card-border bg-surface text-xs text-muted">
            Connect your wallet to filter by your created agents.
          </div>
        )}

        {error && (
          <div className="mb-6 p-3 rounded-lg border border-danger/30 bg-danger/10 text-xs text-danger">
            {error}
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="card rounded-2xl p-6 h-44 shimmer" />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <div className="card rounded-2xl p-16 text-center">
            <h3 className="text-lg font-semibold mb-2">{emptyTitle}</h3>
            <p className="text-muted text-sm mb-6 max-w-sm mx-auto">{emptyCopy}</p>
            {scope === "mine" && isConnected ? (
              <Link href="/agents/new" className="btn-primary px-6 py-3 text-sm inline-block">
                Create Agent
              </Link>
            ) : null}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.map((agent, idx) => (
              <Link key={agent.id} href={`/agents/${agent.id}`}>
                <div
                  className="glass-card p-5 md:p-6 cursor-pointer h-full flex flex-col animate-fade-in-up"
                  style={{ animationDelay: `${idx * 35}ms` }}
                >
                  <div className="flex items-start gap-3 mb-3">
                    <div className="w-10 h-10 rounded-xl overflow-hidden border border-accent/20 shrink-0">
                      <AgentAvatar name={agent.name} description={agent.description} size={40} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-semibold text-sm truncate">{agent.name}</h3>
                      <p className="text-xs text-accent-light truncate">{formatMarkets(agent.markets)}</p>
                    </div>
                  </div>

                  <p className="text-xs text-muted line-clamp-2 leading-relaxed mb-4 flex-1">
                    {agent.description || "No description"}
                  </p>

                  <div className="pt-3 border-t border-card-border flex items-center justify-between text-[11px]">
                    <span className={`chip ${statusClass(agent.status)}`}>
                      {agent.status === "active" ? <span className="w-1.5 h-1.5 rounded-full bg-current pulse-live" /> : null}
                      {agent.status}
                    </span>
                    <span className={`font-medium capitalize ${riskClass(agent.riskLevel)}`}>
                      {agent.riskLevel}
                    </span>
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
