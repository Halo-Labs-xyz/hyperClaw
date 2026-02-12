"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams } from "next/navigation";
import { useAccount, useBalance, useWriteContract, useReadContract, useWaitForTransactionReceipt, useSwitchChain, usePublicClient } from "wagmi";
import { parseEther, parseUnits, formatEther, type Address } from "viem";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { NetworkToggle } from "@/app/components/NetworkToggle";
import { useNetwork } from "@/app/components/NetworkContext";
import { HyperclawIcon } from "@/app/components/HyperclawIcon";
import { TelegramChatButton } from "@/app/components/TelegramChatButton";
import { AgentAvatar } from "@/app/components/AgentAvatar";
import type { Agent, TradeLog, MonadToken, VaultChatMessage, IndicatorConfig } from "@/lib/types";
import { MONAD_TOKENS, INDICATOR_TEMPLATES } from "@/lib/types";
import { VAULT_ABI, ERC20_ABI, agentIdToBytes32 } from "@/lib/vault";
import { monadTestnet as monadTestnetChain, monadMainnet } from "@/lib/chains";

const AUTONOMY_LABELS = {
  full: { icon: "🤖", label: "Full Auto", color: "text-success", bg: "bg-success/10", border: "border-success/20" },
  semi: { icon: "🤝", label: "Semi-Auto", color: "text-accent", bg: "bg-accent/10", border: "border-accent/20" },
  manual: { icon: "👤", label: "Manual", color: "text-muted", bg: "bg-muted/10", border: "border-muted/20" },
};

