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

function getConfig(): { url: string; secret: string | null } | null {
  const url = process.env.IRONCLAW_WEBHOOK_URL;
  if (!url?.trim()) return null;
  const secret = process.env.IRONCLAW_WEBHOOK_SECRET?.trim() ?? null;
  return { url: url.replace(/\/$/, ""), secret };
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

  const res = await fetch(config.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as IronClawWebhookResponse;
  if (!res.ok) {
    throw new Error(data?.response ?? `IronClaw webhook ${res.status}`);
  }
  return data;
}

/**
 * Health check for the IronClaw HTTP channel.
 */
export async function ironClawHealth(): Promise<{ ok: boolean; status?: string }> {
  const config = getConfig();
  if (!config) return { ok: false };

  const base = config.url.replace(/\/webhook\/?$/, "");
  const healthUrl = `${base}/health`;
  try {
    const res = await fetch(healthUrl);
    const data = (await res.json()) as { status?: string; channel?: string };
    return { ok: res.ok, status: data?.status };
  } catch {
    return { ok: false };
  }
}
