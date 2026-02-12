"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { TelegramChatButton } from "@/app/components/TelegramChatButton";
import { useAccount } from "wagmi";

interface HclawPageData {
  state?: {
    marketCap: number;
    price: number;
    lockTier?: number;
    hclawPower?: number;
    boostedCapUsd?: number;
    rebateBps?: number;
    pointsThisEpoch?: number;
    claimableRebateUsd?: number;
    claimableIncentiveHclaw?: number;
  };
  lock?: {
    tier: number;
    power: number;
    lockIds: string[];
  };
  points?: {
    epoch: { epochId: string; endTs: number };
    points: {
      lockPoints: number;
      lpPoints: number;
      refPoints: number;
      questPoints: number;
      totalPoints: number;
    };
  };
  rewards?: {
    rewards: Array<{
      epochId: string;
      rebateUsd: number;
      incentiveHclaw: number;
      claimed: boolean;
    }>;
    claimableRebateUsd: number;
    claimableIncentiveHclaw: number;
  };
  treasury?: {
    totals: {
      amountUsd: number;
      buybackUsd: number;
      incentiveUsd: number;
      reserveUsd: number;
    };
    agenticVault?: {
      configured: boolean;
      paused: boolean;
      killSwitch: boolean;
      cumulativeRealizedPnlUsd: number;
      inventorySkewBps: number;
      drawdownBps: number;
    };
  };
}

