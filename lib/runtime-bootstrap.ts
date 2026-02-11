import { initializeAgentLifecycle } from "./agent-lifecycle";

const TELEGRAM_API = "https://api.telegram.org/bot";
const BOOTSTRAP_COOLDOWN_MS = 5 * 60 * 1000;
const TELEGRAM_SYNC_COOLDOWN_MS = 10 * 60 * 1000;

type BootstrapTrigger = "startup" | "healthcheck" | "telegram-webhook" | "manual" | "unknown";

type TelegramWebhookState = {
  enabled: boolean;
  targetUrl: string | null;
  status:
    | "disabled"
    | "configured"
    | "already-configured"
    | "skipped-no-token"
    | "skipped-no-url"
    | "error";
  checkedAt: number;
  error: string | null;
};

export type RuntimeBootstrapState = {
  trigger: BootstrapTrigger;
  bootstrappedAt: number;
  lifecycleInitialized: boolean;
  telegramWebhook: TelegramWebhookState;
};

type RuntimeBootstrapGlobals = {
  inFlight: Promise<RuntimeBootstrapState> | null;
  lastBootstrapAt: number;
  lastState: RuntimeBootstrapState | null;
  lastTelegramSyncAt: number;
  lastTelegramState: TelegramWebhookState | null;
};

const globals = (globalThis as typeof globalThis & {
  __hyperclawRuntimeBootstrap?: RuntimeBootstrapGlobals;
}).__hyperclawRuntimeBootstrap ??= {
  inFlight: null,
  lastBootstrapAt: 0,
  lastState: null,
  lastTelegramSyncAt: 0,
  lastTelegramState: null,
};

export async function ensureRuntimeBootstrap(
  trigger: BootstrapTrigger = "unknown"
): Promise<RuntimeBootstrapState> {
  const now = Date.now();

  if (globals.inFlight) {
    return globals.inFlight;
  }

  if (globals.lastState && now - globals.lastBootstrapAt < BOOTSTRAP_COOLDOWN_MS) {
    return globals.lastState;
  }

  globals.inFlight = (async () => {
    await initializeAgentLifecycle();

    let telegramWebhook = globals.lastTelegramState ?? {
      enabled: false,
      targetUrl: null,
      status: "disabled" as const,
      checkedAt: now,
      error: null,
    };

    if (now - globals.lastTelegramSyncAt >= TELEGRAM_SYNC_COOLDOWN_MS || !globals.lastTelegramState) {
      telegramWebhook = await ensureTelegramWebhookConfigured();
      globals.lastTelegramSyncAt = Date.now();
      globals.lastTelegramState = telegramWebhook;
    }

    const state: RuntimeBootstrapState = {
      trigger,
      bootstrappedAt: Date.now(),
      lifecycleInitialized: true,
      telegramWebhook,
    };

    globals.lastBootstrapAt = Date.now();
    globals.lastState = state;
    return state;
  })()
    .catch((error) => {
      globals.inFlight = null;
      throw error;
    })
    .finally(() => {
      globals.inFlight = null;
    });

  return globals.inFlight;
}

async function ensureTelegramWebhookConfigured(): Promise<TelegramWebhookState> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
  const targetUrl = resolveTelegramWebhookUrl();
  const checkedAt = Date.now();

  if (!token) {
    return {
      enabled: false,
      targetUrl,
      status: "skipped-no-token",
      checkedAt,
      error: null,
    };
  }

  if (!targetUrl) {
    return {
      enabled: true,
      targetUrl: null,
      status: "skipped-no-url",
      checkedAt,
      error: "No public app URL found for Telegram webhook auto-sync",
    };
  }

  try {
    const infoPayload = await telegramApiRequest(token, "getWebhookInfo", {});
    const infoResult = asRecord(infoPayload.result);
    const currentUrl = typeof infoResult.url === "string" ? infoResult.url : "";

    if (currentUrl === targetUrl) {
      return {
        enabled: true,
        targetUrl,
        status: "already-configured",
        checkedAt,
        error: null,
      };
    }

    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    const setWebhookPayload = await telegramApiRequest(token, "setWebhook", {
      url: targetUrl,
      allowed_updates: ["message", "callback_query"],
      ...(secretToken ? { secret_token: secretToken } : {}),
    });

    if (setWebhookPayload.ok !== true) {
      const description =
        typeof setWebhookPayload.description === "string"
          ? setWebhookPayload.description
          : "setWebhook returned ok=false";
      throw new Error(description);
    }

    console.log(`[Runtime] Telegram webhook synced: ${targetUrl}`);

    return {
      enabled: true,
      targetUrl,
      status: "configured",
      checkedAt,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Runtime] Telegram webhook sync failed:", message);
    return {
      enabled: true,
      targetUrl,
      status: "error",
      checkedAt,
      error: message,
    };
  }
}

async function telegramApiRequest(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${TELEGRAM_API}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const payload = parseJsonObject(text);
  const ok = payload.ok === true;

  if (!response.ok || !ok) {
    const description =
      typeof payload.description === "string"
        ? payload.description
        : `Telegram ${method} failed with status ${response.status}`;
    throw new Error(description);
  }

  return payload;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function resolveTelegramWebhookUrl(): string | null {
  const explicitUrl = normalizeAbsoluteUrl(process.env.TELEGRAM_WEBHOOK_URL);
  if (explicitUrl) return explicitUrl;

  const originCandidates = [
    process.env.TELEGRAM_WEBHOOK_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.APP_BASE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.RAILWAY_STATIC_URL,
    process.env.RAILWAY_PUBLIC_DOMAIN,
    process.env.VERCEL_URL,
    process.env.AGENT_PUBLIC_URL,
  ];

  for (const candidate of originCandidates) {
    const origin = normalizeOrigin(candidate);
    if (origin) {
      return `${origin}/api/telegram/webhook`;
    }
  }

  return null;
}

function normalizeAbsoluteUrl(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}
