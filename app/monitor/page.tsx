"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { NetworkToggle } from "@/app/components/NetworkToggle";
import { PositionPanel } from "../components/monitor/PositionPanel";
import { OrderPanel } from "../components/monitor/OrderPanel";
import { PricePanel } from "../components/monitor/PricePanel";
import { BookPanel } from "../components/monitor/BookPanel";
import { BalancePanel } from "../components/monitor/BalancePanel";
import { QuickTrade } from "../components/monitor/QuickTrade";
import { AgentRunnerPanel } from "../components/monitor/AgentRunnerPanel";
import type { Agent } from "@/lib/types";
import type { Address } from "viem";

export default function MonitorPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/agents");
        const data = await res.json();
        const agentList = data.agents || [];
        setAgents(agentList);
        if (agentList.length > 0) {
          setSelectedAgent(agentList[0]);
        }
      } catch {
        // error
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0f0f23] flex items-center justify-center">
        <div className="animate-pulse text-muted">Loading monitoring room...</div>
      </div>
    );
  }

  const user = selectedAgent?.hlAddress as Address | undefined;

  return (
    <div className="min-h-screen bg-[#0f0f23]">
      {/* Header */}
      <header className="border-b border-card-border bg-card/50 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-[1600px] mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2">
              <span className="text-xl">🦞</span>
              <span className="font-bold gradient-text">Hyperclaw</span>
            </Link>
            <span className="text-muted">/</span>
            <span className="text-sm font-bold uppercase tracking-wider">
              Monitoring Room
            </span>
          </div>

          {/* Agent Selector */}
          <div className="flex items-center gap-3">
            <NetworkToggle />
            {agents.length > 0 && (
              <select
                value={selectedAgent?.id || ""}
                onChange={(e) => {
                  const agent = agents.find((a) => a.id === e.target.value);
                  setSelectedAgent(agent || null);
                }}
                className="bg-background border border-card-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.hlAddress?.slice(0, 6) ?? "no wallet"}...)
                  </option>
                ))}
              </select>
            )}
            <Link
              href="/"
              className="text-xs text-muted hover:text-white transition-colors"
            >
              Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-4 py-4">
        {!selectedAgent || !user ? (
          <div className="text-center py-20">
            <span className="text-4xl block mb-4">🤖</span>
            <h2 className="text-xl font-bold mb-2">No agents configured</h2>
            <p className="text-muted mb-4">
              Create an agent to start monitoring
            </p>
            <Link
              href="/agents/new"
              className="inline-block bg-accent hover:bg-accent/80 text-white px-6 py-3 rounded-lg font-medium transition-all"
            >
              Create Agent
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-4">
            {/* Left Column: Positions + Orders (main content) */}
            <div className="col-span-12 lg:col-span-8 space-y-4">
              {/* Balance bar */}
              <BalancePanel user={user} />

              {/* Positions */}
              <PositionPanel user={user} />

              {/* Orders */}
              <OrderPanel user={user} />

              {/* Agent Runner */}
              <AgentRunnerPanel agent={selectedAgent} />
            </div>

            {/* Right Column: Book + Prices + Quick Trade */}
            <div className="col-span-12 lg:col-span-4 space-y-4">
              {/* Quick Trade */}
              <QuickTrade />

              {/* Order Book */}
              <BookPanel
                defaultCoin={selectedAgent.markets[0] || "BTC"}
              />

              {/* Price Ticker */}
              <PricePanel coins={selectedAgent.markets} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
