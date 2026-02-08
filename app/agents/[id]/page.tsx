"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { useAccount, useBalance, useWriteContract, useReadContract, useWaitForTransactionReceipt, useSwitchChain } from "wagmi";
import { parseEther, formatEther, type Address } from "viem";
import Link from "next/link";
import { NetworkToggle } from "@/app/components/NetworkToggle";
import type { Agent, TradeLog, MonadToken, VaultChatMessage } from "@/lib/types";
import { MONAD_TOKENS } from "@/lib/types";
import { VAULT_ABI, ERC20_ABI, agentIdToBytes32 } from "@/lib/vault";
import { monadTestnet, monadMainnet } from "../../components/Providers";

const AUTONOMY_LABELS = {
  full: { icon: "🤖", label: "Full Auto", color: "text-success", bg: "bg-success/10", border: "border-success/20" },
  semi: { icon: "🤝", label: "Semi-Auto", color: "text-accent", bg: "bg-accent/10", border: "border-accent/20" },
  manual: { icon: "👤", label: "Manual", color: "text-muted", bg: "bg-muted/10", border: "border-muted/20" },
};

function CopyAddressButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!address) return;
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 p-2 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors text-xs font-medium"
      title="Copy address"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

type TabKey = "overview" | "trades" | "deposit" | "chat";

