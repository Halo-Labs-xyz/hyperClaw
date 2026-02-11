import { readJSON, writeJSON } from "@/lib/store-backend";

const TELEGRAM_PRIVY_LINKS_FILE = "telegram_privy_links.json";

export type TelegramPrivyLink = {
  telegramUserId: string;
  privyUserId: string;
  telegramChatId?: string;
  linkedAt: number;
  updatedAt: number;
};

type TelegramPrivyLinkMap = Record<string, TelegramPrivyLink>;

function normalize(value: string | undefined): string {
  return (value ?? "").trim();
}

export async function getTelegramPrivyLink(
  telegramUserId: string
): Promise<TelegramPrivyLink | null> {
  const key = normalize(telegramUserId);
  if (!key) return null;
  const links = await readJSON<TelegramPrivyLinkMap>(TELEGRAM_PRIVY_LINKS_FILE, {});
  return links[key] ?? null;
}

export async function linkTelegramPrivy(params: {
  telegramUserId: string;
  privyUserId: string;
  telegramChatId?: string;
}): Promise<TelegramPrivyLink> {
  const telegramUserId = normalize(params.telegramUserId);
  const privyUserId = normalize(params.privyUserId);
  const telegramChatId = normalize(params.telegramChatId) || undefined;

  if (!telegramUserId) {
    throw new Error("telegramUserId is required");
  }
  if (!privyUserId) {
    throw new Error("privyUserId is required");
  }

  const links = await readJSON<TelegramPrivyLinkMap>(TELEGRAM_PRIVY_LINKS_FILE, {});
  const now = Date.now();
  const existing = links[telegramUserId];
  const linked: TelegramPrivyLink = {
    telegramUserId,
    privyUserId,
    telegramChatId: telegramChatId ?? existing?.telegramChatId,
    linkedAt: existing?.linkedAt ?? now,
    updatedAt: now,
  };
  links[telegramUserId] = linked;
  await writeJSON(TELEGRAM_PRIVY_LINKS_FILE, links);
  return linked;
}
