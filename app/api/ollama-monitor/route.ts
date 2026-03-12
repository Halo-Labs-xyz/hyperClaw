import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DEFAULT_LOCAL_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 8000;
const CLOUDFLARED_METRICS_URL = "http://127.0.0.1:20242/metrics";

type OllamaTagsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
  error?: string;
};

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

function normalizeUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function toTagsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  if (normalized.endsWith("/api/tags")) return normalized;
  if (normalized.endsWith("/api/generate")) {
    return normalized.replace(/\/api\/generate$/, "/api/tags");
  }
  return `${normalized}/api/tags`;
}

function parseJsonObject<T>(raw: string): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as T;
  } catch {
    return null;
  }
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function probeOllama(baseUrl: string, timeoutMs: number): Promise<EndpointSnapshot> {
  const tagsUrl = toTagsUrl(baseUrl);
  const start = Date.now();

  try {
    const res = await fetchWithTimeout(tagsUrl, timeoutMs);
    const latencyMs = Date.now() - start;
    const raw = await res.text();
    const payload = parseJsonObject<OllamaTagsResponse>(raw);

    if (!res.ok) {
      return {
        target: tagsUrl,
        ok: false,
        status: res.status,
        latencyMs,
        models: [],
        error: payload?.error ?? `HTTP ${res.status}`,
      };
    }

    const models = uniqueSorted(
      (payload?.models ?? []).map((entry) => (entry.name ?? entry.model ?? "").trim())
    );
    return {
      target: tagsUrl,
      ok: true,
      status: res.status,
      latencyMs,
      models,
      error: null,
    };
  } catch (error) {
    return {
      target: tagsUrl,
      ok: false,
      status: null,
      latencyMs: null,
      models: [],
      error: error instanceof Error ? error.message : "request failed",
    };
  }
}

async function probeCloudflaredMetrics(timeoutMs: number): Promise<MetricsSnapshot> {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(CLOUDFLARED_METRICS_URL, timeoutMs);
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        error: `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      status: res.status,
      latencyMs,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: null,
      error: error instanceof Error ? error.message : "request failed",
    };
  }
}

export async function GET() {
  const timeoutMs = Math.max(
    1000,
    Number.parseInt(process.env.OLLAMA_MONITOR_TIMEOUT_MS || `${DEFAULT_TIMEOUT_MS}`, 10) ||
      DEFAULT_TIMEOUT_MS
  );
  const localBaseUrl =
    normalizeUrl(process.env.OLLAMA_LOCAL_BASE_URL) ??
    normalizeUrl(process.env.OLLAMA_BASE_URL) ??
    DEFAULT_LOCAL_OLLAMA_BASE_URL;
  const tunnelBaseUrl =
    normalizeUrl(process.env.IRONCLAW_OLLAMA_FALLBACK_URL) ??
    normalizeUrl(process.env.OLLAMA_TUNNEL_URL);

  const local = await probeOllama(localBaseUrl, timeoutMs);
  const tunnel = tunnelBaseUrl ? await probeOllama(tunnelBaseUrl, timeoutMs) : null;
  const cloudflaredMetrics = await probeCloudflaredMetrics(3000);

  const missingInTunnel = tunnel
    ? local.models.filter((name) => !tunnel.models.includes(name))
    : [];
  const missingInLocal = tunnel
    ? tunnel.models.filter((name) => !local.models.includes(name))
    : [];
  const modelsMatch = tunnel ? missingInTunnel.length === 0 && missingInLocal.length === 0 : null;

  const overallOk = local.ok && (!!tunnel ? tunnel.ok : false);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    overallOk,
    local,
    tunnel,
    tunnelConfigured: Boolean(tunnelBaseUrl),
    cloudflaredMetrics,
    modelParity: {
      modelsMatch,
      missingInTunnel,
      missingInLocal,
    },
  });
}
