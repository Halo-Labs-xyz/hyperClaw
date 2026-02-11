/**
 * IronClaw HTTP webhook client.
 *
 * Call the IronClaw assistant (running as a sidecar) from hyperClaw.
 * Set IRONCLAW_WEBHOOK_URL (and optionally IRONCLAW_WEBHOOK_SECRET) to enable.
 */

export type IronClawWebhookRequest = {
  content: string;
  thread_id?: string;
  wait_for_response?: boolean;
};

export type IronClawWebhookResponse = {
  message_id: string;
  status: string;
  response?: string;
};

const STATIC_IRONCLAW_WEBHOOK_FALLBACK = "https://52-90-200-172.sslip.io/webhook";

function normalizeUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const isLocalHost = host === "localhost" || host === "127.0.0.1";
    // On production runtimes, reject localhost URLs and rely on fallback candidates.
    if (process.env.NODE_ENV === "production" && isLocalHost) return null;
  } catch {
    return null;
  }
  return trimmed.replace(/\/$/, "");
}

function getConfig(): { urls: string[]; secret: string | null } | null {
  const primary = normalizeUrl(process.env.IRONCLAW_WEBHOOK_URL);
  const envFallback = normalizeUrl(process.env.IRONCLAW_WEBHOOK_FALLBACK_URL);
  const staticFallback = normalizeUrl(STATIC_IRONCLAW_WEBHOOK_FALLBACK);

  const urls = [primary, envFallback, staticFallback].filter(
    (value, idx, arr): value is string => Boolean(value) && arr.indexOf(value) === idx
  );
  if (urls.length === 0) return null;

  const secret =
    process.env.IRONCLAW_WEBHOOK_SECRET?.trim() ??
    process.env.HTTP_WEBHOOK_SECRET?.trim() ??
    null;
  return { urls, secret };
}

/**
 * Returns true if IronClaw webhook is configured.
 */
export function isIronClawConfigured(): boolean {
  return getConfig() !== null;
}

/**
 * Send a message to IronClaw and optionally wait for the assistant response.
 */
export async function sendToIronClaw(
  req: IronClawWebhookRequest
): Promise<IronClawWebhookResponse | null> {
  const config = getConfig();
  if (!config) return null;

  const body: Record<string, unknown> = {
    content: req.content,
    wait_for_response: req.wait_for_response ?? true,
  };
  if (req.thread_id) body.thread_id = req.thread_id;
  if (config.secret) body.secret = config.secret;

  let lastError: string | null = null;
  for (const url of config.urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as IronClawWebhookResponse;
      if (!res.ok) {
        lastError = data?.response ?? `IronClaw webhook ${res.status}`;
        continue;
      }
      return data;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "fetch failed";
    }
  }

  throw new Error(lastError ?? "IronClaw request failed");
}

/**
 * Health check for the IronClaw HTTP channel.
 */
export async function ironClawHealth(): Promise<{ ok: boolean; status?: string }> {
  const config = getConfig();
  if (!config) return { ok: false };

  for (const webhookUrl of config.urls) {
    const base = webhookUrl.replace(/\/webhook\/?$/, "");
    const healthUrl = `${base}/health`;
    try {
      const res = await fetch(healthUrl);
      const data = (await res.json()) as { status?: string; channel?: string };
      if (res.ok) {
        return { ok: true, status: data?.status };
      }
    } catch {
      // Try next candidate URL.
    }
  }
  return { ok: false };
}
