"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useAccount, useBalance, useSignMessage, useDisconnect } from "wagmi";
import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { HyperclawLogo } from "@/app/components/HyperclawLogo";
import { HyperclawIcon } from "@/app/components/HyperclawIcon";
import { AgentAvatar } from "@/app/components/AgentAvatar";
import type { Agent, HclawState } from "@/lib/types";

export default function Dashboard() {
  const { ready, authenticated, login, logout, linkWallet, user } = usePrivy();
  const { address, isConnected } = useAccount();
  const { data: balance } = useBalance({ address });
  const { signMessageAsync } = useSignMessage();
  const { disconnectAsync } = useDisconnect();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [hclawState, setHclawState] = useState<HclawState | null>(null);
  const [loading, setLoading] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "id" | "telegram" | "error">("idle");
  const [walletAuthState, setWalletAuthState] = useState<"idle" | "pending" | "verified" | "failed">("idle");
  const walletAuthInFlight = useRef(false);

  const [agentWallets, setAgentWallets] = useState<Array<{
    agentId: string;
    agentName: string;
    hasWallet: boolean;
    address?: string;
    accountValue?: string;
    availableBalance?: string;
    totalPnl?: number;
  }>>([]);

  // Phase 1: Fetch critical data (agents list + token state) — fast, unblocks render
  useEffect(() => {
    // Run startup init once per browser session to avoid repeated heavy calls.
    const startupKey = "hyperclaw-startup-init-v1";
    if (typeof window !== "undefined" && !sessionStorage.getItem(startupKey)) {
      sessionStorage.setItem(startupKey, "1");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      fetch("/api/startup", { signal: controller.signal })
        .catch(() => {})
        .finally(() => clearTimeout(timeoutId));
    }

    async function fetchCritical() {
      try {
        const [agentsRes, tokenRes] = await Promise.all([
          fetch("/api/agents").then((r) => r.json()).catch(() => ({ agents: [] })),
          fetch("/api/token").then((r) => r.json()).catch(() => ({ configured: false })),
        ]);
        setAgents(agentsRes.agents || []);
        if (tokenRes.configured) setHclawState(tokenRes);
      } catch (e) {
        console.error("Dashboard fetch error:", e);
      } finally {
        setLoading(false);
      }
    }
    fetchCritical();
  }, []);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;

    async function fetchUserHclawState() {
      try {
        const res = await fetch(`/api/hclaw/state?user=${address}`);
        const data = await res.json();
        if (cancelled) return;
        if (data?.state) {
          setHclawState(data.state);
        }
      } catch {
        // non-critical
      }
    }

    fetchUserHclawState();
    return () => {
      cancelled = true;
    };
  }, [address]);

  // Phase 2: Lazy-load HL wallet data after initial render (non-blocking)
  useEffect(() => {
    if (loading || agents.length === 0) return;

    let cancelled = false;
    async function fetchWallets() {
      // Fetch balances in bounded parallel batches to avoid long sequential timeouts.
      const queue = [...agents];
      const concurrency = Math.min(4, queue.length);

      const fetchOne = async () => {
        while (!cancelled) {
          const a = queue.shift();
          if (!a) return;

          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 7000);
            const res = await fetch("/api/fund", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "agent-balance", agentId: a.id, includePnl: true }),
              signal: controller.signal,
            }).finally(() => clearTimeout(timeoutId));

            const data = await res.json();
            if (!cancelled) {
              setAgentWallets((prev) => {
                const filtered = prev.filter((w) => w.agentId !== a.id);
                return [
                  ...filtered,
                  {
                    agentId: a.id,
                    agentName: a.name,
                    hasWallet: data.hasWallet || false,
                    address: data.address,
                    accountValue: data.accountValue,
                    availableBalance: data.availableBalance,
                    totalPnl: typeof data.totalPnl === "number" ? data.totalPnl : undefined,
                  },
                ];
              });
            }
          } catch {
            if (!cancelled) {
              setAgentWallets((prev) => {
                if (prev.some((w) => w.agentId === a.id)) return prev;
                return [...prev, { agentId: a.id, agentName: a.name, hasWallet: false }];
              });
            }
          }
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => fetchOne()));
    }
    fetchWallets();
    return () => { cancelled = true; };
  }, [loading, agents]);

  useEffect(() => {
    if (!ready || !authenticated || !user?.id || !isConnected || !address) {
      if (!isConnected || !address) {
        setWalletAuthState("idle");
      }
      return;
    }
    if (walletAuthInFlight.current) return;

    const wallet = address.toLowerCase();
    const sessionKey = `hyperclaw-wallet-attested:${user.id}:${wallet}`;
    const cachedStatus =
      typeof window !== "undefined" ? window.sessionStorage.getItem(sessionKey) : null;

    if (cachedStatus === "verified") {
      setWalletAuthState("verified");
      return;
    }
    if (cachedStatus === "skipped") {
      setWalletAuthState("failed");
      return;
    }

    let cancelled = false;
    walletAuthInFlight.current = true;
    setWalletAuthState("pending");

    const run = async () => {
      try {
        const prepareRes = await fetch("/api/wallet/attest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "prepare",
            privyUserId: user.id,
            walletAddress: wallet,
          }),
        });
        const prepare = await prepareRes.json();
        if (!prepareRes.ok) {
          throw new Error(prepare?.error ?? "Failed to prepare wallet authorization");
        }

        if (prepare.attested) {
          if (!cancelled) {
            window.sessionStorage.setItem(sessionKey, "verified");
            setWalletAuthState("verified");
          }
          return;
        }

        const challengeId = String(prepare.challengeId || "");
        const message = String(prepare.message || "");
        if (!challengeId || !message) {
          throw new Error("Invalid wallet authorization challenge");
        }

        const signature = await signMessageAsync({ message });
        if (cancelled) return;

        const verifyRes = await fetch("/api/wallet/attest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "verify",
            challengeId,
            signature,
            privyUserId: user.id,
            walletAddress: wallet,
          }),
        });
        const verify = await verifyRes.json();
        if (!verifyRes.ok || !verify.success) {
          throw new Error(verify?.error ?? "Wallet authorization failed");
        }

        if (!cancelled) {
          window.sessionStorage.setItem(sessionKey, "verified");
          setWalletAuthState("verified");
        }
      } catch (error) {
        const message = String(error).toLowerCase();
        if (!cancelled) {
          if (
            message.includes("user rejected") ||
            message.includes("rejected request") ||
            message.includes("denied")
          ) {
            window.sessionStorage.setItem(sessionKey, "skipped");
          }
          setWalletAuthState("failed");
        }
      } finally {
        walletAuthInFlight.current = false;
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, user?.id, isConnected, address, signMessageAsync]);

  const privyId = user?.id ?? "";

  const copyText = useCallback(async (text: string, kind: "id" | "telegram") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState(kind);
    } catch (error) {
      console.error("Failed to copy text:", error);
      setCopyState("error");
    }
    window.setTimeout(() => setCopyState("idle"), 2000);
  }, []);

  const handleCopyPrivyId = useCallback(() => {
    if (!privyId) return;
    void copyText(privyId, "id");
  }, [copyText, privyId]);

  const handleCopyTelegramLink = useCallback(() => {
    if (!privyId) return;
    void copyText(`link ${privyId}`, "telegram");
  }, [copyText, privyId]);

  const handleDisconnect = useCallback(async () => {
    const [walletDisconnect, privyLogout] = await Promise.allSettled([
      disconnectAsync(),
      logout(),
    ]);
    if (walletDisconnect.status === "rejected") {
      console.error("Failed to disconnect wagmi wallet:", walletDisconnect.reason);
    }
    if (privyLogout.status === "rejected") {
      console.error("Failed to disconnect wallet session:", privyLogout.reason);
    }
    setWalletAuthState("idle");
  }, [disconnectAsync, logout]);

  const handleConnectNewWallet = useCallback(() => {
    if (authenticated) {
      linkWallet();
      return;
    }
    login();
  }, [authenticated, linkWallet, login]);

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
  const totalPnl = (() => {
    const fromWallets = agentWallets.reduce(
      (sum, w) => sum + (typeof w.totalPnl === "number" ? w.totalPnl : 0),
      0
    );
    if (agentWallets.some((w) => typeof w.totalPnl === "number")) return fromWallets;
    return agents.reduce((sum, a) => sum + a.totalPnl, 0);
  })();
  const activeAgents = agents.filter((a) => a.status === "active").length;
  const walletAuthLabel =
    walletAuthState === "verified"
      ? "Authorized"
      : walletAuthState === "pending"
      ? "Authorizing..."
      : walletAuthState === "failed"
      ? "Pending Signature"
      : "Not Started";
  const walletAuthClass =
    walletAuthState === "verified"
      ? "text-success"
      : walletAuthState === "pending"
      ? "text-warning"
      : walletAuthState === "failed"
      ? "text-danger"
      : "text-dim";

  return (
    <div className="min-h-screen page-bg relative overflow-hidden">
      {/* Ambient background orbs — green: Hyperliquid, purple: Monad */}
      <div className="orb orb-green w-[600px] h-[600px] -top-[200px] -right-[200px] fixed" />
      <div className="orb orb-purple w-[500px] h-[500px] top-[60%] -left-[200px] fixed" />
      <div className="orb orb-green w-[300px] h-[300px] bottom-[10%] right-[10%] fixed" />
      <div className="orb orb-purple w-[350px] h-[350px] top-[15%] left-[5%] fixed" />

      {/* Header */}
      <header className="glass sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <div className="w-9 h-9 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center group-hover:bg-accent/15 transition-colors">
              <HyperclawIcon className="text-accent" size={18} />
            </div>
            <HyperclawLogo className="text-lg font-bold tracking-tight" />
          </Link>

          <nav className="hidden md:flex items-center gap-1">
          { /*<Link href="/" className="btn-ghost px-3 py-2 text-sm text-foreground">Dashboard</Link>
            <Link href="/agents" className="btn-ghost px-3 py-2 text-sm">Agents</Link>
            <Link href="/monitor" className="btn-ghost px-3 py-2 text-sm">Monitor</Link>
            <Link href="/strategy" className="btn-ghost px-3 py-2 text-sm">Strategy</Link>
            <Link href="/agents/new" className="btn-ghost px-3 py-2 text-sm">Create</Link>*/}
          </nav>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden" />
            {isConnected && address ? (
              <div className="relative group">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface border border-card-border cursor-default">
                  <div className="w-2 h-2 rounded-full bg-accent pulse-live" />
                  <span className="text-xs font-mono text-muted">
                    {address.slice(0, 6)}...{address.slice(-4)}
                  </span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-dim">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </div>
                <div className="absolute right-0 top-full w-72 pt-2 opacity-0 invisible pointer-events-none transition-all duration-150 group-hover:opacity-100 group-hover:visible group-hover:pointer-events-auto">
                  <div className="p-3 rounded-xl bg-surface border border-card-border shadow-lg">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-wider text-dim">Balance</span>
                      <span className="text-xs font-semibold mono-nums text-accent">
                        {balance ? `${parseFloat(balance.formatted).toFixed(3)} MON` : "..."}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-[10px] uppercase tracking-wider text-dim">Wallet Auth</span>
                      <span className={`text-[11px] font-medium ${walletAuthClass}`}>
                        {walletAuthLabel}
                      </span>
                    </div>
                    {privyId && (
                      <div className="mb-3 p-2 rounded-lg bg-background border border-card-border">
                        <div className="text-[10px] uppercase tracking-wider text-dim mb-1">Privy ID</div>
                        <div className="text-[11px] font-mono text-muted break-all mb-2">{privyId}</div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleCopyPrivyId}
                            className="btn-secondary px-2 py-1 text-[11px]"
                          >
                            {copyState === "id" ? "Copied ID" : "Copy ID"}
                          </button>
                          <button
                            onClick={handleCopyTelegramLink}
                            className="btn-secondary px-2 py-1 text-[11px]"
                          >
                            {copyState === "telegram" ? "Copied Cmd" : "Copy TG Cmd"}
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { void handleDisconnect(); }}
                        className="w-full px-3 py-1.5 text-xs rounded-lg border border-danger/30 text-danger hover:bg-danger/10 transition-colors"
                      >
                        Disconnect
                      </button>
                    </div>
                    {copyState === "error" && (
                      <div className="text-xs text-danger mt-2">Copy failed</div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <button
                onClick={handleConnectNewWallet}
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
            Powered by Monad, Hyperliquid, and OpenClaw
          </div>
          <h2 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight mb-6 animate-fade-in-up animate-delay-100 gradient-title">
            Agents
            <br />
            Trading Perps
          </h2>
          <p className="text-base sm:text-lg text-muted max-w-xl mx-auto leading-relaxed animate-fade-in-up animate-delay-200">
            Deposit assets on Monad without losing exposure. Create agents to trade perps on Hyperliquid. Watch them compete against each other. Hold $HCLAW to increase deposit limits. Withdraw profits anytime.
          </p>
          <div className="flex items-center justify-center gap-3 mt-10 animate-fade-in-up animate-delay-300">
            <Link href="/arena" className="btn-secondary px-6 py-3 text-sm">
              Live Arena
            </Link>
            <Link href="/agents" className="btn-primary px-6 py-3 text-sm">
              Explore Agents
            </Link>
            <Link href="/agents/new" className="btn-secondary px-6 py-3 text-sm">
              Create Agent
            </Link>
            <Link href="/hclaw" className="btn-secondary px-6 py-3 text-sm">
              HCLAW Hub
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

        {/* $HCLAW Flywheel */}
        <section className="mb-12">
          <div className="gradient-border">
            <div className="p-6 md:p-8 rounded-2xl">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-lg font-bold gradient-title">$HCLAW Flywheel</h3>
                    <span className="chip chip-active text-[10px]">LIVE</span>
                  </div>
                  <p className="text-sm text-muted">
                    Market cap + Locked HCLAW power drive user-specific caps and rebates
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
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
                    <div className="p-3 rounded-xl bg-surface border border-card-border">
                      <div className="text-[10px] text-dim uppercase tracking-wider mb-1">Lock Tier</div>
                      <div className="text-sm font-semibold mono-nums">Tier {hclawState.lockTier ?? 0}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-surface border border-card-border">
                      <div className="text-[10px] text-dim uppercase tracking-wider mb-1">HCLAW Power</div>
                      <div className="text-sm font-semibold mono-nums">{(hclawState.hclawPower ?? 0).toFixed(2)}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-surface border border-card-border">
                      <div className="text-[10px] text-dim uppercase tracking-wider mb-1">Rebate Tier</div>
                      <div className="text-sm font-semibold mono-nums text-success">{((hclawState.rebateBps ?? 0) / 100).toFixed(2)}%</div>
                    </div>
                    <div className="p-3 rounded-xl bg-surface border border-card-border">
                      <div className="text-[10px] text-dim uppercase tracking-wider mb-1">Boosted Cap</div>
                      <div className="text-sm font-semibold mono-nums">${(hclawState.boostedCapUsd ?? hclawState.maxDepositPerVault).toLocaleString()}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-surface border border-card-border">
                      <div className="text-[10px] text-dim uppercase tracking-wider mb-1">Weekly Points</div>
                      <div className="text-sm font-semibold mono-nums">{(hclawState.pointsThisEpoch ?? 0).toFixed(2)}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-surface border border-card-border">
                      <div className="text-[10px] text-dim uppercase tracking-wider mb-1">Claimable</div>
                      <div className="text-sm font-semibold mono-nums">
                        ${Number(hclawState.claimableRebateUsd ?? 0).toFixed(2)} + {(hclawState.claimableIncentiveHclaw ?? 0).toFixed(2)} HCLAW
                      </div>
                    </div>
                  </div>
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
          <h3 className="text-xl font-bold mb-2 text-center gradient-title">How It Works</h3>
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
          <Link href="/arena" className="flex flex-col items-center gap-1 py-2 px-4">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted">
              <path d="M12 3v18" /><path d="M3 12h18" /><path d="M7 7l10 10" /><path d="M17 7L7 17" />
            </svg>
            <span className="text-[10px] text-muted font-medium">Arena</span>
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

      {/* <InstallPWA /> */}
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

function _AgentCard({ agent, hlWallet }: {
  agent: Agent;
  hlWallet?: { hasWallet: boolean; address?: string; accountValue?: string; availableBalance?: string; totalPnl?: number };
}) {
  const pnl = typeof hlWallet?.totalPnl === "number" ? hlWallet.totalPnl : agent.totalPnl;
  return (
    <Link href={`/agents/${agent.id}`}>
      <div className="glass-card p-5 md:p-6 cursor-pointer h-full flex flex-col">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl overflow-hidden border border-accent/20 shrink-0">
              <AgentAvatar name={agent.name} description={agent.description} size={40} />
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
            <span className={`font-medium mono-nums ${pnl >= 0 ? "text-success" : "text-danger"}`}>
              {pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}
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
