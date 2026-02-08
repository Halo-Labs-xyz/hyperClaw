"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useAccount, useBalance } from "wagmi";
import { useState, useEffect } from "react";
import { InstallPWA } from "./components/InstallPWA";
import { NetworkToggle } from "./components/NetworkToggle";
import Link from "next/link";
import type { Agent, HclawState } from "@/lib/types";

export default function Dashboard() {
  const { ready, login } = usePrivy();
  const { address, isConnected } = useAccount();
  const { data: balance } = useBalance({ address });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [hclawState, setHclawState] = useState<HclawState | null>(null);
  const [loading, setLoading] = useState(true);

  // HL wallet state
  const [hlStatus, setHlStatus] = useState<{
    network: string;
    configured: boolean;
    vaultAddress: string | null;
  } | null>(null);
  const [agentWallets, setAgentWallets] = useState<Array<{
    agentId: string;
    agentName: string;
    hasWallet: boolean;
    address?: string;
    accountValue?: string;
    availableBalance?: string;
  }>>([]);

  useEffect(() => {
    async function fetchData() {
      try {
        // Initialize agent lifecycle on app load (starts all active agents)
        fetch("/api/startup").catch(() => {});
        
        const [agentsRes, tokenRes] = await Promise.all([
          fetch("/api/agents").then((r) => r.json()),
          fetch("/api/token").then((r) => r.json()),
        ]);
        setAgents(agentsRes.agents || []);
        if (tokenRes.configured) setHclawState(tokenRes);

        // Fetch HL status
        try {
          const statusRes = await fetch("/api/fund", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "status" }),
          });
          const statusData = await statusRes.json();
          setHlStatus(statusData);

          // Operator balance is derived from agent wallets below
        } catch {
          // non-critical
        }

        // Fetch HL wallets for each agent
        const agentList = agentsRes.agents || [];
        if (agentList.length > 0) {
          const walletPromises = agentList.map(async (a: Agent) => {
            try {
              const res = await fetch("/api/fund", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "agent-balance", agentId: a.id }),
              });
              const data = await res.json();
              return {
                agentId: a.id,
                agentName: a.name,
                hasWallet: data.hasWallet || false,
                address: data.address,
                accountValue: data.accountValue,
                availableBalance: data.availableBalance,
              };
            } catch {
              return { agentId: a.id, agentName: a.name, hasWallet: false };
            }
          });
          const wallets = await Promise.all(walletPromises);
          setAgentWallets(wallets);
        }
      } catch (e) {
        console.error("Dashboard fetch error:", e);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          <span className="text-muted text-sm">Loading...</span>
        </div>
      </div>
    );
  }

  const totalTvl = agents.reduce((sum, a) => sum + a.vaultTvlUsd, 0);
  const totalPnl = agents.reduce((sum, a) => sum + a.totalPnl, 0);
  const activeAgents = agents.filter((a) => a.status === "active").length;

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {/* Ambient background orbs */}
      <div className="orb orb-green w-[600px] h-[600px] -top-[200px] -right-[200px] fixed" />
      <div className="orb orb-purple w-[500px] h-[500px] top-[60%] -left-[200px] fixed" />
      <div className="orb orb-green w-[300px] h-[300px] bottom-[10%] right-[10%] fixed" />

      {/* Header */}
      <header className="glass sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <div className="w-9 h-9 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center group-hover:bg-accent/15 transition-colors">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
                <path d="M6 3v12" /><path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M15 6a9 9 0 0 0-9 9" /><path d="M18 15v6" /><path d="M21 18h-6" />
              </svg>
            </div>
            <span className="text-lg font-bold tracking-tight gradient-text">Hyperclaw</span>
          </Link>

          <nav className="hidden md:flex items-center gap-1">
          { /*<Link href="/" className="btn-ghost px-3 py-2 text-sm text-foreground">Dashboard</Link>
            <Link href="/agents" className="btn-ghost px-3 py-2 text-sm">Agents</Link>
            <Link href="/monitor" className="btn-ghost px-3 py-2 text-sm">Monitor</Link>
            <Link href="/strategy" className="btn-ghost px-3 py-2 text-sm">Strategy</Link>
            <Link href="/agents/new" className="btn-ghost px-3 py-2 text-sm">Create</Link>*/}
          </nav>

          <div className="flex items-center gap-2 sm:gap-3">
            <NetworkToggle />
            {isConnected && address ? (
              <div className="flex items-center gap-2 sm:gap-3">
                <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface border border-card-border">
                  <div className="w-2 h-2 rounded-full bg-accent pulse-live" />
                  <span className="text-xs font-mono text-muted">
                    {address.slice(0, 6)}...{address.slice(-4)}
                  </span>
                </div>
                <div className="px-3 py-1.5 rounded-lg bg-accent/10 border border-accent/20">
                  <span className="text-sm font-semibold mono-nums text-accent">
                    {balance
                      ? `${parseFloat(balance.formatted).toFixed(3)} MON`
                      : "..."}
                  </span>
                </div>
              </div>
            ) : (
              <button
                onClick={login}
                className="btn-primary px-5 py-2.5 text-sm"
              >
                Connect Wallet
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 pb-24 relative z-10">
        {/* Hero */}
        <section className="pt-16 pb-12 md:pt-24 md:pb-16 text-center relative">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-accent/10 border border-accent/20 text-accent text-xs font-medium mb-8 animate-fade-in-up">
            <div className="w-1.5 h-1.5 rounded-full bg-accent pulse-live" />
            Powered by Monad + Hyperliquid
          </div>
          <h2 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight mb-6 animate-fade-in-up animate-delay-100">
            <span className="text-foreground">AI Agents</span>
            <br />
            <span className="gradient-text">Trading Perps</span>
          </h2>
          <p className="text-base sm:text-lg text-muted max-w-xl mx-auto leading-relaxed animate-fade-in-up animate-delay-200">
            Deposit Monad assets. AI agents trade perpetual futures on Hyperliquid autonomously. Withdraw with profits anytime.
          </p>
          <div className="flex items-center justify-center gap-3 mt-10 animate-fade-in-up animate-delay-300">
            <Link href="/agents" className="btn-primary px-6 py-3 text-sm">
              Explore Agents
            </Link>
            <Link href="/agents/new" className="btn-secondary px-6 py-3 text-sm">
              Create Agent
            </Link>
          </div>
        </section>

        {/* Stats */}
        <section className="grid grid-cols-2 md:grid-cols-5 gap-3 md:gap-4 mb-12 animate-fade-in-up animate-delay-400">
          <StatCard label="Total TVL" value={`$${totalTvl.toLocaleString()}`} />
          <StatCard
            label="Total PnL"
            value={`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toLocaleString()}`}
            variant={totalPnl >= 0 ? "success" : "danger"}
          />
          <StatCard label="Active Agents" value={String(activeAgents)} variant="purple" />
          <StatCard
            label="HL Capital"
            value={`$${agentWallets
              .reduce((sum, w) => sum + parseFloat(w.accountValue || "0"), 0)
              .toFixed(2)}`}
            variant="purple"
          />
          <StatCard
            label="Your Balance"
            value={balance ? `${parseFloat(balance.formatted).toFixed(2)} MON` : "---"}
          />
        </section>

        {/* Hyperliquid Wallets */}
        {(hlStatus || agentWallets.length > 0) && (
          <section className="mb-12 animate-fade-in-up animate-delay-400">
            <div className="card rounded-2xl overflow-hidden">
              <div className="p-5 md:p-6 border-b border-card-border">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-cyan/10 border border-cyan/20 flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-cyan">
                        <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4z" />
                      </svg>
                    </div>
                    <div>
                      <h3 className="font-semibold text-sm">Agent Wallets</h3>
                      <p className="text-xs text-muted">Agent trading accounts on HL {hlStatus?.network || "testnet"}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${hlStatus?.configured ? "bg-success pulse-live" : "bg-warning"}`} />
                    <span className="text-xs text-muted font-medium">
                      {hlStatus?.configured ? "Connected" : "Not configured"}
                    </span>
                  </div>
                </div>
              </div>

              {agentWallets.length > 0 ? (
                <div className="divide-y divide-card-border">
                  {agentWallets.map((w) => (
                    <div key={w.agentId} className="p-4 md:px-6 flex items-center justify-between hover:bg-surface/50 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
                          w.hasWallet
                            ? "bg-accent/10 border border-accent/20 text-accent"
                            : "bg-surface border border-card-border text-dim"
                        }`}>
                          {w.agentName.charAt(0)}
                        </div>
                        <div>
                          <div className="text-sm font-medium">{w.agentName}</div>
                          {w.hasWallet && w.address ? (
                            <span className="text-[10px] font-mono text-dim">
                              {w.address.slice(0, 6)}...{w.address.slice(-4)}
                            </span>
                          ) : (
                            <span className="text-[10px] text-dim">No HL wallet</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        {w.hasWallet ? (
                          <>
                            <div className="text-sm font-semibold mono-nums text-accent">
                              ${parseFloat(w.accountValue || "0").toFixed(2)}
                            </div>
                            <div className="text-[10px] text-dim mono-nums">
                              ${parseFloat(w.availableBalance || "0").toFixed(2)} avail
                            </div>
                          </>
                        ) : (
                          <span className="text-xs text-dim">---</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-6 text-center text-sm text-dim">
                  {loading ? "Loading wallets..." : "No agent wallets yet. Deposit MON to auto-provision."}
                </div>
              )}

              {/* Summary footer */}
              {agentWallets.some((w) => w.hasWallet) && (
                <div className="p-4 md:px-6 border-t border-card-border bg-surface/30 flex items-center justify-between">
                  <span className="text-xs text-muted">
                    {agentWallets.filter((w) => w.hasWallet).length} of {agentWallets.length} agents funded
                  </span>
                  <span className="text-sm font-semibold mono-nums text-foreground">
                    Total: ${agentWallets
                      .reduce((sum, w) => sum + parseFloat(w.accountValue || "0"), 0)
                      .toFixed(2)}
                  </span>
                </div>
              )}
            </div>
          </section>
        )}

        {/* $HCLAW Flywheel */}
        <section className="mb-12">
          <div className="gradient-border">
            <div className="p-6 md:p-8 rounded-2xl">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-lg font-bold">$HCLAW Flywheel</h3>
                    <span className="chip chip-active text-[10px]">LIVE</span>
                  </div>
                  <p className="text-sm text-muted">
                    Token market cap scales vault deposit limits
                  </p>
                </div>
                {hclawState && (
                  <div className="text-left sm:text-right">
                    <div className="text-xs text-muted uppercase tracking-wider mb-1">Market Cap</div>
                    <div className="text-2xl font-bold mono-nums gradient-text">
                      ${hclawState.marketCap.toLocaleString()}
                    </div>
                  </div>
                )}
              </div>
              {hclawState ? (
                <div>
                  <div className="flex justify-between text-sm mb-3">
                    <span className="text-accent font-medium">
                      {hclawState.currentTier.name} Tier
                    </span>
                    <span className="text-muted mono-nums">
                      Max: ${hclawState.maxDepositPerVault.toLocaleString()}/vault
                    </span>
                  </div>
                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${hclawState.progressToNextTier}%` }}
                    />
                  </div>
                  {hclawState.nextTier && (
                    <p className="text-xs text-dim mt-3">
                      Next tier ({hclawState.nextTier.name}) unlocks at $
                      {hclawState.nextTier.minMcap.toLocaleString()} mcap --
                      cap increases to $
                      {hclawState.nextTier.maxDepositUsd.toLocaleString()}
                    </p>
                  )}
                </div>
              ) : (
                <div className="text-sm text-dim">
                  $HCLAW token not yet deployed. Deploy to activate the flywheel.
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Agents 
        <section className="mb-16">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-xl font-bold mb-1">Trading Agents</h3>
              <p className="text-sm text-muted">Autonomous AI strategies trading perpetual futures</p>
            </div>
            <Link href="/agents/new" className="btn-primary px-4 py-2 text-sm hidden sm:inline-flex">
              + Create Agent
            </Link>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="card rounded-2xl p-6 h-52 shimmer" />
              ))}
            </div>
          ) : agents.length === 0 ? (
            <div className="card rounded-2xl p-16 text-center">
              <div className="w-16 h-16 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto mb-6">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent">
                  <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" strokeLinecap="round" />
                </svg>
              </div>
              <h4 className="text-lg font-semibold mb-2">No agents yet</h4>
              <p className="text-muted text-sm mb-6 max-w-sm mx-auto">
                Create your first AI trading agent and watch it trade perpetual futures autonomously
              </p>
              <Link href="/agents/new" className="btn-primary px-6 py-3 text-sm inline-block">
                Create Agent
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {agents.map((agent) => {
                const wallet = agentWallets.find((w) => w.agentId === agent.id);
                return <AgentCard key={agent.id} agent={agent} hlWallet={wallet} />;
              })}
            </div>
          )}
        </section> */}

        {/* How It Works */}
        <section className="pb-8">
          <h3 className="text-xl font-bold mb-2 text-center">How It Works</h3>
          <p className="text-sm text-muted text-center mb-10">Three steps from deposit to profit</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
            <StepCard
              step="01"
              title="Deposit Monad Assets"
              description="Connect wallet. Deposit MON, WMON, or USDT into an agent vault on Monad."
              accent="green"
            />
            <StepCard
              step="02"
              title="AI Trades Hyperliquid"
              description="AI analyzes markets in real-time and executes perpetual futures trades autonomously."
              accent="purple"
            />
            <StepCard
              step="03"
              title="Withdraw Profits"
              description="Withdraw your proportional share plus any trading profits at any time."
              accent="cyan"
            />
          </div>
        </section>
      </main>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 glass border-t border-card-border">
        <div className="flex items-center justify-around py-2">
          <Link href="/" className="flex flex-col items-center gap-1 py-2 px-4">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span className="text-[10px] text-accent font-medium">Home</span>
          </Link>
          <Link href="/agents" className="flex flex-col items-center gap-1 py-2 px-4">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted">
              <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
            </svg>
            <span className="text-[10px] text-muted font-medium">Agents</span>
          </Link>
          <Link href="/agents/new" className="flex flex-col items-center gap-1 py-2 px-4">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted">
              <circle cx="12" cy="12" r="10" /><path d="M12 8v8m-4-4h8" />
            </svg>
            <span className="text-[10px] text-muted font-medium">Create</span>
          </Link>
        </div>
      </nav>

      <InstallPWA />
    </div>
  );
}

/* ============================================
   Sub-components
   ============================================ */

function StatCard({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant?: "success" | "danger" | "purple";
}) {
  return (
    <div className="card rounded-2xl p-4 md:p-5">
      <div className="text-xs text-muted mb-2 uppercase tracking-wider">{label}</div>
      <div
        className={`text-lg md:text-xl font-bold mono-nums ${
          variant === "success"
            ? "text-success"
            : variant === "danger"
            ? "text-danger"
            : variant === "purple"
            ? "text-accent-light"
            : "text-foreground"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function AgentCard({ agent, hlWallet }: {
  agent: Agent;
  hlWallet?: { hasWallet: boolean; address?: string; accountValue?: string; availableBalance?: string };
}) {
  return (
    <Link href={`/agents/${agent.id}`}>
      <div className="glass-card p-5 md:p-6 cursor-pointer h-full flex flex-col">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-sm font-bold text-accent">
              {agent.name.charAt(0)}
            </div>
            <div>
              <h4 className="font-semibold text-sm">{agent.name}</h4>
              <span className="text-xs text-muted">{agent.markets.join(", ")}</span>
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

        <p className="text-xs text-muted mb-4 line-clamp-2 leading-relaxed flex-1">
          {agent.description}
        </p>

        {/* HL Wallet Badge */}
        {hlWallet && hlWallet.hasWallet && (
          <div className="flex items-center gap-2 mb-3 px-2.5 py-1.5 rounded-lg bg-cyan/5 border border-cyan/15">
            <div className="w-1.5 h-1.5 rounded-full bg-cyan pulse-live" />
            <span className="text-[10px] font-mono text-cyan/80">
              HL {hlWallet.address?.slice(0, 6)}...{hlWallet.address?.slice(-4)}
            </span>
            <span className="text-[10px] font-semibold mono-nums text-cyan ml-auto">
              ${parseFloat(hlWallet.accountValue || "0").toFixed(2)}
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs pt-4 border-t border-card-border">
          <div className="flex justify-between">
            <span className="text-dim">PnL</span>
            <span className={`font-medium mono-nums ${agent.totalPnl >= 0 ? "text-success" : "text-danger"}`}>
              {agent.totalPnl >= 0 ? "+" : ""}${agent.totalPnl.toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-dim">TVL</span>
            <span className="font-medium mono-nums">${agent.vaultTvlUsd.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-dim">Trades</span>
            <span className="font-medium mono-nums">{agent.totalTrades}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-dim">Win Rate</span>
            <span className="font-medium mono-nums">{(agent.winRate * 100).toFixed(1)}%</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function StepCard({
  step,
  title,
  description,
  accent,
}: {
  step: string;
  title: string;
  description: string;
  accent: "green" | "purple" | "cyan";
}) {
  const colors = {
    green: { text: "text-accent", bg: "bg-accent/10", border: "border-accent/20" },
    purple: { text: "text-accent-light", bg: "bg-purple-dim", border: "border-accent-light/20" },
    cyan: { text: "text-cyan", bg: "bg-cyan/10", border: "border-cyan/20" },
  };
  const c = colors[accent];

  return (
    <div className="card rounded-2xl p-6 md:p-8 text-center relative overflow-hidden group">
      <div className={`w-12 h-12 rounded-xl ${c.bg} border ${c.border} flex items-center justify-center mx-auto mb-5`}>
        <span className={`text-sm font-bold font-mono ${c.text}`}>{step}</span>
      </div>
      <h4 className="font-semibold mb-2 text-sm">{title}</h4>
      <p className="text-xs text-muted leading-relaxed">{description}</p>
      {/* Subtle bottom accent line */}
      <div className={`absolute bottom-0 left-1/4 right-1/4 h-px ${
        accent === "green" ? "bg-accent/30" : accent === "purple" ? "bg-accent-light/30" : "bg-cyan/30"
      } group-hover:left-0 group-hover:right-0 transition-all duration-500`} />
    </div>
  );
}