export default function AgentDetailPage() {
  const params = useParams();
  const agentId = params.id as string;
  const { address, isConnected } = useAccount();
  const { data: balance } = useBalance({ address });

  const [agent, setAgent] = useState<Agent | null>(null);
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("overview");

  // Deposit state
  const [depositToken, setDepositToken] = useState<MonadToken>(MONAD_TOKENS[0]);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositing, setDepositing] = useState(false);
  const [depositTxHash, setDepositTxHash] = useState<`0x${string}` | undefined>();
  const [depositStatus, setDepositStatus] = useState<string>("");

  // Withdraw state (adheres to HL vault rule: leader must keep ≥5%)
  const [withdrawShares, setWithdrawShares] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawTxHash, setWithdrawTxHash] = useState<`0x${string}` | undefined>();
  const [withdrawStatus, setWithdrawStatus] = useState<string>("");

  // HL wallet balance
  const [hlBalance, setHlBalance] = useState<{
    hasWallet: boolean;
    address?: string;
    accountValue?: string;
    availableBalance?: string;
    network?: string;
  } | null>(null);

  // Agent tick (manual trigger)
  const [ticking, setTicking] = useState(false);

  // Approval
  const [approving, setApproving] = useState(false);

  // Chat state
  const [chatMessages, setChatMessages] = useState<VaultChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();

  // Determine which chain the vault is on
  const vaultChainId = process.env.NEXT_PUBLIC_MONAD_TESTNET === "true"
    ? monadTestnet.id
    : monadMainnet.id;

  // Watch for deposit tx confirmation
  const { isSuccess: depositConfirmed } = useWaitForTransactionReceipt({
    hash: depositTxHash,
  });

  // Watch for withdraw tx confirmation
  const { isSuccess: withdrawConfirmed } = useWaitForTransactionReceipt({
    hash: withdrawTxHash,
  });

  const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS as Address | undefined;
  const agentIdBytes = agentIdToBytes32(agentId);

  // Read user shares from vault
  const { data: userShares } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "userShares",
    args: vaultAddress ? [agentIdBytes, address!] : undefined,
    query: { enabled: !!vaultAddress && !!address },
  });

  const { data: totalShares } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "totalShares",
    args: vaultAddress ? [agentIdBytes] : undefined,
    query: { enabled: !!vaultAddress },
  });

  const fetchAgent = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}`);
      const data = await res.json();
      setAgent(data.agent);
      setTrades(data.trades || []);

      // Also fetch HL balance
      try {
        const hlRes = await fetch("/api/fund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "agent-balance", agentId }),
        });
        const hlData = await hlRes.json();
        setHlBalance(hlData);
      } catch {
        // HL balance fetch is non-critical
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  const fetchChat = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/chat?limit=50`);
      const data = await res.json();
      setChatMessages(data.messages || []);
    } catch {
      // Ignore
    }
  }, [agentId]);

  useEffect(() => {
    fetchAgent();
  }, [fetchAgent]);

  // When deposit tx confirms, relay to backend
  useEffect(() => {
    if (depositConfirmed && depositTxHash) {
      setDepositStatus("Confirming deposit with relay...");
      fetch("/api/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: depositTxHash }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.success) {
            const d = data.deposit;
            const hlInfo = d.hlFunded
              ? ` HL wallet ${d.hlWalletAddress?.slice(0, 6)}...${d.hlWalletAddress?.slice(-4)} funded $${d.hlFundedAmount}.`
              : "";
            setDepositStatus(`Deposit confirmed! ${d.shares} shares minted.${hlInfo}`);
            setDepositAmount("");
            fetchAgent();
          } else {
            setDepositStatus(`Relay note: ${data.error || "Deposit recorded on-chain"}`);
          }
        })
        .catch(() => {
          setDepositStatus("On-chain deposit confirmed. Relay sync pending.");
        })
        .finally(() => {
          setDepositing(false);
          setDepositTxHash(undefined);
        });
    }
  }, [depositConfirmed, depositTxHash, fetchAgent]);

  useEffect(() => {
    if (withdrawConfirmed && withdrawTxHash) {
      setWithdrawStatus("Withdrawal confirmed.");
      setWithdrawShares("");
      setWithdrawTxHash(undefined);
      fetchAgent();
    }
  }, [withdrawConfirmed, withdrawTxHash, fetchAgent]);

  useEffect(() => {
    if (tab === "chat") {
      fetchChat();
      const interval = setInterval(fetchChat, 5000);
      return () => clearInterval(interval);
    }
  }, [tab, fetchChat]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const handleDeposit = async () => {
    if (!depositAmount || !address || parseFloat(depositAmount) <= 0) return;
    setDepositing(true);
    setDepositStatus("");

    // Check if vault contract is deployed
    const hasVault = vaultAddress && vaultAddress.startsWith("0x") && vaultAddress.length === 42;

    try {
      if (hasVault) {
        // ========== On-chain deposit via Monad vault ==========
        try {
          await switchChainAsync({ chainId: vaultChainId });
        } catch {
          // May already be on the right chain
        }

        if (depositToken.symbol === "MON") {
          setDepositStatus("Sending MON deposit transaction...");
          const hash = await writeContractAsync({
            address: vaultAddress!,
            abi: VAULT_ABI,
            functionName: "depositMON",
            args: [agentIdBytes],
            value: parseEther(depositAmount),
          });
          setDepositTxHash(hash);
          setDepositStatus("Transaction submitted. Waiting for confirmation...");
        } else {
          // ERC20: approve then deposit
          const amountWei = BigInt(
            Math.floor(parseFloat(depositAmount) * 10 ** depositToken.decimals)
          );

          setDepositStatus(`Approving ${depositToken.symbol}...`);
          await writeContractAsync({
            address: depositToken.address,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [vaultAddress!, amountWei],
          });

          setDepositStatus(`Depositing ${depositToken.symbol}...`);
          const hash = await writeContractAsync({
            address: vaultAddress!,
            abi: VAULT_ABI,
            functionName: "depositERC20",
            args: [agentIdBytes, depositToken.address, amountWei],
          });
          setDepositTxHash(hash);
          setDepositStatus("Transaction submitted. Waiting for confirmation...");
        }
      } else {
        // ========== No vault deployed — record deposit off-chain ==========
        setDepositStatus("Recording deposit (vault contract not yet deployed)...");
        // For hackathon demo: record the intent to deposit
        // This gets tracked in the backend and attributed when vault is live
        const res = await fetch("/api/deposit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            txHash: `offchain-${Date.now()}`,
            agentId,
            user: address,
            token: depositToken.address,
            amount: depositAmount,
            offchain: true,
          }),
        });
        const data = await res.json();
        setDepositStatus(
          data.success
            ? "Deposit recorded. Deploy vault contract for on-chain tracking."
            : "Deposit intent recorded locally."
        );
        setDepositAmount("");
        setDepositing(false);
      }
    } catch (e) {
      console.error("Deposit error:", e);
      setDepositStatus(
        e instanceof Error ? e.message : "Deposit failed. Check wallet and try again."
      );
      setDepositing(false);
    }
  };

  const handleWithdraw = async () => {
    const hasVault = vaultAddress && vaultAddress.startsWith("0x") && vaultAddress.length === 42;
    if (!hasVault || !address || !userShares || !totalShares || totalShares === BigInt(0)) return;
    const sharesWei = parseEther(withdrawShares || "0");
    if (sharesWei <= BigInt(0)) return;
    if (sharesWei > userShares) {
      setWithdrawStatus("Insufficient shares.");
      return;
    }
    const maxWithdrawRaw = (BigInt(100) * userShares - BigInt(5) * totalShares) / BigInt(95);
    const maxWithdrawShares = maxWithdrawRaw > BigInt(0) ? maxWithdrawRaw : BigInt(0);
    if (sharesWei > maxWithdrawShares) {
      setWithdrawStatus("Hyperliquid rule: you must keep ≥5% of vault. Reduce amount.");
      return;
    }
    setWithdrawing(true);
    setWithdrawStatus("");
    try {
      await switchChainAsync({ chainId: vaultChainId });
      const hash = await writeContractAsync({
        address: vaultAddress!,
        abi: VAULT_ABI,
        functionName: "withdraw",
        args: [agentIdBytes, sharesWei],
      });
      setWithdrawTxHash(hash);
      setWithdrawStatus("Transaction submitted. Waiting for confirmation...");
    } catch (e) {
      console.error("Withdraw error:", e);
      setWithdrawStatus(e instanceof Error ? e.message : "Withdraw failed.");
    } finally {
      setWithdrawing(false);
    }
  };

  const handleTick = async () => {
    setTicking(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/tick`, { method: "POST" });
      await res.json();
      await fetchAgent();
    } catch (e) {
      console.error("Tick error:", e);
    } finally {
      setTicking(false);
    }
  };

  const handleApproval = async (action: "approve" | "reject") => {
    if (!agent?.pendingApproval) return;
    setApproving(true);
    try {
      await fetch(`/api/agents/${agentId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: agent.pendingApproval.id, action }),
      });
      await fetchAgent();
    } catch (e) {
      console.error("Approval error:", e);
    } finally {
      setApproving(false);
    }
  };

  const handleSendChat = async () => {
    if (!chatInput.trim()) return;
    setSendingChat(true);
    try {
      await fetch(`/api/agents/${agentId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: chatInput.trim(),
          senderName: address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Anonymous",
          senderId: address,
          type: chatInput.trim().endsWith("?") ? "question" : "discussion",
        }),
      });
      setChatInput("");
      await fetchChat();
    } catch {
      // Ignore
    } finally {
      setSendingChat(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          <span className="text-muted text-sm">Loading agent...</span>
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 rounded-2xl bg-danger/10 border border-danger/20 flex items-center justify-center mx-auto mb-4">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-danger">
              <circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6m0-6l6 6" />
            </svg>
          </div>
          <h2 className="text-lg font-bold mb-2">Agent not found</h2>
          <Link href="/agents" className="text-accent text-sm hover:underline">Back to agents</Link>
        </div>
      </div>
    );
  }

  const sharePercent =
    userShares && totalShares && totalShares > BigInt(0)
      ? Number((userShares * BigInt(10000)) / totalShares) / 100
      : 0;

  // Hyperliquid rule: leader must keep ≥5% of vault. Max withdrawable shares.
  const maxWithdrawableShares =
    userShares && totalShares && totalShares > BigInt(0)
      ? (() => {
          const num = BigInt(100) * userShares - BigInt(5) * totalShares;
          if (num <= BigInt(0)) return BigInt(0);
          return num / BigInt(95);
        })()
      : BigInt(0);
  const maxWithdrawableFormatted = maxWithdrawableShares > BigInt(0) ? formatEther(maxWithdrawableShares) : "0";

  const autonomyInfo = AUTONOMY_LABELS[agent.autonomy?.mode ?? "semi"];
  const hasPendingApproval = agent.pendingApproval?.status === "pending";

  const tabs: { key: TabKey; label: string; badge?: boolean }[] = [
    { key: "overview", label: "Overview" },
    { key: "trades", label: "Trades" },
    { key: "deposit", label: "Deposit" },
    ...(agent.vaultSocial?.isOpenVault ? [{ key: "chat" as const, label: "Vault Chat", badge: chatMessages.length > 0 }] : []),
  ];

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      <div className="orb orb-green w-[500px] h-[500px] -top-[200px] right-[10%] fixed" />
      <div className="orb orb-purple w-[400px] h-[400px] bottom-[10%] -left-[150px] fixed" />

      {/* Header */}
      <header className="glass sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <Link href="/" className="flex items-center gap-3 group shrink-0">
              <div className="w-9 h-9 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center group-hover:bg-accent/15 transition-colors">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
                  <path d="M6 3v12" /><path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M15 6a9 9 0 0 0-9 9" /><path d="M18 15v6" /><path d="M21 18h-6" />
                </svg>
              </div>
            </Link>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-dim shrink-0"><path d="M9 18l6-6-6-6" /></svg>
            <Link href="/agents" className="text-muted hover:text-foreground transition-colors shrink-0">Agents</Link>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-dim shrink-0"><path d="M9 18l6-6-6-6" /></svg>
            <span className="text-foreground font-medium truncate">{agent.name}</span>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <NetworkToggle />
            <button
              onClick={handleTick}
              disabled={ticking || agent.status !== "active"}
              className="btn-primary px-4 py-2 text-sm shrink-0 disabled:opacity-40"
            >
              {ticking ? (
                <span className="flex items-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                  Running...
                </span>
              ) : agent.autonomy?.mode === "manual" ? "Trigger AI Trade" : "Force Tick"}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 md:py-12 relative z-10">
        {/* Agent identity */}
        <div className="flex flex-col md:flex-row items-start gap-6 mb-6">
          <div className="w-16 h-16 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center text-2xl font-bold text-accent shrink-0">
            {agent.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <h2 className="text-2xl md:text-3xl font-bold">{agent.name}</h2>
              <span className={`chip ${
                agent.status === "active" ? "chip-active" : agent.status === "paused" ? "chip-paused" : "chip-stopped"
              }`}>
                {agent.status === "active" && <span className="w-1.5 h-1.5 rounded-full bg-current pulse-live" />}
                {agent.status}
              </span>
              {/* Autonomy badge */}
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${autonomyInfo.bg} ${autonomyInfo.color} border ${autonomyInfo.border}`}>
                <span>{autonomyInfo.icon}</span>
                {autonomyInfo.label}
              </span>
              {/* Telegram badge */}
              {agent.telegram?.enabled && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[#229ED9]/10 text-[#229ED9] border border-[#229ED9]/20">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" /></svg>
                  TG
                </span>
              )}
              {/* Open vault badge */}
              {agent.vaultSocial?.isOpenVault && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-warning/10 text-warning border border-warning/20">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                  Open Vault
                </span>
              )}
            </div>
            <p className="text-muted text-sm leading-relaxed max-w-2xl">{agent.description}</p>
          </div>
        </div>

        {/* Pending Approval Banner */}
        {hasPendingApproval && agent.pendingApproval && (
          <div className="mb-8 card rounded-2xl p-5 border-accent/30 bg-accent/5 animate-fade-in-up">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-accent/15 flex items-center justify-center shrink-0 mt-0.5">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4l2 2" strokeLinecap="round" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h4 className="text-sm font-semibold text-accent">Trade Approval Required</h4>
                  <span className="text-[10px] text-dim mono-nums">
                    expires {new Date(agent.pendingApproval.expiresAt).toLocaleTimeString()}
                  </span>
                </div>
                <div className="text-sm text-foreground mb-1">
                  <span className={`font-semibold uppercase ${
                    agent.pendingApproval.decision.action === "long" ? "text-success" : "text-danger"
                  }`}>
                    {agent.pendingApproval.decision.action}
                  </span>
                  {" "}{agent.pendingApproval.decision.asset}
                  {" "}at {agent.pendingApproval.decision.leverage}x
                  {" "}({(agent.pendingApproval.decision.size * 100).toFixed(0)}% of capital)
                </div>
                <p className="text-xs text-muted mb-3">{agent.pendingApproval.decision.reasoning}</p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleApproval("approve")}
                    disabled={approving}
                    className="btn-primary px-5 py-2 text-sm"
                  >
                    {approving ? "..." : "Approve Trade"}
                  </button>
                  <button
                    onClick={() => handleApproval("reject")}
                    disabled={approving}
                    className="px-5 py-2 text-sm rounded-xl bg-danger/10 border border-danger/20 text-danger hover:bg-danger/15 transition-colors"
                  >
                    Reject
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 mb-10">
          {[
            {
              label: "Total PnL",
              value: `${agent.totalPnl >= 0 ? "+" : ""}$${agent.totalPnl.toFixed(2)}`,
              color: agent.totalPnl >= 0 ? "text-success" : "text-danger",
            },
            { label: "Vault TVL", value: `$${agent.vaultTvlUsd.toLocaleString()}`, color: "text-foreground" },
            {
              label: "HL Balance",
              value: hlBalance?.hasWallet
                ? `$${parseFloat(hlBalance.accountValue || "0").toFixed(2)}`
                : "No wallet",
              color: hlBalance?.hasWallet ? "text-accent" : "text-dim",
            },
            { label: "Total Trades", value: String(agent.totalTrades), color: "text-foreground" },
            { label: "Win Rate", value: `${(agent.winRate * 100).toFixed(1)}%`, color: "text-foreground" },
            { label: "Your Share", value: `${sharePercent.toFixed(2)}%`, color: "gradient-text" },
            {
              label: "Aggressiveness",
              value: `${agent.autonomy?.aggressiveness ?? 50}%`,
              color: (agent.autonomy?.aggressiveness ?? 50) > 70 ? "text-danger" : (agent.autonomy?.aggressiveness ?? 50) > 40 ? "text-warning" : "text-success",
            },
          ].map((s) => (
            <div key={s.label} className="card rounded-2xl p-4">
              <div className="text-[11px] text-dim uppercase tracking-wider mb-2">{s.label}</div>
              <div className={`text-lg font-bold mono-nums ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-8 bg-surface rounded-xl p-1 w-fit border border-card-border overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-5 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap relative ${
                tab === t.key
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {t.label}
              {t.badge && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent" />
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="animate-fade-in-up">
          {tab === "overview" && (
            <div className="space-y-4">
              {/* Autonomy Config */}
              <div className="card rounded-2xl p-6 md:p-8">
                <h3 className="font-semibold text-sm uppercase tracking-wider text-muted mb-5">Autonomy &amp; Control</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-sm">
                  <div>
                    <span className="text-dim text-xs block mb-1.5">Mode</span>
                    <span className={`font-medium ${autonomyInfo.color}`}>
                      {autonomyInfo.icon} {autonomyInfo.label}
                    </span>
                  </div>
                  <div>
                    <span className="text-dim text-xs block mb-1.5">Aggressiveness</span>
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 rounded-full bg-surface overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            (agent.autonomy?.aggressiveness ?? 50) > 70 ? "bg-danger" :
                            (agent.autonomy?.aggressiveness ?? 50) > 40 ? "bg-warning" : "bg-success"
                          }`}
                          style={{ width: `${agent.autonomy?.aggressiveness ?? 50}%` }}
                        />
                      </div>
                      <span className="font-medium mono-nums">{agent.autonomy?.aggressiveness ?? 50}%</span>
                    </div>
                  </div>
                  <div>
                    <span className="text-dim text-xs block mb-1.5">Min Confidence</span>
                    <span className="font-medium mono-nums">{((agent.autonomy?.minConfidence ?? 0.75) * 100).toFixed(0)}%</span>
                  </div>
                  <div>
                    <span className="text-dim text-xs block mb-1.5">Max Trades/Day</span>
                    <span className="font-medium mono-nums">{agent.autonomy?.maxTradesPerDay ?? 10}</span>
                  </div>
                </div>
                {agent.autonomy?.mode === "semi" && (
                  <div className="mt-4 pt-4 border-t border-card-border text-xs text-dim">
                    Approval timeout: {Math.round((agent.autonomy.approvalTimeoutMs ?? 300000) / 60000)} min
                    {" "}&mdash; trades proposed via {agent.telegram?.enabled ? "Telegram & UI" : "UI only"}
                  </div>
                )}
              </div>

              {/* Trading Config */}
              <div className="card rounded-2xl p-6 md:p-8">
                <h3 className="font-semibold text-sm uppercase tracking-wider text-muted mb-5">Trading Configuration</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-sm">
                  <div>
                    <span className="text-dim text-xs block mb-1.5">Markets</span>
                    <span className="font-medium text-accent">
                      {agent.markets.length > 5
                        ? `All Markets (${agent.markets.length})`
                        : agent.markets.join(", ")}
                    </span>
                  </div>
                  <div>
                    <span className="text-dim text-xs block mb-1.5">Max Leverage</span>
                    <span className="font-medium mono-nums">{agent.maxLeverage}x</span>
                  </div>
                  <div>
                    <span className="text-dim text-xs block mb-1.5">Risk Level</span>
                    <span className={`font-medium capitalize ${
                      agent.riskLevel === "conservative" ? "text-success" : agent.riskLevel === "moderate" ? "text-warning" : "text-danger"
                    }`}>
                      {agent.riskLevel}
                    </span>
                  </div>
                  <div>
                    <span className="text-dim text-xs block mb-1.5">Stop Loss</span>
                    <span className="font-medium mono-nums">{agent.stopLossPercent}%</span>
                  </div>
                </div>
              </div>

              {/* Notifications */}
              <div className="card rounded-2xl p-6 md:p-8">
                <h3 className="font-semibold text-sm uppercase tracking-wider text-muted mb-5">Notifications</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-surface border border-card-border">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-[#229ED9] shrink-0"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" /></svg>
                    <div className="min-w-0">
                      <span className="text-dim text-xs block">Telegram</span>
                      <span className={`font-medium ${agent.telegram?.enabled ? "text-success" : "text-dim"}`}>
                        {agent.telegram?.enabled ? `Connected (ID: ${agent.telegram.chatId})` : "Not connected"}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-surface border border-card-border">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-warning shrink-0">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    <div className="min-w-0">
                      <span className="text-dim text-xs block">Vault</span>
                      <span className={`font-medium ${agent.vaultSocial?.isOpenVault ? "text-success" : "text-dim"}`}>
                        {agent.vaultSocial?.isOpenVault ? "Open — investors can join" : "Private"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* HL Address — prefer live balance address, then agent.hlAddress */}
              <div className="card rounded-2xl p-6 md:p-8">
                <h3 className="font-semibold text-sm uppercase tracking-wider text-muted mb-4">Hyperliquid Wallet</h3>
                <div className="flex items-center gap-3 bg-surface rounded-xl p-4 border border-card-border">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${(hlBalance?.address ?? agent?.hlAddress) ? "bg-accent pulse-live" : "bg-dim"}`} />
                  {(hlBalance?.address ?? agent?.hlAddress) ? (
                    <>
                      <code className="text-sm text-accent font-mono break-all flex-1 min-w-0">
                        {hlBalance?.address ?? agent?.hlAddress}
                      </code>
                      <CopyAddressButton address={hlBalance?.address ?? agent?.hlAddress ?? ""} />
                    </>
                  ) : (
                    <span className="text-dim text-sm">No wallet — deposit MON in the Deposit tab to provision one.</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === "trades" && (
            <div className="card rounded-2xl overflow-hidden">
              {trades.length === 0 ? (
                <div className="p-16 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-surface border border-card-border flex items-center justify-center mx-auto mb-4">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-dim">
                      <path d="M3 3v18h18" strokeLinecap="round" /><path d="M7 16l4-8 4 4 4-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <p className="text-muted text-sm">No trades yet. {agent.autonomy?.mode === "manual" ? "Trigger AI Trade to start." : "Agent will trade based on its autonomy settings."}</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="table-header text-[11px] text-dim uppercase tracking-wider text-left">
                        <th className="px-5 py-3.5 font-medium">Time</th>
                        <th className="px-5 py-3.5 font-medium">Action</th>
                        <th className="px-5 py-3.5 font-medium">Asset</th>
                        <th className="px-5 py-3.5 font-medium">Size</th>
                        <th className="px-5 py-3.5 font-medium">Leverage</th>
                        <th className="px-5 py-3.5 font-medium">Confidence</th>
                        <th className="px-5 py-3.5 font-medium">Status</th>
                        <th className="px-5 py-3.5 font-medium">Reasoning</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((trade) => (
                        <tr key={trade.id} className="table-row">
                          <td className="px-5 py-3.5 text-dim mono-nums text-xs">
                            {new Date(trade.timestamp).toLocaleString()}
                          </td>
                          <td className="px-5 py-3.5">
                            <span className={`chip ${
                              trade.decision.action === "long" ? "chip-active" :
                              trade.decision.action === "short" ? "bg-danger/15 text-danger" :
                              trade.decision.action === "close" ? "chip-paused" : "chip-stopped"
                            } uppercase text-[10px] font-semibold tracking-wider`}>
                              {trade.decision.action}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 font-medium text-foreground">{trade.decision.asset}</td>
                          <td className="px-5 py-3.5 mono-nums">{(trade.decision.size * 100).toFixed(0)}%</td>
                          <td className="px-5 py-3.5 mono-nums">{trade.decision.leverage}x</td>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2">
                              <div className="w-12 h-1 rounded-full bg-surface overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-accent"
                                  style={{ width: `${trade.decision.confidence * 100}%` }}
                                />
                              </div>
                              <span className="mono-nums text-xs">{(trade.decision.confidence * 100).toFixed(0)}%</span>
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            {trade.executed ? (
                              <span className="chip chip-active text-[10px]">Executed</span>
                            ) : (
                              <span className="chip chip-stopped text-[10px]">Skipped</span>
                            )}
                          </td>
                          <td className="px-5 py-3.5 text-dim text-xs max-w-[200px] truncate">
                            {trade.decision.reasoning}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === "deposit" && (
            <div className="max-w-lg mx-auto">
              <div className="card rounded-2xl p-6 md:p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
                      <path d="M12 2v20m-7-7l7 7 7-7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="font-semibold">Deposit to Vault</h3>
                    <p className="text-xs text-muted">Fund this agent&apos;s Hyperliquid trading</p>
                  </div>
                </div>

                {/* Token Selector */}
                <div className="mb-5">
                  <label className="block text-xs font-medium text-muted uppercase tracking-wider mb-2.5">Token</label>
                  <div className="grid grid-cols-3 gap-2">
                    {MONAD_TOKENS.map((token) => (
                      <button
                        key={token.symbol}
                        onClick={() => setDepositToken(token)}
                        className={`py-2.5 rounded-xl text-sm font-medium transition-all ${
                          depositToken.symbol === token.symbol
                            ? "bg-accent/15 border border-accent/40 text-accent"
                            : "bg-surface border border-card-border text-muted hover:border-accent/20 hover:text-foreground"
                        }`}
                      >
                        {token.symbol}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Amount */}
                <div className="mb-6">
                  <label className="block text-xs font-medium text-muted uppercase tracking-wider mb-2.5">Amount</label>
                  <div className="relative">
                    <input
                      type="number"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      placeholder="0.00"
                      className="input w-full px-4 py-3.5 text-lg mono-nums pr-20"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-dim font-medium">
                      {depositToken.symbol}
                    </span>
                  </div>
                  {balance && depositToken.symbol === "MON" && (
                    <div className="flex items-center justify-between mt-2">
                      <p className="text-xs text-dim">
                        Balance: <span className="mono-nums text-muted">{parseFloat(balance.formatted).toFixed(4)} MON</span>
                      </p>
                      <button
                        onClick={() => setDepositAmount(balance.formatted)}
                        className="text-xs text-accent hover:text-accent/80 font-medium transition-colors"
                      >
                        Max
                      </button>
                    </div>
                  )}
                </div>

                {/* Network Info */}
                {vaultAddress && vaultAddress.startsWith("0x") && vaultAddress.length === 42 ? (
                  <div className="mb-4 p-3 bg-success/5 border border-success/20 rounded-xl text-xs">
                    <div className="flex items-center gap-1.5 text-success font-medium mb-1">
                      <div className="w-2 h-2 rounded-full bg-success" />
                      Vault Contract Active
                    </div>
                    <span className="text-dim font-mono text-[10px] break-all">{vaultAddress}</span>
                  </div>
                ) : (
                  <div className="mb-4 p-3 bg-warning/5 border border-warning/20 rounded-xl text-xs">
                    <div className="flex items-center gap-1.5 text-warning font-medium mb-1">
                      <div className="w-2 h-2 rounded-full bg-warning" />
                      Vault Not Deployed
                    </div>
                    <span className="text-dim">
                      Deploy the HyperclawVault contract and set NEXT_PUBLIC_VAULT_ADDRESS.
                      Deposits will be recorded off-chain until then.
                    </span>
                  </div>
                )}

                {/* Deposit Status */}
                {depositStatus && (
                  <div className={`mb-4 p-3 rounded-xl text-xs ${
                    depositStatus.includes("confirmed") || depositStatus.includes("success")
                      ? "bg-success/10 border border-success/20 text-success"
                      : depositStatus.includes("failed") || depositStatus.includes("error") || depositStatus.includes("Error")
                      ? "bg-danger/10 border border-danger/20 text-danger"
                      : "bg-accent/10 border border-accent/20 text-accent"
                  }`}>
                    {depositing && (
                      <span className="inline-block w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin mr-2 align-middle" />
                    )}
                    {depositStatus}
                  </div>
                )}

                {/* Deposit Button */}
                {isConnected ? (
                  <button
                    onClick={handleDeposit}
                    disabled={depositing || !depositAmount || parseFloat(depositAmount) <= 0}
                    className="btn-primary w-full py-3.5 text-sm"
                  >
                    {depositing ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                        {depositStatus ? "Processing..." : "Depositing..."}
                      </span>
                    ) : `Deposit ${depositToken.symbol}`}
                  </button>
                ) : (
                  <div className="text-center text-muted text-sm py-4 bg-surface rounded-xl border border-card-border">
                    Connect wallet to deposit
                  </div>
                )}

                {/* Share Info */}
                {userShares && userShares > BigInt(0) && (
                  <div className="mt-5 p-4 bg-surface rounded-xl border border-card-border space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-dim">Your Shares</span>
                      <span className="font-medium mono-nums">{formatEther(userShares)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-dim">Vault Share</span>
                      <span className="font-medium gradient-text mono-nums">{sharePercent.toFixed(2)}%</span>
                    </div>
                  </div>
                )}

                {/* Withdraw — adheres to Hyperliquid vault rule: leader must keep ≥5% */}
                {vaultAddress && vaultAddress.startsWith("0x") && vaultAddress.length === 42 && userShares && userShares > BigInt(0) && (
                  <div className="mt-5 p-4 bg-surface rounded-xl border border-card-border">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">Withdraw</h4>
                    <p className="text-xs text-dim mb-3">
                      You must maintain ≥5% of vault liquidity (Hyperliquid rule). Max withdrawable: <span className="font-medium mono-nums text-foreground">{maxWithdrawableFormatted}</span> shares.
                    </p>
                    <div className="flex gap-2 mb-2">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={withdrawShares}
                        onChange={(e) => setWithdrawShares(e.target.value)}
                        placeholder="0"
                        className="input flex-1 py-2.5 text-sm mono-nums"
                      />
                      <button
                        type="button"
                        onClick={() => setWithdrawShares(maxWithdrawableFormatted)}
                        className="px-3 py-2.5 rounded-xl bg-accent/10 text-accent border border-accent/20 text-xs font-medium hover:bg-accent/20 transition-colors"
                      >
                        Max
                      </button>
                    </div>
                    {withdrawStatus && (
                      <div className={`mb-2 text-xs ${withdrawStatus.startsWith("Hyperliquid") ? "text-warning" : withdrawStatus.includes("confirmed") ? "text-success" : "text-dim"}`}>
                        {withdrawStatus}
                      </div>
                    )}
                    {isConnected ? (
                      <button
                        onClick={handleWithdraw}
                        disabled={withdrawing || !withdrawShares || parseFloat(withdrawShares) <= 0 || maxWithdrawableShares === BigInt(0)}
                        className="btn-secondary w-full py-2.5 text-sm"
                      >
                        {withdrawing ? (
                          <span className="flex items-center justify-center gap-2">
                            <span className="w-3.5 h-3.5 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                            Withdrawing...
                          </span>
                        ) : "Withdraw from vault"}
                      </button>
                    ) : (
                      <p className="text-xs text-dim text-center py-2">Connect wallet to withdraw</p>
                    )}
                  </div>
                )}

                {/* Agent HL Wallet Info */}
                {hlBalance && (
                  <div className="mt-5 p-4 bg-surface rounded-xl border border-card-border space-y-2">
                    <div className="flex items-center gap-2 mb-2">
                      <div className={`w-2 h-2 rounded-full ${hlBalance.hasWallet ? "bg-success" : "bg-dim"}`} />
                      <span className="text-xs font-medium text-muted uppercase tracking-wider">
                        Hyperliquid {hlBalance.network || "testnet"} Wallet
                      </span>
                    </div>
                    {hlBalance.hasWallet ? (
                      <>
                        <div className="flex justify-between text-sm">
                          <span className="text-dim">Address</span>
                          <span className="font-mono text-xs text-muted">
                            {hlBalance.address?.slice(0, 6)}...{hlBalance.address?.slice(-4)}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-dim">Account Value</span>
                          <span className="font-medium mono-nums text-accent">
                            ${parseFloat(hlBalance.accountValue || "0").toFixed(2)}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-dim">Available</span>
                          <span className="font-medium mono-nums">
                            ${parseFloat(hlBalance.availableBalance || "0").toFixed(2)}
                          </span>
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-dim">
                        No HL wallet yet. Deposit MON to auto-provision + fund 1:1.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "chat" && (
            <div className="max-w-2xl mx-auto">
              <div className="card rounded-2xl overflow-hidden">
                {/* Chat header */}
                <div className="p-5 border-b border-card-border">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-warning/10 border border-warning/20 flex items-center justify-center">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-warning">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    </div>
                    <div>
                      <h3 className="font-semibold text-sm">{agent.name} Vault Chat</h3>
                      <p className="text-xs text-dim">
                        {agent.depositorCount} investor{agent.depositorCount !== 1 ? "s" : ""}
                        {" "}&middot; Agent discusses trades and answers questions
                      </p>
                    </div>
                  </div>
                </div>

                {/* Messages */}
                <div className="h-[400px] overflow-y-auto p-4 space-y-3 custom-scrollbar">
                  {chatMessages.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-dim text-sm">
                      No messages yet. Ask the agent about its strategy!
                    </div>
                  ) : (
                    chatMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`flex gap-3 ${msg.sender === "agent" ? "" : "flex-row-reverse"}`}
                      >
                        <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                          msg.sender === "agent"
                            ? "bg-accent/15 text-accent"
                            : msg.sender === "system"
                            ? "bg-surface text-dim"
                            : "bg-warning/15 text-warning"
                        }`}>
                          {msg.sender === "agent" ? "AI" : msg.sender === "system" ? "SYS" : msg.senderName?.charAt(0) || "?"}
                        </div>
                        <div className={`max-w-[75%] ${msg.sender !== "agent" ? "text-right" : ""}`}>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className={`text-[11px] font-medium ${
                              msg.sender === "agent" ? "text-accent" : "text-muted"
                            }`}>
                              {msg.senderName}
                            </span>
                            <span className="text-[10px] text-dim mono-nums">
                              {new Date(msg.timestamp).toLocaleTimeString()}
                            </span>
                            {(msg.type === "trade_proposal" || msg.type === "trade_executed") && (
                              <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                                msg.type === "trade_executed" ? "bg-success/10 text-success" : "bg-accent/10 text-accent"
                              }`}>
                                {msg.type === "trade_executed" ? "TRADE" : "PROPOSAL"}
                              </span>
                            )}
                          </div>
                          <div className={`rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
                            msg.sender === "agent"
                              ? "bg-accent/5 border border-accent/10 text-foreground"
                              : msg.sender === "system"
                              ? "bg-surface text-dim"
                              : "bg-surface border border-card-border text-foreground"
                          }`}>
                            {msg.content}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Input */}
                <div className="p-4 border-t border-card-border">
                  <div className="flex items-center gap-3">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSendChat()}
                      placeholder="Ask the agent a question..."
                      className="input flex-1 px-4 py-3 text-sm"
                    />
                    <button
                      onClick={handleSendChat}
                      disabled={sendingChat || !chatInput.trim()}
                      className="btn-primary px-4 py-3 text-sm shrink-0 disabled:opacity-40"
                    >
                      {sendingChat ? (
                        <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                  <p className="text-[10px] text-dim mt-2">
                    End your message with ? to get an AI response from the agent
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
