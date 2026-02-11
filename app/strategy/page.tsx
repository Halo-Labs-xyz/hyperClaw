"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { HyperclawLogo } from "@/app/components/HyperclawLogo";
import { HyperclawIcon } from "@/app/components/HyperclawIcon";
import { NetworkToggle } from "@/app/components/NetworkToggle";
import { TestnetToggle } from "../components/strategy/TestnetToggle";
import { StrategyBuilder } from "../components/strategy/StrategyBuilder";
import { BacktestResults } from "../components/strategy/BacktestResults";
import type { StrategyConfig, TradeLog } from "@/lib/types";

export default function StrategyPage() {
  const { user } = usePrivy();
  const [isTestnet, setIsTestnet] = useState(true);
  const [running, setRunning] = useState(false);
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [startTime, setStartTime] = useState<number>(0);
  const [endTime, setEndTime] = useState<number | undefined>();
  const [ticksCompleted, setTicksCompleted] = useState(0);
  const [totalTicks, setTotalTicks] = useState(0);

  const ownerWalletAddress = useMemo(() => {
    const linked = (user?.linkedAccounts ?? []) as Array<{
      type?: string;
      chainType?: string;
      walletClientType?: string;
      address?: string;
    }>;

    const embeddedWallet = linked.find(
      (account) =>
        account.type === "wallet" &&
        account.chainType === "ethereum" &&
        account.walletClientType === "privy" &&
        typeof account.address === "string"
    );

    const firstEthereumWallet = linked.find(
      (account) =>
        account.type === "wallet" &&
        account.chainType === "ethereum" &&
        typeof account.address === "string"
    );

    return embeddedWallet?.address ?? firstEthereumWallet?.address;
  }, [user?.linkedAccounts]);

  const runStrategyTest = async (config: StrategyConfig) => {
    setRunning(true);
    setTrades([]);
    setStartTime(Date.now());
    setEndTime(undefined);
    setTicksCompleted(0);

    // Determine number of ticks to run (min 3, max 10 for testing)
    const numTicks = Math.min(10, Math.max(3, Math.floor(60000 / config.tickIntervalMs) * 5));
    setTotalTicks(numTicks);

    try {
      // First, create a temporary test agent
      const createRes = await fetch("/api/agents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(user?.id ? { "x-owner-privy-id": user.id } : {}),
          ...(ownerWalletAddress ? { "x-owner-wallet-address": ownerWalletAddress } : {}),
        },
        body: JSON.stringify({
          name: `[Test] ${config.name}`,
          description: `Strategy test: ${config.riskLevel}, ${config.maxLeverage}x max leverage, ${config.markets.join("/")}`,
          markets: config.markets,
          maxLeverage: config.maxLeverage,
          riskLevel: config.riskLevel,
          stopLossPercent: config.stopLossPercent,
          ownerPrivyId: user?.id || undefined,
          ownerWalletAddress: ownerWalletAddress || undefined,
        }),
      });

      const { agent } = await createRes.json();
      if (!agent) throw new Error("Failed to create test agent");

      // Run ticks sequentially
      for (let i = 0; i < numTicks; i++) {
        try {
          const tickRes = await fetch(`/api/agents/${agent.id}/tick`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "tick" }),
          });

          const tickData = await tickRes.json();
          if (tickData.tradeLog) {
            setTrades((prev) => [...prev, tickData.tradeLog]);
          }
        } catch (tickError) {
          console.error(`Tick ${i + 1} failed:`, tickError);
        }

        setTicksCompleted(i + 1);

        // Small delay between ticks to avoid rate limiting
        if (i < numTicks - 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    } catch (error) {
      console.error("Strategy test failed:", error);
    } finally {
      setEndTime(Date.now());
      setRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0f0f23]">
      {/* Header */}
      <header className="border-b border-card-border bg-card/50 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center">
                <HyperclawIcon className="text-accent" size={18} />
              </div>
              <HyperclawLogo className="font-bold" />
            </Link>
            <span className="text-muted">/</span>
            <span className="text-sm font-bold uppercase tracking-wider">
              Strategy Testing
            </span>
          </div>

          <div className="flex items-center gap-3">
            <NetworkToggle />
            <TestnetToggle isTestnet={isTestnet} onChange={setIsTestnet} />
            <Link
              href="/monitor"
              className="text-xs text-muted hover:text-white transition-colors"
            >
              Monitor
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Intro */}
        <div className="text-center py-4">
          <h2 className="text-2xl font-bold mb-2 gradient-title">Strategy Tester</h2>
          <p className="text-muted text-sm max-w-lg mx-auto">
            Configure trading parameters, run simulated AI ticks against live
            market data, and review the decisions your agent would make.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Strategy Builder */}
          <StrategyBuilder onSubmit={runStrategyTest} loading={running} />

          {/* Progress / Status */}
          <div className="space-y-4">
            {running && (
              <div className="bg-card border border-card-border rounded-xl p-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-sm">Running Test</h3>
                  <span className="text-xs text-accent-light font-mono">
                    Tick {ticksCompleted}/{totalTicks}
                  </span>
                </div>
                <div className="w-full bg-background rounded-full h-2">
                  <div
                    className="bg-gradient-to-r from-accent to-cyan-400 h-2 rounded-full transition-all duration-500"
                    style={{
                      width: `${totalTicks > 0 ? (ticksCompleted / totalTicks) * 100 : 0}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-muted mt-2">
                  AI is analyzing market data and generating trade decisions...
                </p>
              </div>
            )}

            {!running && trades.length === 0 && (
              <div className="bg-card border border-card-border rounded-xl p-12 text-center">
                <span className="text-3xl block mb-3">🧪</span>
                <h4 className="font-semibold mb-1">Ready to test</h4>
                <p className="text-sm text-muted">
                  Configure your strategy and click &quot;Run Strategy Test&quot;
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Results */}
        {trades.length > 0 && (
          <BacktestResults
            trades={trades}
            startTime={startTime}
            endTime={endTime}
          />
        )}
      </main>
    </div>
  );
}
