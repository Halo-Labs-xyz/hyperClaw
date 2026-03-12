"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { HyperclawIcon } from "@/app/components/HyperclawIcon";
import { HyperclawLogo } from "@/app/components/HyperclawLogo";

type EndpointSnapshot = {
  target: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  models: string[];
  error: string | null;
};

type MetricsSnapshot = {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
};

type MonitorPayload = {
  timestamp: string;
  overallOk: boolean;
  local: EndpointSnapshot;
  tunnel: EndpointSnapshot | null;
  tunnelConfigured: boolean;
  cloudflaredMetrics: MetricsSnapshot;
  modelParity: {
    modelsMatch: boolean | null;
    missingInTunnel: string[];
    missingInLocal: string[];
  };
};

const POLL_INTERVAL_MS = 8000;

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
        ok
          ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
          : "border-rose-400/40 bg-rose-400/10 text-rose-300"
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-300" : "bg-rose-300"}`} />
      {label}
    </span>
  );
}

function EndpointCard({
  title,
  snapshot,
}: {
  title: string;
  snapshot: EndpointSnapshot | null;
}) {
  if (!snapshot) {
    return (
      <section className="glass-card p-5">
        <div className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">{title}</div>
        <p className="text-sm text-muted">Not configured.</p>
      </section>
    );
  }

  return (
    <section className="glass-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-sm font-semibold uppercase tracking-wider text-muted">{title}</div>
        <StatusBadge ok={snapshot.ok} label={snapshot.ok ? "online" : "offline"} />
      </div>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-muted">Target</dt>
          <dd className="mt-1 break-all font-mono text-xs text-foreground">{snapshot.target}</dd>
        </div>
        <div className="flex gap-5">
          <div>
            <dt className="text-muted">HTTP</dt>
            <dd className="mt-1 font-mono">{snapshot.status ?? "-"}</dd>
          </div>
          <div>
            <dt className="text-muted">Latency</dt>
            <dd className="mt-1 font-mono">
              {snapshot.latencyMs !== null ? `${snapshot.latencyMs}ms` : "-"}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Models</dt>
            <dd className="mt-1 font-mono">{snapshot.models.length}</dd>
          </div>
        </div>
      </dl>
      {snapshot.error ? <p className="mt-4 text-xs text-rose-300">{snapshot.error}</p> : null}
      {snapshot.models.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {snapshot.models.slice(0, 8).map((model) => (
            <span
              key={`${title}-${model}`}
              className="rounded-md border border-card-border bg-black/30 px-2 py-1 font-mono text-xs"
            >
              {model}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default function OllamaMonitorPage() {
  const [data, setData] = useState<MonitorPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const res = await fetch("/api/ollama-monitor", { cache: "no-store" });
      if (!res.ok) throw new Error(`Monitor API ${res.status}`);
      const payload = (await res.json()) as MonitorPayload;
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load monitor");
    } finally {
      setLoading(false);
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const stamp = useMemo(() => {
    if (!data?.timestamp) return "-";
    const dt = new Date(data.timestamp);
    return Number.isNaN(dt.getTime()) ? data.timestamp : dt.toLocaleString();
  }, [data?.timestamp]);

  return (
    <div className="min-h-screen page-bg grid-bg">
      <header className="border-b border-card-border bg-card/60 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/25 bg-white/10">
              <HyperclawIcon className="text-accent" size={28} />
            </div>
            <div>
              <HyperclawLogo className="font-bold" />
              <div className="text-xs uppercase tracking-wider text-muted">Ollama Tunnel Monitor</div>
            </div>
          </Link>
          <div className="flex items-center gap-3">
            <StatusBadge ok={Boolean(data?.overallOk)} label={data?.overallOk ? "healthy" : "degraded"} />
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing}
              className="rounded-lg border border-card-border bg-black/30 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-foreground transition hover:border-accent/50 disabled:opacity-60"
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        {loading ? (
          <section className="glass-card p-8 text-center text-muted">Loading monitor telemetry...</section>
        ) : null}

        {error ? (
          <section className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">
            {error}
          </section>
        ) : null}

        {data ? (
          <>
            <section className="mb-4 glass-card p-5">
              <div className="grid gap-4 md:grid-cols-4">
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted">Last update</div>
                  <div className="mt-1 font-mono text-sm">{stamp}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted">Tunnel configured</div>
                  <div className="mt-1 font-mono text-sm">{data.tunnelConfigured ? "yes" : "no"}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted">Model parity</div>
                  <div className="mt-1 font-mono text-sm">
                    {data.modelParity.modelsMatch === null
                      ? "n/a"
                      : data.modelParity.modelsMatch
                        ? "match"
                        : "drift"}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted">Cloudflared metrics</div>
                  <div className="mt-1 font-mono text-sm">
                    {data.cloudflaredMetrics.ok
                      ? `${data.cloudflaredMetrics.latencyMs ?? "-"}ms`
                      : data.cloudflaredMetrics.error ?? "offline"}
                  </div>
                </div>
              </div>
            </section>

            <div className="grid gap-4 md:grid-cols-2">
              <EndpointCard title="Local Ollama" snapshot={data.local} />
              <EndpointCard title="Cloudflare Tunnel" snapshot={data.tunnel} />
            </div>

            <section className="mt-4 glass-card p-5">
              <div className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">Model drift</div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <div className="mb-2 text-xs uppercase tracking-wider text-muted">Missing in tunnel</div>
                  {data.modelParity.missingInTunnel.length === 0 ? (
                    <p className="text-sm text-emerald-300">None</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {data.modelParity.missingInTunnel.map((model) => (
                        <span
                          key={`missing-tunnel-${model}`}
                          className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 font-mono text-xs text-rose-200"
                        >
                          {model}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <div className="mb-2 text-xs uppercase tracking-wider text-muted">Missing in local</div>
                  {data.modelParity.missingInLocal.length === 0 ? (
                    <p className="text-sm text-emerald-300">None</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {data.modelParity.missingInLocal.map((model) => (
                        <span
                          key={`missing-local-${model}`}
                          className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 font-mono text-xs text-rose-200"
                        >
                          {model}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