function ReasoningCell({ reasoning }: { reasoning?: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = reasoning?.trim() || "—";
  const isLong = text.length > 60;
  return (
    <button
      type="button"
      onClick={() => isLong && setExpanded((e) => !e)}
      className={`text-left w-full block max-w-[280px] ${isLong ? "cursor-pointer hover:text-foreground/80" : ""}`}
      title={isLong ? (expanded ? "Click to collapse" : "Click to see full reasoning") : undefined}
    >
      {expanded ? (
        <span className="whitespace-pre-wrap break-words block max-h-32 overflow-y-auto text-xs">{text}</span>
      ) : (
        <span className={isLong ? "truncate block" : ""}>{text}</span>
      )}
      {isLong && <span className="text-[10px] text-muted ml-1">{expanded ? "▲" : "⋯"}</span>}
    </button>
  );
}

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

type TabKey = "overview" | "trades" | "deposit" | "chat" | "settings";

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

export default function AgentDetailPage() {
  const params = useParams();
  const agentId = params.id as string;
  const { user } = usePrivy();
  const { monadTestnet } = useNetwork();
  const { address, isConnected } = useAccount();
  const vaultChainId = monadTestnet ? monadTestnetChain.id : monadMainnet.id;
  const activeNetwork = monadTestnet ? "testnet" : "mainnet";
  const publicClient = usePublicClient({ chainId: vaultChainId });
  const { data: balance } = useBalance({ address, chainId: vaultChainId });

  const [agent, setAgent] = useState<Agent | null>(null);
  const [summaryAgent, setSummaryAgent] = useState<AgentSummary | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewError, setViewError] = useState("");
  const [tab, setTab] = useState<TabKey>("overview");

  // Deposit state
  const [depositToken, setDepositToken] = useState<MonadToken>(MONAD_TOKENS[0]);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositing, setDepositing] = useState(false);
  const [depositTxHash, setDepositTxHash] = useState<`0x${string}` | undefined>();
  const [depositStatus, setDepositStatus] = useState<string>("");
  const [capPreview, setCapPreview] = useState<{
    baseCapUsd: number;
    boostedCapUsd: number;
    capRemainingUsd: number;
    boostBps: number;
    rebateBps: number;
    tier: number;
  } | null>(null);
  const [capPreviewLoading, setCapPreviewLoading] = useState(false);

  // Withdraw state (adheres to HL vault rule: leader must keep ≥5%)
  const [withdrawShares, setWithdrawShares] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawTxHash, setWithdrawTxHash] = useState<`0x${string}` | undefined>();
  const [withdrawStatus, setWithdrawStatus] = useState<string>("");

  // HL wallet balance and positions
  const [hlBalance, setHlBalance] = useState<{
    hasWallet: boolean;
    address?: string;
    accountValue?: string;
    availableBalance?: string;
    marginUsed?: string;
    totalPnl?: number;
    totalUnrealizedPnl?: number;
    network?: string;
    stale?: boolean;
    error?: string;
  } | null>(null);

  const [hlPositions, setHlPositions] = useState<{
    coin: string;
    size: number;
    side: "long" | "short";
    entryPrice: number;
    markPrice: number;
    positionValue: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
    leverage: number;
    liquidationPrice: number | null;
  }[]>([]);
  
  const [totalUnrealizedPnl, setTotalUnrealizedPnl] = useState<number>(0);
  const [hlFetchErrors, setHlFetchErrors] = useState(0); // Track consecutive HL fetch errors

  // Agent tick (manual trigger)
  const [ticking, setTicking] = useState(false);
  
  // Runner/Lifecycle state
  const [lifecycle, setLifecycle] = useState<{
    runnerActive: boolean;
    aipRegistered: boolean;
    healthStatus: "healthy" | "degraded" | "unhealthy" | "stopped";
    tickCount?: number;
    lastTickAt?: number | null;
  } | null>(null);

  // Approval
  const [approving, setApproving] = useState(false);

  // Chat state
  const [chatMessages, setChatMessages] = useState<VaultChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Settings state
  const [saving, setSaving] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  
  // Editable settings
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editMarkets, setEditMarkets] = useState<string[]>([]);
  const [editMaxLeverage, setEditMaxLeverage] = useState(10);
  const [editRiskLevel, setEditRiskLevel] = useState<"conservative" | "moderate" | "aggressive">("moderate");
  const [editStopLoss, setEditStopLoss] = useState(5);
  const [editAutonomyMode, setEditAutonomyMode] = useState<"full" | "semi" | "manual">("semi");
  const [editAggressiveness, setEditAggressiveness] = useState(50);
  const [editMaxTradesPerDay, setEditMaxTradesPerDay] = useState(10);
  const [editStatus, setEditStatus] = useState<"active" | "paused" | "stopped">("active");

  // Optional per-agent AI API key override
  const [editAiApiKeyProvider, setEditAiApiKeyProvider] = useState<"anthropic" | "openai">("anthropic");
  const [editAiApiKeyValue, setEditAiApiKeyValue] = useState("");
  const [editAiApiKeyRemove, setEditAiApiKeyRemove] = useState(false);

  // Indicator settings
  const [indicatorEnabled, setIndicatorEnabled] = useState(false);
  const [indicatorTemplate, setIndicatorTemplate] = useState<string>("adaptive-rsi-divergence");
  const [indicatorWeight, setIndicatorWeight] = useState(70);
  const [indicatorStrictMode, setIndicatorStrictMode] = useState(false);
  const [indicatorCustomBullish, setIndicatorCustomBullish] = useState("");
  const [indicatorCustomBearish, setIndicatorCustomBearish] = useState("");
  const [indicatorCustomDescription, setIndicatorCustomDescription] = useState("");

  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();

  // Watch for deposit tx confirmation
  const { isSuccess: depositConfirmed } = useWaitForTransactionReceipt({
    hash: depositTxHash,
  });

  // Watch for withdraw tx confirmation
  const { isSuccess: withdrawConfirmed } = useWaitForTransactionReceipt({
    hash: withdrawTxHash,
  });

  const vaultAddress = useMemo(() => {
    const pick = (value: string | undefined) =>
      value && /^0x[a-fA-F0-9]{40}$/.test(value) ? (value as Address) : undefined;

    const mainnet =
      pick(process.env.NEXT_PUBLIC_MONAD_MAINNET_VAULT_ADDRESS) ??
      pick(process.env.NEXT_PUBLIC_VAULT_ADDRESS_MAINNET);
    const testnet =
      pick(process.env.NEXT_PUBLIC_MONAD_TESTNET_VAULT_ADDRESS) ??
      pick(process.env.NEXT_PUBLIC_VAULT_ADDRESS_TESTNET);
    const fallback = pick(process.env.NEXT_PUBLIC_VAULT_ADDRESS);

    return (activeNetwork === "mainnet" ? mainnet : testnet) ?? fallback;
  }, [activeNetwork]);
  const agentIdBytes = agentIdToBytes32(agentId);

  const verifyVaultContract = useCallback(async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!vaultAddress) {
      return { ok: false, reason: "Vault contract is not configured. Deposits are disabled." };
    }
    if (!publicClient) {
      return { ok: false, reason: "Vault RPC is unavailable. Try again." };
    }

    try {
      const code = await publicClient.getBytecode({ address: vaultAddress });
      if (!code || code === "0x") {
        return {
          ok: false,
          reason:
            `Configured vault ${vaultAddress} has no deployed contract code on ${activeNetwork}. ` +
            "Deposits and withdrawals are blocked to prevent fund loss.",
        };
      }
      return { ok: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown RPC error";
      return { ok: false, reason: `Vault verification failed: ${detail}` };
    }
  }, [activeNetwork, publicClient, vaultAddress]);

  // Read user shares from vault
  const { data: userShares } = useReadContract({
    chainId: vaultChainId,
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "userShares",
    args: vaultAddress ? [agentIdBytes, address!] : undefined,
    query: { enabled: !!vaultAddress && !!address },
  });

  const { data: totalShares } = useReadContract({
    chainId: vaultChainId,
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "totalShares",
    args: vaultAddress ? [agentIdBytes] : undefined,
    query: { enabled: !!vaultAddress },
  });

  const fetchAgent = useCallback(async () => {
    setViewError("");
    try {
      const headers: Record<string, string> = {};
      if (address) headers["x-owner-wallet-address"] = address.toLowerCase();
      if (user?.id) headers["x-owner-privy-id"] = user.id;

      const summaryRes = await fetch(`/api/agents/${agentId}?view=summary&network=${activeNetwork}`, { headers });
      const summaryData = await summaryRes.json();
      if (!summaryRes.ok) {
        throw new Error(summaryData?.error ?? "Failed to load agent");
      }

      setSummaryAgent(summaryData?.agent ?? null);
      const viewerIsOwner = Boolean(summaryData?.viewer?.isOwner);
      setIsOwner(viewerIsOwner);

      if (!viewerIsOwner) {
        setAgent(null);
        setTrades([]);
        setLifecycle(null);
        setHlBalance(null);
        setHlPositions([]);
        setTotalUnrealizedPnl(0);
        return;
      }

      const res = await fetch(`/api/agents/${agentId}`, { headers });
      const data = await res.json();
      setAgent(data.agent ?? null);
      setTrades(data.trades || []);
      
      // Set lifecycle data if present
      if (data.lifecycle) {
        setLifecycle(data.lifecycle);
      }

      // Also fetch HL balance and positions — abort after 15s to not stall the UI
      try {
        const hlRes = await fetch("/api/fund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "agent-state", agentId }),
          signal: AbortSignal.timeout(15000),
        });
        const hlData = await hlRes.json();
        setHlBalance(hlData);
        setHlPositions(hlData.positions || []);
        setTotalUnrealizedPnl(hlData.totalUnrealizedPnl ?? 0);
        // Track stale data / errors from the backend
        if (hlData.stale) {
          setHlFetchErrors(prev => prev + 1);
        } else {
          setHlFetchErrors(0); // Reset on success
        }
      } catch {
        setHlFetchErrors(prev => prev + 1);
      }

      // Also fetch lifecycle summary for runner status
      try {
        const lifecycleRes = await fetch("/api/lifecycle");
        const lifecycleData = await lifecycleRes.json();
        const agentLifecycle = lifecycleData.agents?.find((a: { id: string }) => a.id === agentId);
        if (agentLifecycle) {
          setLifecycle({
            runnerActive: agentLifecycle.runnerActive,
            aipRegistered: agentLifecycle.aipRegistered,
            healthStatus: agentLifecycle.healthStatus,
            tickCount: agentLifecycle.tickCount,
            lastTickAt: agentLifecycle.lastTickAt,
          });
        }
      } catch {
        // Lifecycle fetch is non-critical
      }
    } catch (e) {
      console.error(e);
      setSummaryAgent(null);
      setAgent(null);
      setIsOwner(false);
      setViewError(e instanceof Error ? e.message : "Failed to load agent");
    } finally {
      setLoading(false);
    }
  }, [activeNetwork, address, agentId, user?.id]);

  const fetchChat = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/chat?limit=50`);
      const data = await res.json();
      setChatMessages(data.messages || []);
    } catch {
      // Ignore
    }
  }, [agentId]);

  const fetchCapPreview = useCallback(async () => {
    if (!address) {
      setCapPreview(null);
      return;
    }

    setCapPreviewLoading(true);
    try {
      const res = await fetch(`/api/hclaw/state?user=${address}&agentId=${agentId}&network=${activeNetwork}`);
      const data = await res.json();
      const cap = data?.userContext?.cap;
      if (cap) {
        setCapPreview({
          baseCapUsd: Number(cap.baseCapUsd || 0),
          boostedCapUsd: Number(cap.boostedCapUsd || 0),
          capRemainingUsd: Number(cap.capRemainingUsd || 0),
          boostBps: Number(cap.boostBps || 10_000),
          rebateBps: Number(cap.rebateBps || 0),
          tier: Number(cap.tier || 0),
        });
      } else {
        setCapPreview(null);
      }
    } catch {
      setCapPreview(null);
    } finally {
      setCapPreviewLoading(false);
    }
  }, [activeNetwork, address, agentId]);

  useEffect(() => {
    fetchAgent();
    // Adaptive polling: slow down when HL API is having issues
    // Base: 15s active, 30s paused. Backoff: up to 60s on errors.
    const getInterval = () => {
      const base = agent?.status === "active" ? 15000 : 30000;
      if (hlFetchErrors >= 5) return 60000; // 1 min during sustained errors
      if (hlFetchErrors >= 2) return 30000; // 30s after a couple failures
      return base;
    };

    const refreshInterval = setInterval(() => {
      fetchAgent();
    }, getInterval());
    return () => clearInterval(refreshInterval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchAgent, agent?.status, hlFetchErrors]);

  // Sync settings form when agent loads
  useEffect(() => {
    if (agent) {
      setEditName(agent.name);
      setEditDescription(agent.description);
      setEditMarkets(agent.markets);
      setEditMaxLeverage(agent.maxLeverage);
      setEditRiskLevel(agent.riskLevel);
      setEditStopLoss(agent.stopLossPercent);
      setEditAutonomyMode(agent.autonomy?.mode ?? "semi");
      setEditAggressiveness(agent.autonomy?.aggressiveness ?? 50);
      setEditMaxTradesPerDay(agent.autonomy?.maxTradesPerDay ?? 10);
      setEditStatus(agent.status);
      // AI API Key
      setEditAiApiKeyProvider((agent.aiApiKey?.provider as "anthropic" | "openai") ?? "anthropic");
      setEditAiApiKeyValue("");
      setEditAiApiKeyRemove(false);
      // Indicator settings
      if (agent.indicator) {
        setIndicatorEnabled(agent.indicator.enabled);
        // Determine template from name
        const templateKey = Object.keys(INDICATOR_TEMPLATES).find(
          key => INDICATOR_TEMPLATES[key].name === agent.indicator?.name
        ) || "custom";
        setIndicatorTemplate(templateKey);
        setIndicatorWeight(agent.indicator.weight);
        setIndicatorStrictMode(agent.indicator.strictMode);
        if (templateKey === "custom") {
          setIndicatorCustomBullish(agent.indicator.signals.bullishCondition);
          setIndicatorCustomBearish(agent.indicator.signals.bearishCondition);
          setIndicatorCustomDescription(agent.indicator.description);
        }
      }
    }
  }, [agent]);

  // When deposit tx confirms, relay to backend
  useEffect(() => {
    if (depositConfirmed && depositTxHash) {
      setDepositStatus("Confirming deposit with relay...");
      fetch("/api/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: depositTxHash, network: activeNetwork }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.success && data.eventType === "deposit" && data.deposit) {
            const d = data.deposit;
            const hlInfo = d.hlFunded
              ? ` HL wallet ${d.hlWalletAddress?.slice(0, 6)}...${d.hlWalletAddress?.slice(-4)} funded $${d.hlFundedAmount}.`
              : "";
            const bridgeInfo = d.bridgeProvider
              ? ` Bridge ${d.bridgeProvider}: ${d.bridgeStatus || "pending"}${
                  d.bridgeTxHash ? ` (${d.bridgeTxHash.slice(0, 10)}...)` : ""
                }.${d.bridgeNote ? ` ${d.bridgeNote}` : ""}`
              : "";
            const hclawInfo = d.rebateBps
              ? ` Tier ${d.lockTier} active. Rebate ${(Number(d.rebateBps) / 100).toFixed(2)}%. Remaining cap $${Number(d.userCapRemainingUsd || 0).toFixed(2)}.`
              : "";
            setDepositStatus(
              `Deposit confirmed! ${d.shares} shares minted.${hlInfo}${bridgeInfo ? ` ${bridgeInfo}` : ""}${hclawInfo}`
            );
            setCapPreview({
              baseCapUsd: Number(d.userCapUsd || 0) / ((Number(d.boostBps || 10_000) || 10_000) / 10_000),
              boostedCapUsd: Number(d.userCapUsd || 0),
              capRemainingUsd: Number(d.userCapRemainingUsd || 0),
              boostBps: Number(d.boostBps || 10_000),
              rebateBps: Number(d.rebateBps || 0),
              tier: Number(d.lockTier || 0),
            });
            setDepositAmount("");
            fetchAgent();
            fetchCapPreview();
          } else if (data.success) {
            setDepositStatus("Deposit confirmed on-chain. Relay sync pending.");
            fetchCapPreview();
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
  }, [activeNetwork, depositConfirmed, depositTxHash, fetchAgent, fetchCapPreview]);

  useEffect(() => {
    if (withdrawConfirmed && withdrawTxHash) {
      setWithdrawStatus("Confirming withdrawal with relay...");
      fetch("/api/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: withdrawTxHash, network: activeNetwork }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.success && data.eventType === "withdrawal") {
            const w = data.withdrawal;
            const bridgeInfo = w?.bridgeProvider
              ? ` Bridge ${w.bridgeProvider}: ${w.bridgeStatus || "pending"}${
                  w.bridgeTxHash ? ` (${String(w.bridgeTxHash).slice(0, 10)}...)` : ""
                }.${w.bridgeNote ? ` ${w.bridgeNote}` : ""}`
              : "";
            setWithdrawStatus(
              `Withdrawal confirmed and synced.${bridgeInfo ? ` ${bridgeInfo}` : ""}`
            );
          } else if (data.success) {
            setWithdrawStatus("Withdrawal confirmed.");
          } else {
            setWithdrawStatus(`Withdrawal confirmed on-chain. Relay note: ${data.error || "sync pending"}`);
          }
          setWithdrawShares("");
          fetchAgent();
          fetchCapPreview();
        })
        .catch(() => {
          setWithdrawStatus("Withdrawal confirmed on-chain. Relay sync pending.");
          fetchAgent();
        })
        .finally(() => {
          setWithdrawTxHash(undefined);
        });
    }
  }, [activeNetwork, withdrawConfirmed, withdrawTxHash, fetchAgent, fetchCapPreview]);

  useEffect(() => {
    if (tab === "chat") {
      fetchChat();
      const interval = setInterval(fetchChat, 5000);
      return () => clearInterval(interval);
    }
  }, [tab, fetchChat]);

  useEffect(() => {
    if (tab !== "deposit") return;
    fetchCapPreview();
  }, [tab, fetchCapPreview]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const handleDeposit = async () => {
    if (!depositAmount || !address || parseFloat(depositAmount) <= 0) return;
    setDepositing(true);
    setDepositStatus("");

    try {
      const vaultCheck = await verifyVaultContract();
      if (!vaultCheck.ok) {
        setDepositStatus(vaultCheck.reason);
        setDepositing(false);
        return;
      }

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
        const amountWei = parseUnits(depositAmount, depositToken.decimals);

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
    } catch (e) {
      console.error("Deposit error:", e);
      setDepositStatus(
        e instanceof Error ? e.message : "Deposit failed. Check wallet and try again."
      );
      setDepositing(false);
    }
  };

  const handleWithdraw = async () => {
    if (!address || !userShares || !totalShares || totalShares === BigInt(0)) return;
    let sharesWei: bigint;
    try {
      sharesWei = parseUnits(withdrawShares || "0", 18);
    } catch {
      setWithdrawStatus("Invalid shares amount.");
      return;
    }
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
      const vaultCheck = await verifyVaultContract();
      if (!vaultCheck.ok) {
        setWithdrawStatus(vaultCheck.reason);
        return;
      }

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

  const handleSaveSettings = async () => {
    setSaving(true);
    setSettingsStatus(null);
    try {
      // Calculate minConfidence from aggressiveness
      const minConfidence = 1 - (editAggressiveness / 100) * 0.5;
      
      // Build indicator config
      const template = INDICATOR_TEMPLATES[indicatorTemplate];
      const indicatorConfig: IndicatorConfig | undefined = indicatorEnabled ? {
        enabled: true,
        name: indicatorTemplate === "custom" ? "Custom Indicator" : template.name,
        description: indicatorTemplate === "custom" ? indicatorCustomDescription : template.description,
        signals: indicatorTemplate === "custom" 
          ? { bullishCondition: indicatorCustomBullish, bearishCondition: indicatorCustomBearish }
          : template.signals,
        weight: indicatorWeight,
        strictMode: indicatorStrictMode,
        parameters: indicatorTemplate === "custom" ? {} : template.parameters,
      } : undefined;
      
      const patchBody: Record<string, unknown> = {
        name: editName,
        description: editDescription,
        markets: editMarkets,
        maxLeverage: editMaxLeverage,
        riskLevel: editRiskLevel,
        stopLossPercent: editStopLoss,
        status: editStatus,
        autonomy: {
          mode: editAutonomyMode,
          aggressiveness: editAggressiveness,
          minConfidence,
          maxTradesPerDay: editMaxTradesPerDay,
          approvalTimeoutMs: agent?.autonomy?.approvalTimeoutMs ?? 300000,
        },
        indicator: indicatorConfig,
      };
      if (editAiApiKeyRemove) {
        patchBody.aiApiKey = null;
      } else if (editAiApiKeyValue.trim()) {
        patchBody.aiApiKey = { provider: editAiApiKeyProvider, value: editAiApiKeyValue.trim() };
      }

      const res = await fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      
      if (!res.ok) {
        throw new Error("Failed to save settings");
      }
      
      setSettingsStatus({ type: "success", message: "Settings saved successfully!" });
      setEditAiApiKeyValue("");
      setEditAiApiKeyRemove(false);
      await fetchAgent();
    } catch (e) {
      console.error("Save settings error:", e);
      setSettingsStatus({ type: "error", message: e instanceof Error ? e.message : "Failed to save settings" });
    } finally {
      setSaving(false);
    }
  };

  const handleTogglePause = async () => {
    const currentStatus = agent?.status;
    if (!currentStatus) return;
    const nextStatus = currentStatus === "active" ? "paused" : "active";

    setPausing(true);
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) {
        throw new Error(`Failed to ${nextStatus === "paused" ? "pause" : "resume"} agent`);
      }
      setEditStatus(nextStatus);
      setSettingsStatus({
        type: "success",
        message: nextStatus === "paused" ? "Agent paused. Data remains intact." : "Agent resumed.",
      });
      await fetchAgent();
    } catch (e) {
      console.error("Pause toggle error:", e);
      setSettingsStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to update agent status",
      });
    } finally {
      setPausing(false);
    }
  };

  const handleAddMarket = (market: string) => {
    if (market && !editMarkets.includes(market)) {
      setEditMarkets([...editMarkets, market]);
    }
  };

  const handleRemoveMarket = (market: string) => {
    setEditMarkets(editMarkets.filter((m) => m !== market));
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

  if (summaryAgent && (!isOwner || !agent)) {
    const pnlTone = summaryAgent.totalPnl >= 0 ? "text-success" : "text-danger";
    return (
      <div className="min-h-screen page-bg relative overflow-hidden">
        <div className="orb orb-green w-[380px] h-[380px] -top-[150px] right-[15%] fixed" />
        <div className="orb orb-purple w-[320px] h-[320px] bottom-[10%] -left-[120px] fixed" />

        <header className="glass sticky top-0 z-50">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
            <Link href="/agents" className="flex items-center gap-3 group">
              <div className="w-11 h-11 rounded-lg bg-white/20 border border-white/30 flex items-center justify-center group-hover:bg-white/25 transition-colors">
                <HyperclawIcon className="text-accent" size={28} />
              </div>
              <span className="text-sm font-semibold">Back to Agents</span>
            </Link>
            <NetworkToggle />
          </div>
        </header>

        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 md:py-10 relative z-10">
          {isOwner && !agent ? (
            <div className="mb-4 p-3 rounded-lg border border-warning/30 bg-warning/10 text-xs text-warning">
              {viewError || "Detailed agent data is temporarily unavailable. Showing summary data."}
            </div>
          ) : null}
          <section className="glass-card rounded-2xl p-5 md:p-6 mb-6">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-12 h-12 rounded-xl overflow-hidden border border-accent/20 shrink-0">
                  <AgentAvatar name={summaryAgent.name} description={summaryAgent.description} size={48} />
                </div>
                <div className="min-w-0">
                  <h1 className="text-2xl font-bold truncate">{summaryAgent.name}</h1>
                  <p className="text-sm text-muted mt-1 line-clamp-2">{summaryAgent.description || "No description"}</p>
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    <span className={`chip ${statusClass(summaryAgent.status)}`}>
                      {summaryAgent.status === "active" ? <span className="w-1.5 h-1.5 rounded-full bg-current pulse-live" /> : null}
                      {summaryAgent.status}
                    </span>
                    <span className={`text-xs font-medium capitalize ${riskClass(summaryAgent.riskLevel)}`}>
                      {summaryAgent.riskLevel}
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-xs text-dim mono-nums">
                Created {new Date(summaryAgent.createdAt).toLocaleDateString()}
              </div>
            </div>
          </section>

          <section className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-6">
            <div className="card rounded-2xl p-4 md:p-5">
              <div className="text-xs text-muted mb-2 uppercase tracking-wider">Total PnL</div>
              <div className={`text-lg md:text-xl font-bold mono-nums ${pnlTone}`}>{formatUsd(summaryAgent.totalPnl)}</div>
            </div>
            <div className="card rounded-2xl p-4 md:p-5">
              <div className="text-xs text-muted mb-2 uppercase tracking-wider">Vault TVL</div>
              <div className="text-lg md:text-xl font-bold mono-nums">${summaryAgent.vaultTvlUsd.toLocaleString()}</div>
            </div>
            <div className="card rounded-2xl p-4 md:p-5">
              <div className="text-xs text-muted mb-2 uppercase tracking-wider">Total Trades</div>
              <div className="text-lg md:text-xl font-bold mono-nums">{summaryAgent.totalTrades}</div>
            </div>
            <div className="card rounded-2xl p-4 md:p-5">
              <div className="text-xs text-muted mb-2 uppercase tracking-wider">Win Rate</div>
              <div className="text-lg md:text-xl font-bold mono-nums">{(summaryAgent.winRate * 100).toFixed(1)}%</div>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="card rounded-2xl p-5">
              <h2 className="text-sm font-semibold mb-3">Markets</h2>
              <div className="flex flex-wrap gap-2">
                {summaryAgent.markets.map((market) => (
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
                  <span className={`font-medium capitalize ${riskClass(summaryAgent.riskLevel)}`}>{summaryAgent.riskLevel}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Max Leverage</span>
                  <span className="font-medium mono-nums">{summaryAgent.maxLeverage}x</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Markets Traded</span>
                  <span className="font-medium mono-nums">{summaryAgent.markets.length}</span>
                </div>
              </div>
            </div>
          </section>
        </main>
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
          {viewError ? <p className="text-sm text-muted mb-2">{viewError}</p> : null}
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
    { key: "settings", label: "Settings" },
  ];

  return (
    <div className="min-h-screen page-bg relative overflow-hidden">
      <div className="orb orb-green w-[500px] h-[500px] -top-[200px] right-[10%] fixed" />
      <div className="orb orb-purple w-[400px] h-[400px] bottom-[10%] -left-[150px] fixed" />
      <div className="orb orb-purple w-[300px] h-[300px] top-[18%] left-[8%] fixed" />

      {/* Header */}
      <header className="glass sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <Link href="/" className="flex items-center gap-3 group shrink-0">
              <div className="w-11 h-11 rounded-lg bg-white/20 border border-white/30 flex items-center justify-center group-hover:bg-white/25 transition-colors">
                <HyperclawIcon className="text-accent" size={28} />
              </div>
            </Link>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-dim shrink-0"><path d="M9 18l6-6-6-6" /></svg>
            <Link href="/agents" className="text-muted hover:text-foreground transition-colors shrink-0">Agents</Link>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-dim shrink-0"><path d="M9 18l6-6-6-6" /></svg>
            <span className="text-foreground font-medium truncate">{agent.name}</span>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <TelegramChatButton />
            <NetworkToggle />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 md:py-12 relative z-10">
        {/* Agent identity */}
        <div className="flex flex-col md:flex-row items-start gap-6 mb-6">
          <div className="w-16 h-16 rounded-2xl overflow-hidden border border-accent/20 shrink-0">
            <AgentAvatar name={agent.name} description={agent.description} size={64} />
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

        {/* Runner Status Banner */}
        {agent.status === "active" && (
          <div className={`mb-6 p-4 rounded-2xl border ${
            lifecycle?.healthStatus === "healthy" 
              ? "bg-success/5 border-success/20"
              : lifecycle?.healthStatus === "degraded"
              ? "bg-warning/5 border-warning/20"
              : lifecycle?.healthStatus === "unhealthy"
              ? "bg-danger/5 border-danger/20"
              : "bg-surface border-card-border"
          }`}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                {/* Runner Status */}
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    lifecycle?.runnerActive ? "bg-success animate-pulse" : "bg-muted"
                  }`} />
                  <span className="text-sm font-medium">
                    {lifecycle?.runnerActive ? "Runner Active" : "Runner Stopped"}
                  </span>
                </div>

                {/* AIP Status */}
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    lifecycle?.aipRegistered ? "bg-accent" : "bg-muted"
                  }`} />
                  <span className="text-sm text-muted">
                    {lifecycle?.aipRegistered ? "AIP Registered" : "AIP Not Registered"}
                  </span>
                </div>

                {/* Health Badge */}
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  lifecycle?.healthStatus === "healthy"
                    ? "bg-success/15 text-success"
                    : lifecycle?.healthStatus === "degraded"
                    ? "bg-warning/15 text-warning"
                    : lifecycle?.healthStatus === "unhealthy"
                    ? "bg-danger/15 text-danger"
                    : "bg-muted/15 text-muted"
                }`}>
                  {lifecycle?.healthStatus || "unknown"}
                </span>
              </div>

              <div className="flex items-center gap-3 text-xs text-dim">
                {lifecycle?.tickCount !== undefined && (
                  <span>Ticks: {lifecycle.tickCount}</span>
                )}
                {lifecycle?.lastTickAt && (
                  <span>Last: {new Date(lifecycle.lastTickAt).toLocaleTimeString()}</span>
                )}
                
                {/* Start/Activate Button - shown when not running */}
                {!lifecycle?.runnerActive && (
                  <button
                    onClick={async () => {
                      setTicking(true);
                      try {
                        await fetch("/api/fund", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ action: "activate", agentId }),
                        });
                        await fetchAgent();
                      } finally {
                        setTicking(false);
                      }
                    }}
                    disabled={ticking}
                    className="px-4 py-1.5 text-xs rounded-lg bg-success/15 border border-success/30 text-success hover:bg-success/20 transition-colors disabled:opacity-50 font-medium"
                  >
                    {ticking ? "Starting..." : "Start Agent"}
                  </button>
                )}
                
                {/* Manual Tick Button */}
                <button
                  onClick={async () => {
                    setTicking(true);
                    try {
                      await fetch(`/api/agents/${agentId}/tick`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "tick" }),
                      });
                      await fetchAgent();
                    } finally {
                      setTicking(false);
                    }
                  }}
                  disabled={ticking}
                  className="px-3 py-1.5 text-xs rounded-lg bg-accent/10 border border-accent/20 text-accent hover:bg-accent/15 transition-colors disabled:opacity-50"
                >
                  {ticking ? "Running..." : "Manual Tick"}
                </button>
              </div>
            </div>
          </div>
        )}
        
        {/* Activation Banner - shown when agent is not active but has balance */}
        {agent.status !== "active" && hlBalance?.hasWallet && parseFloat(hlBalance.accountValue || "0") >= 1 && (
          <div className="mb-6 p-4 rounded-2xl border bg-accent/5 border-accent/20">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h4 className="text-sm font-semibold text-accent mb-1">Agent Ready to Activate</h4>
                <p className="text-xs text-muted">
                  This agent has ${parseFloat(hlBalance.accountValue || "0").toFixed(2)} available. 
                  Start the autonomous trading runner and register with Unibase AIP.
                </p>
              </div>
              <button
                onClick={async () => {
                  setTicking(true);
                  try {
                    await fetch("/api/fund", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "activate", agentId }),
                    });
                    await fetchAgent();
                  } finally {
                    setTicking(false);
                  }
                }}
                disabled={ticking}
                className="btn-primary px-6 py-2.5 text-sm"
              >
                {ticking ? "Activating..." : "Activate Agent"}
              </button>
            </div>
          </div>
        )}

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-3 mb-10">
          {[
            {
              label: "Total PnL",
              value: (() => {
                const pnl = hlBalance?.hasWallet && typeof hlBalance.totalPnl === "number"
                  ? hlBalance.totalPnl
                  : agent.totalPnl;
                return `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
              })(),
              color: (() => {
                const pnl = hlBalance?.hasWallet && typeof hlBalance.totalPnl === "number"
                  ? hlBalance.totalPnl
                  : agent.totalPnl;
                return pnl >= 0 ? "text-success" : "text-danger";
              })(),
            },
            {
              label: "Unrealized PnL",
              value: hlPositions.length > 0 
                ? `${totalUnrealizedPnl >= 0 ? "+" : ""}$${totalUnrealizedPnl.toFixed(2)}`
                : "-",
              color: totalUnrealizedPnl >= 0 ? "text-success" : "text-danger",
            },
            { label: "Vault TVL", value: `$${agent.vaultTvlUsd.toLocaleString()}`, color: "text-foreground" },
            {
              label: hlBalance?.stale ? "HL Balance (stale)" : "HL Balance",
              value: hlBalance?.hasWallet
                ? `$${parseFloat(hlBalance.accountValue || "0").toFixed(2)}`
                : "No wallet",
              color: hlBalance?.stale ? "text-warning" : hlBalance?.hasWallet ? "text-accent" : "text-dim",
            },
            {
              label: "Active Positions",
              value: String(hlPositions.length),
              color: hlPositions.length > 0 ? "text-accent" : "text-dim",
            },
            { label: "Total Trades", value: String(agent.totalTrades), color: "text-foreground" },
            { label: "Win Rate", value: `${(agent.winRate * 100).toFixed(1)}%`, color: "text-foreground" },
            { label: "Your Share", value: `${sharePercent.toFixed(2)}%`, color: "gradient-text" },
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
              {/* Stale data warning */}
              {hlBalance?.stale && (
                <div className="p-3 rounded-xl bg-warning/5 border border-warning/20 flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-warning shrink-0" />
                  <p className="text-xs text-warning">
                    Hyperliquid API is slow — balance and position data may be stale.
                    {hlBalance.error && <span className="text-dim ml-1">({hlBalance.error})</span>}
                  </p>
                </div>
              )}

              {/* Active Positions */}
              {hlPositions.length > 0 && (
                <div className="card rounded-2xl p-6 md:p-8">
                  <div className="flex items-center justify-between mb-5">
                    <h3 className="font-semibold text-sm uppercase tracking-wider text-muted">Active Positions</h3>
                    <div className={`text-sm font-bold mono-nums ${totalUnrealizedPnl >= 0 ? "text-success" : "text-danger"}`}>
                      Total: {totalUnrealizedPnl >= 0 ? "+" : ""}${totalUnrealizedPnl.toFixed(2)}
                    </div>
                  </div>
                  <div className="overflow-x-auto -mx-6 md:-mx-8 px-6 md:px-8">
                    <table className="w-full text-sm min-w-[600px]">
                      <thead>
                        <tr className="text-[11px] text-dim uppercase tracking-wider text-left border-b border-card-border">
                          <th className="pb-3 font-medium">Asset</th>
                          <th className="pb-3 font-medium">Side</th>
                          <th className="pb-3 font-medium text-right">Size</th>
                          <th className="pb-3 font-medium text-right">Entry</th>
                          <th className="pb-3 font-medium text-right">Mark</th>
                          <th className="pb-3 font-medium text-right">Value</th>
                          <th className="pb-3 font-medium text-right">uPnL</th>
                          <th className="pb-3 font-medium text-right">Lev</th>
                          <th className="pb-3 font-medium text-right">Liq. Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hlPositions.map((pos) => (
                          <tr key={pos.coin} className="border-b border-card-border/50 last:border-0">
                            <td className="py-3 font-semibold text-foreground">{pos.coin}</td>
                            <td className="py-3">
                              <span className={`chip ${
                                pos.side === "long" ? "chip-active" : "bg-danger/15 text-danger"
                              } uppercase text-[10px] font-semibold tracking-wider`}>
                                {pos.side}
                              </span>
                            </td>
                            <td className="py-3 text-right mono-nums">{pos.size.toFixed(4)}</td>
                            <td className="py-3 text-right mono-nums text-muted">${pos.entryPrice.toFixed(2)}</td>
                            <td className="py-3 text-right mono-nums">${pos.markPrice.toFixed(2)}</td>
                            <td className="py-3 text-right mono-nums">${pos.positionValue.toFixed(2)}</td>
                            <td className={`py-3 text-right mono-nums font-medium ${
                              pos.unrealizedPnl >= 0 ? "text-success" : "text-danger"
                            }`}>
                              {pos.unrealizedPnl >= 0 ? "+" : ""}${pos.unrealizedPnl.toFixed(2)}
                              <span className="text-[10px] text-dim ml-1">
                                ({pos.unrealizedPnlPercent >= 0 ? "+" : ""}{pos.unrealizedPnlPercent.toFixed(2)}%)
                              </span>
                            </td>
                            <td className="py-3 text-right mono-nums text-accent">{pos.leverage}x</td>
                            <td className="py-3 text-right mono-nums text-warning">
                              {pos.liquidationPrice ? `$${pos.liquidationPrice.toFixed(2)}` : "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* No positions placeholder */}
              {hlPositions.length === 0 && hlBalance?.hasWallet && (
                <div className="card rounded-2xl p-6 md:p-8">
                  <h3 className="font-semibold text-sm uppercase tracking-wider text-muted mb-5">Active Positions</h3>
                  <div className="flex items-center justify-center py-8 text-center">
                    <div>
                      <div className="w-12 h-12 rounded-2xl bg-surface border border-card-border flex items-center justify-center mx-auto mb-3">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-dim">
                          <path d="M3 3v18h18" strokeLinecap="round" /><path d="M7 16l4-8 4 4 4-6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <p className="text-muted text-sm">No active positions</p>
                      <p className="text-dim text-xs mt-1">Agent will open positions based on market conditions</p>
                    </div>
                  </div>
                </div>
              )}

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
                    <span className="text-dim text-sm">No wallet — deposit MON or a stablecoin in the Deposit tab to provision one.</span>
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
                          <td className="px-5 py-3.5 text-dim text-xs max-w-[200px]">
                            <ReasoningCell reasoning={trade.decision.reasoning} />
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
                  <div className="grid grid-cols-2 gap-2">
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

                {/* Cap + rebate context */}
                <div className="mb-4 p-3 rounded-xl border border-card-border bg-surface/60">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-muted uppercase tracking-wider">HCLAW Deposit Context</span>
                    {capPreviewLoading ? (
                      <span className="text-[10px] text-dim">Loading...</span>
                    ) : capPreview ? (
                      <span className="text-[10px] text-accent font-medium">Tier {capPreview.tier}</span>
                    ) : (
                      <span className="text-[10px] text-dim">No lock boost</span>
                    )}
                  </div>
                  {capPreview ? (
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                      <div className="flex justify-between">
                        <span className="text-dim">Base Cap</span>
                        <span className="mono-nums text-muted">${capPreview.baseCapUsd.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-dim">Boost</span>
                        <span className="mono-nums text-accent">{(capPreview.boostBps / 10_000).toFixed(2)}x</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-dim">User Cap</span>
                        <span className="mono-nums text-muted">${capPreview.boostedCapUsd.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-dim">Remaining</span>
                        <span className="mono-nums text-foreground">${capPreview.capRemainingUsd.toFixed(2)}</span>
                      </div>
                      <div className="col-span-2 flex justify-between">
                        <span className="text-dim">Rebate Tier</span>
                        <span className="mono-nums text-success">{(capPreview.rebateBps / 100).toFixed(2)}%</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-dim">
                      Lock HCLAW to unlock boosted deposit caps and fee rebates.
                    </p>
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
                        No HL wallet yet. Deposit MON or a stablecoin to auto-provision + fund.
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

          {tab === "settings" && (
            <div className="max-w-2xl mx-auto space-y-6">
              {/* Status Banner */}
              {settingsStatus && (
                <div className={`p-4 rounded-xl text-sm ${
                  settingsStatus.type === "success" 
                    ? "bg-success/10 border border-success/20 text-success" 
                    : "bg-danger/10 border border-danger/20 text-danger"
                }`}>
                  {settingsStatus.message}
                </div>
              )}

              {/* Agent Status */}
              <div className="card rounded-2xl p-6">
                <h3 className="font-semibold text-sm uppercase tracking-wider text-muted mb-5">Agent Status</h3>
                <div className="grid grid-cols-3 gap-3">
                  {(["active", "paused", "stopped"] as const).map((status) => (
                    <button
                      key={status}
                      onClick={() => setEditStatus(status)}
                      className={`py-3 rounded-xl text-sm font-medium transition-all capitalize ${
                        editStatus === status
                          ? status === "active" 
                            ? "bg-success/15 border border-success/40 text-success"
                            : status === "paused"
                            ? "bg-warning/15 border border-warning/40 text-warning"
                            : "bg-danger/15 border border-danger/40 text-danger"
                          : "bg-surface border border-card-border text-muted hover:text-foreground"
                      }`}
                    >
                      {status}
                    </button>
                  ))}
                </div>
              </div>

              {/* Basic Info */}
              <div className="card rounded-2xl p-6">
                <h3 className="font-semibold text-sm uppercase tracking-wider text-muted mb-5">Basic Info</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">Name</label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="input w-full px-4 py-3"
                      placeholder="Agent name"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">Description</label>
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      className="input w-full px-4 py-3 min-h-[100px] resize-y"
                      placeholder="What does this agent do?"
                    />
                  </div>
                </div>
              </div>

              {/* Trading Strategy */}
              <div className="card rounded-2xl p-6">
                <h3 className="font-semibold text-sm uppercase tracking-wider text-muted mb-5">Trading Strategy</h3>
                <div className="space-y-5">
                  {/* Markets */}
                  <div>
                    <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">Markets</label>
                    <div className="flex flex-wrap gap-2 mb-3">
                      {editMarkets.map((market) => (
                        <span
                          key={market}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/10 border border-accent/20 text-accent text-sm font-medium"
                        >
                          {market}
                          <button
                            onClick={() => handleRemoveMarket(market)}
                            className="hover:text-danger transition-colors"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <select
                        className="input flex-1 px-4 py-2.5"
                        onChange={(e) => {
                          handleAddMarket(e.target.value);
                          e.target.value = "";
                        }}
                        defaultValue=""
                      >
                        <option value="" disabled>Add market...</option>
                        {["BTC", "ETH", "SOL", "ARB", "OP", "AVAX", "MATIC", "DOGE", "PEPE", "WIF", "BONK", "LINK", "UNI", "AAVE"].filter((m) => !editMarkets.includes(m)).map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Risk Level */}
                  <div>
                    <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">Risk Level</label>
                    <div className="grid grid-cols-3 gap-3">
                      {(["conservative", "moderate", "aggressive"] as const).map((level) => (
                        <button
                          key={level}
                          onClick={() => setEditRiskLevel(level)}
                          className={`py-2.5 rounded-xl text-sm font-medium transition-all capitalize ${
                            editRiskLevel === level
                              ? level === "conservative"
                                ? "bg-success/15 border border-success/40 text-success"
                                : level === "moderate"
                                ? "bg-warning/15 border border-warning/40 text-warning"
                                : "bg-danger/15 border border-danger/40 text-danger"
                              : "bg-surface border border-card-border text-muted hover:text-foreground"
                          }`}
                        >
                          {level}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Max Leverage */}
                  <div>
                    <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">
                      Max Leverage: <span className="text-accent">{editMaxLeverage}x</span>
                    </label>
                    <input
                      type="range"
                      min="1"
                      max="50"
                      value={editMaxLeverage}
                      onChange={(e) => setEditMaxLeverage(parseInt(e.target.value))}
                      className="w-full accent-accent"
                    />
                    <div className="flex justify-between text-[10px] text-dim mt-1">
                      <span>1x</span>
                      <span>50x</span>
                    </div>
                  </div>

                  {/* Stop Loss */}
                  <div>
                    <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">
                      Stop Loss: <span className="text-danger">{editStopLoss}%</span>
                    </label>
                    <input
                      type="range"
                      min="1"
                      max="25"
                      value={editStopLoss}
                      onChange={(e) => setEditStopLoss(parseInt(e.target.value))}
                      className="w-full accent-danger"
                    />
                    <div className="flex justify-between text-[10px] text-dim mt-1">
                      <span>1%</span>
                      <span>25%</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Autonomy Settings */}
              <div className="card rounded-2xl p-6">
                <h3 className="font-semibold text-sm uppercase tracking-wider text-muted mb-5">Autonomy Settings</h3>
                <div className="space-y-5">
                  {/* Autonomy Mode */}
                  <div>
                    <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">Trading Mode</label>
                    <div className="grid grid-cols-3 gap-3">
                      {([
                        { mode: "full" as const, label: "Full Auto", icon: "🤖", desc: "Trades automatically" },
                        { mode: "semi" as const, label: "Semi-Auto", icon: "🤝", desc: "Requires approval" },
                        { mode: "manual" as const, label: "Manual", icon: "👤", desc: "You trigger trades" },
                      ]).map(({ mode, label, icon }) => (
                        <button
                          key={mode}
                          onClick={() => setEditAutonomyMode(mode)}
                          className={`py-3 rounded-xl text-sm font-medium transition-all ${
                            editAutonomyMode === mode
                              ? "bg-accent/15 border border-accent/40 text-accent"
                              : "bg-surface border border-card-border text-muted hover:text-foreground"
                          }`}
                        >
                          <span className="mr-1.5">{icon}</span>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Aggressiveness */}
                  <div>
                    <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">
                      Aggressiveness: <span className={`${
                        editAggressiveness > 70 ? "text-danger" : editAggressiveness > 40 ? "text-warning" : "text-success"
                      }`}>{editAggressiveness}%</span>
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={editAggressiveness}
                      onChange={(e) => setEditAggressiveness(parseInt(e.target.value))}
                      className="w-full accent-accent"
                    />
                    <div className="flex justify-between text-[10px] text-dim mt-1">
                      <span>Conservative</span>
                      <span>Aggressive</span>
                    </div>
                    <p className="text-xs text-dim mt-2">
                      Min confidence required: {(1 - (editAggressiveness / 100) * 0.5).toFixed(0)}%
                    </p>
                  </div>

                  {/* Max Trades Per Day */}
                  <div>
                    <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">
                      Max Trades Per Day: <span className="text-accent">{editMaxTradesPerDay}</span>
                    </label>
                    <input
                      type="range"
                      min="1"
                      max="100"
                      value={editMaxTradesPerDay}
                      onChange={(e) => setEditMaxTradesPerDay(parseInt(e.target.value))}
                      className="w-full accent-accent"
                    />
                    <div className="flex justify-between text-[10px] text-dim mt-1">
                      <span>1</span>
                      <span>100</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* AI API Key */}
              <div className="card rounded-2xl p-6">
                <h3 className="font-semibold text-sm uppercase tracking-wider text-muted mb-2">AI API Key</h3>
                <p className="text-xs text-dim mb-4">
                  Platform model access is uncapped. Add an Anthropic or OpenAI key to force this agent onto your own provider credentials.
                </p>
                <div className="space-y-4">
                  {agent?.aiApiKey && !editAiApiKeyRemove && (
                    <div className="flex items-center gap-2 p-3 rounded-xl bg-success/10 border border-success/20">
                      <span className="text-success text-sm font-medium">
                        Configured ({agent.aiApiKey.provider === "anthropic" ? "Anthropic" : "OpenAI"})
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditAiApiKeyRemove(true)}
                        className="text-xs text-danger hover:underline ml-auto"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                  {(!agent?.aiApiKey || editAiApiKeyRemove || editAiApiKeyValue) && (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">Provider</label>
                        <select
                          value={editAiApiKeyProvider}
                          onChange={(e) => setEditAiApiKeyProvider(e.target.value as "anthropic" | "openai")}
                          className="input w-full px-4 py-3"
                        >
                          <option value="anthropic">Anthropic (Claude)</option>
                          <option value="openai">OpenAI (GPT)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">
                          API Key {agent?.aiApiKey && editAiApiKeyRemove ? "(clearing on save)" : ""}
                        </label>
                        <input
                          type="password"
                          value={editAiApiKeyValue}
                          onChange={(e) => setEditAiApiKeyValue(e.target.value)}
                          className="input w-full px-4 py-3 font-mono text-sm"
                          placeholder={
                            agent?.aiApiKey && !editAiApiKeyRemove
                              ? "Enter new key to replace"
                              : "sk-... (stored encrypted, never shared)"
                          }
                        />
                      </div>
                      {editAiApiKeyRemove && (
                        <button
                          type="button"
                          onClick={() => setEditAiApiKeyRemove(false)}
                          className="text-xs text-muted hover:text-foreground"
                        >
                          Cancel remove
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Indicator Settings */}
              <div className="card rounded-2xl p-6">
                <div className="flex items-center justify-between mb-5">
                  <h3 className="font-semibold text-sm uppercase tracking-wider text-muted">Key Indicator</h3>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <span className="text-xs text-dim">{indicatorEnabled ? "Enabled" : "Disabled"}</span>
                    <div
                      onClick={() => setIndicatorEnabled(!indicatorEnabled)}
                      className={`relative w-10 h-5 rounded-full transition-colors ${
                        indicatorEnabled ? "bg-accent" : "bg-surface"
                      }`}
                    >
                      <div
                        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          indicatorEnabled ? "translate-x-5" : "translate-x-0.5"
                        }`}
                      />
                    </div>
                  </label>
                </div>

                {indicatorEnabled && (
                  <div className="space-y-5">
                    {/* Indicator Template */}
                    <div>
                      <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">Indicator Type</label>
                      <select
                        value={indicatorTemplate}
                        onChange={(e) => setIndicatorTemplate(e.target.value)}
                        className="input w-full px-4 py-3"
                      >
                        <option value="adaptive-rsi-divergence">Adaptive RSI with Divergence</option>
                        <option value="smart-money-concepts">Smart Money Concepts (SMC)</option>
                        <option value="custom">Custom Indicator</option>
                      </select>
                    </div>

                    {/* Template Description */}
                    {indicatorTemplate !== "custom" && (
                      <div className="bg-surface/50 rounded-xl p-4 border border-card-border">
                        <p className="text-sm text-muted mb-3">
                          {INDICATOR_TEMPLATES[indicatorTemplate]?.description}
                        </p>
                        <div className="space-y-2 text-xs">
                          <div>
                            <span className="text-success font-medium">Bullish: </span>
                            <span className="text-dim">{INDICATOR_TEMPLATES[indicatorTemplate]?.signals.bullishCondition}</span>
                          </div>
                          <div>
                            <span className="text-danger font-medium">Bearish: </span>
                            <span className="text-dim">{INDICATOR_TEMPLATES[indicatorTemplate]?.signals.bearishCondition}</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Custom Indicator Fields */}
                    {indicatorTemplate === "custom" && (
                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">Description</label>
                          <textarea
                            value={indicatorCustomDescription}
                            onChange={(e) => setIndicatorCustomDescription(e.target.value)}
                            className="input w-full px-4 py-3 min-h-[80px] resize-y"
                            placeholder="Describe your indicator and what it measures..."
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">
                            <span className="text-success">Bullish</span> Condition
                          </label>
                          <textarea
                            value={indicatorCustomBullish}
                            onChange={(e) => setIndicatorCustomBullish(e.target.value)}
                            className="input w-full px-4 py-3 min-h-[80px] resize-y"
                            placeholder="Describe when the indicator signals bullish (e.g., 'RSI crosses above 30 with positive divergence')"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">
                            <span className="text-danger">Bearish</span> Condition
                          </label>
                          <textarea
                            value={indicatorCustomBearish}
                            onChange={(e) => setIndicatorCustomBearish(e.target.value)}
                            className="input w-full px-4 py-3 min-h-[80px] resize-y"
                            placeholder="Describe when the indicator signals bearish (e.g., 'RSI crosses below 70 with negative divergence')"
                          />
                        </div>
                      </div>
                    )}

                    {/* Weight Slider */}
                    <div>
                      <label className="block text-xs font-medium text-dim uppercase tracking-wider mb-2">
                        Signal Weight: <span className="text-accent">{indicatorWeight}%</span>
                      </label>
                      <input
                        type="range"
                        min="10"
                        max="100"
                        value={indicatorWeight}
                        onChange={(e) => setIndicatorWeight(parseInt(e.target.value))}
                        className="w-full accent-accent"
                      />
                      <div className="flex justify-between text-[10px] text-dim mt-1">
                        <span>10% (Light influence)</span>
                        <span>100% (Primary signal)</span>
                      </div>
                    </div>

                    {/* Strict Mode Toggle */}
                    <div className="flex items-center justify-between py-3 px-4 rounded-xl bg-surface/50 border border-card-border">
                      <div>
                        <div className="text-sm font-medium text-foreground">Strict Mode</div>
                        <p className="text-xs text-dim mt-0.5">
                          {indicatorStrictMode 
                            ? "Agent will strongly follow indicator signals unless there's clear counter-evidence"
                            : "Agent uses indicator as one of many inputs for decision making"}
                        </p>
                      </div>
                      <div
                        onClick={() => setIndicatorStrictMode(!indicatorStrictMode)}
                        className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer ${
                          indicatorStrictMode ? "bg-warning" : "bg-surface"
                        }`}
                      >
                        <div
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                            indicatorStrictMode ? "translate-x-5" : "translate-x-0.5"
                          }`}
                        />
                      </div>
                    </div>

                    {/* Info Box */}
                    <div className="bg-accent/5 border border-accent/20 rounded-xl p-4">
                      <div className="flex gap-3">
                        <svg className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                          <path d="M12 16v-4M12 8h.01" />
                        </svg>
                        <div className="text-xs text-muted">
                          <p className="mb-2">
                            When enabled, the AI will evaluate this indicator and use it as a key signal source for trading decisions.
                          </p>
                          <p>
                            The AI can still <strong className="text-foreground">reason against</strong> the indicator if market conditions clearly contradict it, providing explanations in its trade reasoning.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Save Button */}
              <button
                onClick={handleSaveSettings}
                disabled={saving}
                className="btn-primary w-full py-4 text-sm"
              >
                {saving ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                    Saving...
                  </span>
                ) : "Save Settings"}
              </button>

              {/* Lifecycle Control */}
              <div className="card rounded-2xl p-6 border-warning/20 bg-warning/5">
                <h3 className="font-semibold text-sm uppercase tracking-wider text-warning mb-3">Lifecycle Control</h3>
                <p className="text-sm text-muted mb-4">
                  Pausing stops automated execution but keeps all agent data, history, and configuration.
                </p>
                <button
                  onClick={handleTogglePause}
                  disabled={pausing}
                  className={`px-6 py-3 rounded-xl text-sm font-medium transition-all ${
                    agent.status === "active"
                      ? "bg-warning/10 border border-warning/20 text-warning hover:bg-warning/15"
                      : "bg-success/10 border border-success/20 text-success hover:bg-success/15"
                  }`}
                >
                  {pausing ? (
                    <span className="flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                      Updating...
                    </span>
                  ) : agent.status === "active" ? (
                    "Pause Agent"
                  ) : (
                    "Resume Agent"
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
