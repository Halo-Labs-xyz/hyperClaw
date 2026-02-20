import {
  getLiquidClawFrontdoorGatewayBaseUrl,
  getLiquidClawFrontdoorRedirectAllowlist,
} from "@/lib/env";

const DEFAULT_ALLOWED_REDIRECT_HOSTS = [
  "verify-sepolia.eigencloud.xyz",
  "localhost",
  "127.0.0.1",
];

type JsonRecord = Record<string, unknown>;

function asJsonRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonRecord;
}

function resolveGatewayBaseUrl(): string {
  const baseUrl = getLiquidClawFrontdoorGatewayBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "LIQUIDCLAW_FRONTDOOR_GATEWAY_BASE_URL must be set to proxy frontdoor requests"
    );
  }
  return baseUrl;
}

function normalizeAllowedHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[a-z0-9.*:-]+$/.test(trimmed)) return null;
  return trimmed;
}

function buildAllowedRedirectHosts(baseUrl: string): string[] {
  const configured = getLiquidClawFrontdoorRedirectAllowlist()
    .map((value) => normalizeAllowedHost(value))
    .filter((value): value is string => Boolean(value));
  let gatewayHost: string | null = null;
  try {
    gatewayHost = new URL(baseUrl).host.toLowerCase();
  } catch {
    gatewayHost = null;
  }
  return Array.from(new Set([...configured, ...DEFAULT_ALLOWED_REDIRECT_HOSTS, gatewayHost ?? ""]))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function matchesAllowedHost(hostname: string, hostWithPort: string, allowlist: string[]): boolean {
  const normalizedHostname = hostname.toLowerCase();
  const normalizedHostWithPort = hostWithPort.toLowerCase();
  for (const allow of allowlist) {
    if (allow.includes(":")) {
      if (normalizedHostWithPort === allow) return true;
      continue;
    }
    if (allow.startsWith("*.")) {
      const suffix = allow.slice(1);
      if (normalizedHostname.endsWith(suffix)) return true;
      continue;
    }
    if (allow.startsWith(".")) {
      if (normalizedHostname.endsWith(allow)) return true;
      continue;
    }
    if (normalizedHostname === allow) return true;
  }
  return false;
}

export function sanitizeFrontdoorLaunchUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const allowlist = buildAllowedRedirectHosts(resolveGatewayBaseUrl());
  if (!matchesAllowedHost(parsed.hostname, parsed.host, allowlist)) return null;
  return parsed.toString();
}

export async function frontdoorGatewayFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = resolveGatewayBaseUrl();
  const requestUrl = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(requestUrl, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const body = asJsonRecord(payload);
      const detail =
        (typeof body.error === "string" && body.error) ||
        (typeof body.message === "string" && body.message) ||
        (typeof body.detail === "string" && body.detail) ||
        text ||
        `${response.status} ${response.statusText}`;
      throw new Error(detail);
    }

    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}
