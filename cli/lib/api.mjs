/**
 * API client for HyperClaw Railway dapp and IronClaw.
 */

import { getConfig } from "./config.mjs";

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

function headers() {
  const { apiKey } = getConfig();
  const h = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (apiKey) {
    h["x-api-key"] = apiKey;
    h["Authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

function ownerHeaders() {
  const cfg = getConfig();
  const h = headers();
  if (cfg.privyId) h["x-owner-privy-id"] = cfg.privyId;
  if (cfg.walletAddress) h["x-owner-wallet-address"] = cfg.walletAddress;
  return h;
}

export async function apiGet(path, opts = {}) {
  const { baseUrl } = getConfig();
  if (!baseUrl) throw new ApiError("Base URL not configured. Run: hc config --base-url <URL>", 0, null);
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: opts.headers || headers(),
    signal: AbortSignal.timeout(opts.timeout ?? 30000),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new ApiError(data?.error ?? data?.detail ?? `HTTP ${res.status}`, res.status, data);
  }
  return data;
}

export async function apiPost(path, body, opts = {}) {
  const { baseUrl } = getConfig();
  if (!baseUrl) throw new ApiError("Base URL not configured. Run: hc config --base-url <URL>", 0, null);
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: opts.headers || headers(),
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(opts.timeout ?? 60000),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new ApiError(data?.error ?? data?.detail ?? `HTTP ${res.status}`, res.status, data);
  }
  return data;
}

// Agent creation uses owner headers
export const apiPostAgents = (body) =>
  apiPost("/api/agents", body, { headers: ownerHeaders() });

export const apiGetAgents = (params = "") =>
  apiGet(`/api/agents${params ? `?${params}` : ""}`);

export const apiGetAgent = (id) =>
  apiGet(`/api/agents/${id}`);

export const apiAgentTick = (id, body) =>
  apiPost(`/api/agents/${id}/tick`, body ?? {});

export const apiAgentApprove = (id, body) =>
  apiPost(`/api/agents/${id}/approve`, body ?? {});

export const apiAgentChatGet = (id, params = "") =>
  apiGet(`/api/agents/${id}/chat${params ? `?${params}` : ""}`);

export const apiAgentChatPost = (id, body) =>
  apiPost(`/api/agents/${id}/chat`, body ?? {});

export const apiOrchestratorAgents = () => {
  const key = process.env.HC_ORCHESTRATOR_KEY || process.env.ORCHESTRATOR_SECRET;
  const h = key ? { ...headers(), "x-orchestrator-key": key } : headers();
  return apiGet("/api/agents/orchestrator", { headers: h });
};

export const apiGetMarkets = () =>
  apiGet("/api/market?action=all-markets");

export const apiFund = (body) =>
  apiPost("/api/fund", body);

export const apiGetDeposit = (agentId) =>
  apiGet(`/api/deposit?agentId=${encodeURIComponent(agentId)}`);

export const apiConfirmDeposit = (txHash, network) =>
  apiPost("/api/deposit", { txHash, network });

export const apiIronclaw = (body) =>
  apiPost("/api/ironclaw", body);

export const apiIronclawHealth = () =>
  apiGet("/api/ironclaw");
