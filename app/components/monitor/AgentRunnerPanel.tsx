"use client";

import { useState, useEffect, useCallback } from "react";
import type { Agent, AgentRunnerState } from "@/lib/types";

interface Props {
  agent: Agent;
}

export function AgentRunnerPanel({ agent }: Props) {
  const [state, setState] = useState<AgentRunnerState | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agent.id}/tick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status" }),
      });
      const data = await res.json();
      setState(data.state || null);
    } catch {
      // ignore
    }
  }, [agent.id]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleStart = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}/tick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", intervalMs: 60000 }),
      });
      const data = await res.json();
      setState(data.state || null);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await fetch(`/api/agents/${agent.id}/tick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      await fetchStatus();
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const handleTick = async () => {
    setLoading(true);
    try {
      await fetch(`/api/agents/${agent.id}/tick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "tick" }),
      });
      await fetchStatus();
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const isRunning = state?.isRunning ?? false;

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="font-bold text-sm uppercase tracking-wider">
            Agent Runner
          </h3>
          <span className="text-xs font-medium">{agent.name}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className={`w-2 h-2 rounded-full ${
              isRunning ? "bg-success pulse-live" : "bg-muted"
            }`}
          />
          <span className="text-xs text-muted">
            {isRunning ? "Running" : "Stopped"}
          </span>
        </div>
      </div>

      <div className="p-4 space-y-3">
        {/* Stats */}
        {state && (
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <span className="text-xs text-muted block">Ticks</span>
              <span className="font-bold">{state.tickCount}</span>
            </div>
            <div>
              <span className="text-xs text-muted block">Last Tick</span>
              <span className="font-mono text-xs">
                {state.lastTickAt
                  ? new Date(state.lastTickAt).toLocaleTimeString()
                  : "---"}
              </span>
            </div>
            <div>
              <span className="text-xs text-muted block">Next Tick</span>
              <span className="font-mono text-xs">
                {state.nextTickAt
                  ? new Date(state.nextTickAt).toLocaleTimeString()
                  : "---"}
              </span>
            </div>
          </div>
        )}

        {/* Errors */}
        {state && state.errors.length > 0 && (
          <div className="bg-danger/10 border border-danger/20 rounded-lg p-2">
            <span className="text-xs text-danger font-medium">
              Recent Errors ({state.errors.length})
            </span>
            <div className="mt-1 space-y-0.5">
              {state.errors.slice(-3).map((err, i) => (
                <div key={i} className="text-xs text-danger/80 truncate">
                  {new Date(err.timestamp).toLocaleTimeString()}: {err.message}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="flex gap-2">
          {isRunning ? (
            <button
              onClick={handleStop}
              disabled={loading}
              className="flex-1 bg-danger hover:bg-danger/80 text-white py-2 rounded-lg text-sm font-bold transition-all disabled:opacity-50"
            >
              {loading ? "..." : "Stop Runner"}
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={loading}
              className="flex-1 bg-success hover:bg-success/80 text-white py-2 rounded-lg text-sm font-bold transition-all disabled:opacity-50"
            >
              {loading ? "..." : "Start Runner"}
            </button>
          )}
          <button
            onClick={handleTick}
            disabled={loading}
            className="flex-1 bg-accent hover:bg-accent/80 text-white py-2 rounded-lg text-sm font-bold transition-all disabled:opacity-50"
          >
            {loading ? "..." : "Manual Tick"}
          </button>
        </div>
      </div>
    </div>
  );
}