export default function HclawHubPage() {
  const { address, isConnected } = useAccount();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<HclawPageData>({});
  const [claiming, setClaiming] = useState(false);
  const [claimStatus, setClaimStatus] = useState("");
  const [previewAmount, setPreviewAmount] = useState("100");
  const [previewDuration, setPreviewDuration] = useState<30 | 90 | 180>(30);
  const [lockPreview, setLockPreview] = useState<
    | {
        power: number;
        tier: number;
        boostBps: number;
        rebateBps: number;
      }
    | null
  >(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const userParam = address ? `?user=${address}` : "";

        const [stateRes, lockRes, pointsRes, rewardsRes, treasuryRes] = await Promise.all([
          fetch(`/api/hclaw/state${userParam}`),
          fetch(`/api/hclaw/lock${userParam}`),
          fetch(`/api/hclaw/points${userParam}`),
          fetch(`/api/hclaw/rewards${userParam}`),
          fetch(`/api/hclaw/treasury`),
        ]);

        const [stateJson, lockJson, pointsJson, rewardsJson, treasuryJson] = await Promise.all([
          stateRes.json(),
          lockRes.json(),
          pointsRes.json(),
          rewardsRes.json(),
          treasuryRes.json(),
        ]);

        if (cancelled) return;

        setData({
          state: stateJson?.state,
          lock: lockJson?.lock,
          points: pointsJson?.summary,
          rewards: rewardsJson,
          treasury: treasuryJson,
        });
      } catch {
        if (!cancelled) {
          setData({});
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [address]);

  async function handlePreview() {
    try {
      const res = await fetch(`/api/hclaw/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "preview",
          amount: Number(previewAmount),
          durationDays: previewDuration,
        }),
      });
      const body = await res.json();
      setLockPreview(body?.preview ?? null);
    } catch {
      setLockPreview(null);
    }
  }

  async function handleClaim() {
    if (!address || !data.rewards?.rewards?.length) return;

    const target = data.rewards.rewards.find((reward) => !reward.claimed);
    if (!target) {
      setClaimStatus("Nothing claimable right now.");
      return;
    }

    setClaiming(true);
    setClaimStatus("");
    try {
      const res = await fetch(`/api/hclaw/rewards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAddress: address, epochId: target.epochId }),
      });
      const body = await res.json();
      if (res.ok && body?.success) {
        setClaimStatus(`Claimed epoch ${target.epochId}.`);
      } else {
        setClaimStatus(body?.error || "Claim failed.");
      }
    } catch {
      setClaimStatus("Claim failed.");
    } finally {
      setClaiming(false);
    }
  }

  const epochCountdown = useMemo(() => {
    const endTs = data.points?.epoch?.endTs;
    if (!endTs) return "--";
    const remainingMs = Math.max(0, endTs - Date.now());
    const hours = Math.floor(remainingMs / (60 * 60 * 1000));
    const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
    return `${hours}h ${minutes}m`;
  }, [data.points?.epoch?.endTs]);

  return (
    <div className="min-h-screen page-bg relative overflow-hidden">
      <div className="orb orb-green w-[460px] h-[460px] -top-[180px] -right-[160px] fixed" />
      <div className="orb orb-purple w-[420px] h-[420px] bottom-[8%] -left-[160px] fixed" />

      <header className="glass sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-sm text-muted hover:text-foreground">Back</Link>
            <h1 className="text-lg font-semibold gradient-title">HCLAW Hub</h1>
          </div>
          <div className="flex items-center gap-2">
            <TelegramChatButton />
            <span className="text-xs text-dim">
              {isConnected && address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Connect wallet"}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 md:py-10 relative z-10 space-y-5">
        {loading ? (
          <div className="card rounded-2xl p-6 text-sm text-dim">Loading HCLAW hub...</div>
        ) : (
          <>
            <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Market Cap" value={`$${Number(data.state?.marketCap ?? 0).toLocaleString()}`} />
              <Stat label="Locked Tier" value={`Tier ${data.state?.lockTier ?? 0}`} />
              <Stat label="HCLAW Power" value={Number(data.state?.hclawPower ?? 0).toFixed(2)} />
              <Stat label="Boosted Cap" value={`$${Number(data.state?.boostedCapUsd ?? 0).toFixed(2)}`} />
            </section>

            <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="card rounded-2xl p-5">
                <h2 className="text-sm font-semibold mb-3">Lock Manager</h2>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <input
                    type="number"
                    value={previewAmount}
                    onChange={(e) => setPreviewAmount(e.target.value)}
                    className="input py-2.5 text-sm"
                    placeholder="Amount"
                  />
                  <select
                    value={previewDuration}
                    onChange={(e) => setPreviewDuration(Number(e.target.value) as 30 | 90 | 180)}
                    className="input py-2.5 text-sm"
                  >
                    <option value={30}>30d</option>
                    <option value={90}>90d</option>
                    <option value={180}>180d</option>
                  </select>
                </div>
                <button onClick={handlePreview} className="btn-primary px-4 py-2 text-sm">Preview Lock</button>
                {lockPreview && (
                  <div className="mt-3 p-3 rounded-xl bg-surface border border-card-border text-xs space-y-1">
                    <div>Tier: {lockPreview.tier}</div>
                    <div>HCLAW Power: {lockPreview.power.toFixed(2)}</div>
                    <div>Boost: {(lockPreview.boostBps / 10_000).toFixed(2)}x</div>
                    <div>Rebate: {(lockPreview.rebateBps / 100).toFixed(2)}%</div>
                  </div>
                )}
                <p className="text-xs text-dim mt-3">
                  Lock transactions are prepared via `/api/hclaw/lock` and signed from wallet clients.
                </p>
              </div>

              <div className="card rounded-2xl p-5">
                <h2 className="text-sm font-semibold mb-3">Points + Epoch</h2>
                <div className="text-xs text-dim mb-2">Current epoch ends in {epochCountdown}</div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <Metric label="Lock" value={Number(data.points?.points?.lockPoints ?? 0).toFixed(2)} />
                  <Metric label="LP" value={Number(data.points?.points?.lpPoints ?? 0).toFixed(2)} />
                  <Metric label="Referral" value={Number(data.points?.points?.refPoints ?? 0).toFixed(2)} />
                  <Metric label="Quest" value={Number(data.points?.points?.questPoints ?? 0).toFixed(2)} />
                </div>
                <div className="mt-3 text-sm font-semibold">Total: {Number(data.points?.points?.totalPoints ?? 0).toFixed(2)}</div>
              </div>

              <div className="card rounded-2xl p-5">
                <h2 className="text-sm font-semibold mb-3">Claim Center</h2>
                <div className="text-xs text-dim mb-1">
                  Claimable rebate: ${Number(data.rewards?.claimableRebateUsd ?? 0).toFixed(2)}
                </div>
                <div className="text-xs text-dim mb-3">
                  Claimable incentive: {Number(data.rewards?.claimableIncentiveHclaw ?? 0).toFixed(2)} HCLAW
                </div>
                <button onClick={handleClaim} disabled={claiming || !isConnected} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
                  {claiming ? "Claiming..." : "Claim Rewards"}
                </button>
                {claimStatus && <p className="text-xs mt-3 text-muted">{claimStatus}</p>}
              </div>

              <div className="card rounded-2xl p-5">
                <h2 className="text-sm font-semibold mb-3">Treasury + Agentic LP</h2>
                <div className="text-xs text-dim space-y-1">
                  <div>Total revenue: ${Number(data.treasury?.totals?.amountUsd ?? 0).toFixed(2)}</div>
                  <div>Buyback: ${Number(data.treasury?.totals?.buybackUsd ?? 0).toFixed(2)}</div>
                  <div>Incentives: ${Number(data.treasury?.totals?.incentiveUsd ?? 0).toFixed(2)}</div>
                  <div>Reserve: ${Number(data.treasury?.totals?.reserveUsd ?? 0).toFixed(2)}</div>
                </div>
                <div className="mt-3 p-3 rounded-xl bg-surface border border-card-border text-xs">
                  <div>Configured: {String(data.treasury?.agenticVault?.configured ?? false)}</div>
                  <div>Paused: {String(data.treasury?.agenticVault?.paused ?? false)}</div>
                  <div>Kill Switch: {String(data.treasury?.agenticVault?.killSwitch ?? false)}</div>
                  <div>Inventory Skew: {Number(data.treasury?.agenticVault?.inventorySkewBps ?? 0)} bps</div>
                  <div>Drawdown: {Number(data.treasury?.agenticVault?.drawdownBps ?? 0)} bps</div>
                  <div>PnL: {Number(data.treasury?.agenticVault?.cumulativeRealizedPnlUsd ?? 0).toFixed(4)}</div>
                </div>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card rounded-2xl p-4">
      <div className="text-[10px] text-dim uppercase tracking-wider mb-1">{label}</div>
      <div className="text-sm font-semibold mono-nums">{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-2.5 rounded-xl bg-surface border border-card-border">
      <div className="text-[10px] text-dim uppercase tracking-wider">{label}</div>
      <div className="text-xs font-medium mono-nums">{value}</div>
    </div>
  );
}
