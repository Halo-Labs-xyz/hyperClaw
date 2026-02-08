/**
 * Phala CVM (Confidential Virtual Machine) client.
 * Connects to Phala Cloud API using PHALA_API_KEY to manage and query CVMs.
 *
 * @see https://cloud-api.phala.network/docs
 * @see https://docs.phala.network/phala-cloud/cvm/overview
 */

const PHALA_API_BASE = "https://cloud-api.phala.network";

export interface PhalaCvmDetails {
  id: string;
  name?: string;
  state?: string;
  [key: string]: unknown;
}

export interface PhalaCvmNetwork {
  /** Public HTTP URL to reach the CVM app (if exposed) */
  http_url?: string;
  /** WebSocket URL if applicable */
  ws_url?: string;
  [key: string]: unknown;
}

/**
 * Get headers for Phala Cloud API requests.
 * Uses PHALA_API_KEY as Bearer token (standard for Phala Cloud).
 */
function getPhalaHeaders(): HeadersInit {
  const apiKey = process.env.PHALA_API_KEY;
  if (!apiKey) {
    throw new Error("PHALA_API_KEY is not set");
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Fetch from Phala Cloud API with auth.
 */
async function phalaFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${PHALA_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...getPhalaHeaders(),
      ...options.headers,
    },
  });
  return res;
}

/**
 * Get the configured CVM ID from env.
 */
export function getPhalaCvmId(): string | null {
  return process.env.PHALA_CVM_ID ?? null;
}

/**
 * Get the configured App ID from env.
 */
export function getPhalaAppId(): string | null {
  return process.env.PHALA_APP_ID ?? null;
}

/**
 * Check if Phala CVM is configured and reachable.
 */
export async function checkPhalaConnection(): Promise<{
  ok: boolean;
  error?: string;
  user?: string;
}> {
  try {
    const res = await phalaFetch("/api/v1/auth/me");
    if (!res.ok) {
      const text = await res.text();
      return {
        ok: false,
        error: `Auth failed (${res.status}): ${text || res.statusText}`,
      };
    }
    const data = (await res.json()) as { username?: string };
    return { ok: true, user: data.username };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Get CVM details by ID.
 */
export async function getCvmDetails(
  cvmId: string
): Promise<PhalaCvmDetails | null> {
  const res = await phalaFetch(`/api/v1/cvms/${encodeURIComponent(cvmId)}`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(
      `Phala API error (${res.status}): ${await res.text() || res.statusText}`
    );
  }
  return (await res.json()) as PhalaCvmDetails;
}

/**
 * Get CVM network info (URLs, ports, etc.).
 */
export async function getCvmNetwork(
  cvmId: string
): Promise<PhalaCvmNetwork | null> {
  const res = await phalaFetch(
    `/api/v1/cvms/${encodeURIComponent(cvmId)}/network`
  );
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(
      `Phala API error (${res.status}): ${await res.text() || res.statusText}`
    );
  }
  return (await res.json()) as PhalaCvmNetwork;
}

/**
 * Get CVM state (running, stopped, etc.).
 */
export async function getCvmState(cvmId: string): Promise<{ state?: string }> {
  const res = await phalaFetch(
    `/api/v1/cvms/${encodeURIComponent(cvmId)}/state`
  );
  if (!res.ok) {
    throw new Error(
      `Phala API error (${res.status}): ${await res.text() || res.statusText}`
    );
  }
  return (await res.json()) as { state?: string };
}

/**
 * Get the configured CVM's HTTP URL if available.
 * Use this to connect to your app running inside the CVM.
 */
export async function getConfiguredCvmUrl(): Promise<string | null> {
  const cvmId = getPhalaCvmId();
  if (!cvmId) return null;
  const network = await getCvmNetwork(cvmId);
  const url = network?.http_url;
  return typeof url === "string" ? url : null;
}
