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
const TEMP_NEARAI_AUTH_FALLBACK_MARKER = "Temporary LLM auth issue.";
const DEFAULT_OLLAMA_FALLBACK_MODEL = "glm-4.7-flash:latest";
const DEFAULT_OLLAMA_FALLBACK_TIMEOUT_MS = 45_000;

type OllamaFallbackConfig = {
  urls: string[];
  model: string;
  timeoutMs: number;
};

type IronClawConfig = {
  urls: string[];
  secret: string | null;
  ollamaFallback: OllamaFallbackConfig | null;
};

type OllamaGenerateResponse = {
  response?: string;
  error?: string;
};

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

function parseCsv(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getOllamaFallbackConfig(): OllamaFallbackConfig | null {
  const fallbackUrls = [
    ...parseCsv(process.env.IRONCLAW_OLLAMA_FALLBACK_URL),
    ...parseCsv(process.env.IRONCLAW_OLLAMA_FALLBACK_URLS),
  ]
    .map((value) => normalizeUrl(value))
    .filter((value, idx, arr): value is string => Boolean(value) && arr.indexOf(value) === idx);

  if (fallbackUrls.length === 0) return null;

  const model = process.env.IRONCLAW_OLLAMA_FALLBACK_MODEL?.trim() || DEFAULT_OLLAMA_FALLBACK_MODEL;
  const configuredTimeoutMs = Number.parseInt(
    process.env.IRONCLAW_OLLAMA_FALLBACK_TIMEOUT_MS || `${DEFAULT_OLLAMA_FALLBACK_TIMEOUT_MS}`,
    10
  );
  const timeoutMs = Number.isFinite(configuredTimeoutMs)
    ? Math.max(1000, configuredTimeoutMs)
    : DEFAULT_OLLAMA_FALLBACK_TIMEOUT_MS;

  return { urls: fallbackUrls, model, timeoutMs };
}

function getConfig(): IronClawConfig | null {
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
  return {
    urls,
    secret,
    ollamaFallback: getOllamaFallbackConfig(),
  };
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

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isNearAiFailureMessage(message: string | null | undefined): boolean {
  const text = message?.toLowerCase();
  if (!text) return false;
  if (text.includes(TEMP_NEARAI_AUTH_FALLBACK_MARKER.toLowerCase())) return true;
  if (text.includes("session renewal failed for provider nearai")) return true;
  if (text.includes("authentication failed for provider nearai")) return true;
  if (text.includes("session expired")) return true;
  return text.includes("nearai") && (text.includes("auth") || text.includes("session"));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function toOllamaGenerateUrl(url: string): string {
  const normalized = url.replace(/\/$/, "");
  if (normalized.endsWith("/api/generate")) return normalized;
  return `${normalized}/api/generate`;
}

async function tryOllamaFallback(
  req: IronClawWebhookRequest,
  config: IronClawConfig,
  nearAiFailureMessage: string
): Promise<IronClawWebhookResponse | null> {
  if (!config.ollamaFallback) return null;
  const prompt = req.content.trim();
  if (!prompt) return null;

  let lastFallbackError: string | null = null;
  for (const url of config.ollamaFallback.urls) {
    const generateUrl = toOllamaGenerateUrl(url);
    try {
      const response = await fetchWithTimeout(
        generateUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.ollamaFallback.model,
            prompt,
            stream: false,
          }),
        },
        config.ollamaFallback.timeoutMs
      );

      const raw = await response.text();
      const payload = parseJsonObject<OllamaGenerateResponse>(raw);
      const generated = normalizeText(payload?.response);

      if (!response.ok) {
        lastFallbackError =
          normalizeText(payload?.error) ??
          normalizeText(payload?.response) ??
          `Ollama fallback ${response.status}`;
        continue;
      }
      if (!generated) {
        lastFallbackError =
          normalizeText(payload?.error) ?? "Ollama fallback returned an empty response";
        continue;
      }

      return {
        message_id: `ollama-fallback-${Date.now()}`,
        status: "fallback_ollama",
        response: generated,
      };
    } catch (error) {
      lastFallbackError = error instanceof Error ? error.message : "Ollama fallback request failed";
    }
  }

  if (lastFallbackError) {
    console.warn(
      `[ironclaw] Ollama fallback unavailable after NearAI failure: ${lastFallbackError}. Root cause: ${nearAiFailureMessage}`
    );
  }
  return null;
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
  let nearAiFailureMessage: string | null = null;
  for (const url of config.urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      const data = parseJsonObject<IronClawWebhookResponse>(raw);
      const responseText = normalizeText(data?.response);

      if (!res.ok) {
        lastError = responseText ?? `IronClaw webhook ${res.status}`;
        if (isNearAiFailureMessage(lastError)) {
          nearAiFailureMessage = lastError;
        }
        continue;
      }
      if (!data || typeof data.message_id !== "string" || typeof data.status !== "string") {
        lastError = "Invalid IronClaw webhook response";
        continue;
      }
      if (isNearAiFailureMessage(responseText)) {
        nearAiFailureMessage = responseText;
        continue;
      }
      return data;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "fetch failed";
      if (isNearAiFailureMessage(lastError)) {
        nearAiFailureMessage = lastError;
      }
    }
  }

  if (nearAiFailureMessage) {
    const fallback = await tryOllamaFallback(req, config, nearAiFailureMessage);
    if (fallback) return fallback;
  }

  throw new Error(nearAiFailureMessage ?? lastError ?? "IronClaw request failed");
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
