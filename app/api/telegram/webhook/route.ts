import { NextResponse } from "next/server";
import type { Address } from "viem";
import {
  getAgents,
  getAgent,
  updateAgent,
} from "@/lib/store";
import {
  executeApprovedTrade,
  executeTick,
} from "@/lib/agent-runner";
import {
  activateAgent,
  deactivateAgent,
  getLifecycleSummary,
} from "@/lib/agent-lifecycle";
import {
  getAccountForAgent,
  getPrivateKeyForAgent,
  isPKPAccount,
} from "@/lib/account-manager";
import {
  getAgentHlState,
  getOpenOrders,
  getEnrichedMarketData,
  getL2Book,
  getFundingHistory,
  getCandleData,
  executeOrder,
  updateLeverage,
  getAssetIndex,
  getExchangeClientForAgent,
  getExchangeClientForPKP,
} from "@/lib/hyperliquid";
import type { Agent, OrderSide, PlaceOrderParams } from "@/lib/types";
import { executeOrderWithPKP } from "@/lib/lit-signing";
import { handleMcpRequest } from "@/lib/mcp-server";
import { getTelegramPrivyLink, linkTelegramPrivy } from "@/lib/telegram-privy-link";
import { isIronClawConfigured, sendToIronClaw, ironClawHealth } from "@/lib/ironclaw";
import { ensureRuntimeBootstrap } from "@/lib/runtime-bootstrap";

const TELEGRAM_API = "https://api.telegram.org/bot";
const MAX_TELEGRAM_MESSAGE = 3900;
const COMMAND_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const IRONCLAW_TEMP_AUTH_FALLBACK = "Temporary LLM auth issue.";

const TELEGRAM_BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "start", description: "Initialize chat and link Privy identity" },
  { command: "help", description: "Show full command surface" },
  { command: "arena", description: "Live standings and leaderboard view" },
  { command: "agents", description: "List scoped agents" },
  { command: "status", description: "Status snapshot (all or one agent)" },
  { command: "positions", description: "Open positions for an agent" },
  { command: "orders", description: "Open orders for an agent" },
  { command: "exposure", description: "Portfolio exposure and warnings" },
  { command: "daily", description: "Trade summary for last 24h" },
  { command: "health", description: "Runner health view" },
  { command: "market", description: "Market snapshot for a coin" },
  { command: "book", description: "Order book depth view for a coin" },
  { command: "trade", description: "Submit market order" },
  { command: "buy", description: "Shortcut for /trade buy" },
  { command: "sell", description: "Shortcut for /trade sell" },
  { command: "close", description: "Close open position" },
  { command: "lev", description: "Set leverage for a market" },
  { command: "run", description: "Run one strategy tick now" },
  { command: "pause", description: "Pause one agent" },
  { command: "resume", description: "Resume one agent" },
  { command: "link", description: "Link Telegram user to Privy user" },
  { command: "ask", description: "Ask IronClaw in this scope" },
  { command: "test", description: "Test NEAR AI auth via IronClaw" },
];

const QUICK_COMMAND_ROWS: string[][] = [
  ["/arena", "/agents", "/status"],
  ["/positions", "/orders", "/exposure"],
  ["/daily", "/market BTC", "/book BTC"],
  ["/trade", "/health", "/help"],
];

let lastCommandSyncAt = 0;
let commandSyncInFlight: Promise<void> | null = null;

type TelegramUser = {
  id?: number | string;
  username?: string;
  first_name?: string;
};

type TelegramChat = {
  id?: number | string;
  type?: string;
};

type TelegramMessage = {
  text?: string;
  chat?: TelegramChat;
  from?: TelegramUser;
};

type TelegramCallback = {
  id?: string;
  data?: string;
  from?: TelegramUser;
  message?: {
    chat?: TelegramChat;
  };
};

type TelegramUpdate = {
  message?: TelegramMessage;
  callback_query?: TelegramCallback;
};

type CommandContext = {
  chatId: string;
  userId: string | null;
  username: string | null;
  firstName: string | null;
  chatType: string | null;
};

type AgentResolution = {
  agent: Agent | null;
  error: string | null;
};

type ScopedAgents = {
  agents: Agent[];
  scopeType: "privy" | "chat";
  privyUserId: string | null;
};

type AskFallbackIntent =
  | { kind: "exposure"; args: string[] }
  | { kind: "daily"; args: string[] }
  | { kind: "pause"; args: string[] };

type AgentExecutionContext = {
  address: Address;
  exchange: Awaited<ReturnType<typeof getExchangeClientForPKP>> | ReturnType<typeof getExchangeClientForAgent>;
  privateKey: string | null;
  signingMethod: "pkp" | "traditional";
};

type SendHtmlOptions = {
  replyMarkup?: Record<string, unknown>;
};

/**
 * POST /api/telegram/webhook
 *
 * Full Telegram command surface for hyperClaw.
 */
export async function POST(request: Request) {
  try {
    await ensureRuntimeBootstrap("telegram-webhook");
    const update = (await request.json()) as TelegramUpdate;
    await ensureTelegramCommandsConfigured();

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return NextResponse.json({ ok: true });
    }

    const message = update.message;
    if (!message?.text || !message.chat?.id) {
      return NextResponse.json({ ok: true });
    }

    const ctx: CommandContext = {
      chatId: String(message.chat.id),
      userId: message.from?.id !== undefined ? String(message.from.id) : null,
      username: message.from?.username ?? null,
      firstName: message.from?.first_name ?? null,
      chatType: message.chat.type ?? null,
    };

    await handleMessageText(ctx, message.text);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json({ ok: true });
  }
}

async function handleCallbackQuery(callback: TelegramCallback): Promise<void> {
  const callbackData = callback.data ?? "";
  const chatId = callback.message?.chat?.id !== undefined ? String(callback.message.chat.id) : "";
  const callbackId = callback.id;

  if (callbackData.startsWith("approve_")) {
    const approvalId = callbackData.replace("approve_", "");
    await handleApproval(approvalId, "approve", chatId);
    if (callbackId) {
      await telegramRequest("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "Trade approved",
      });
    }
    return;
  }

  if (callbackData.startsWith("reject_")) {
    const approvalId = callbackData.replace("reject_", "");
    await handleApproval(approvalId, "reject", chatId);
    if (callbackId) {
      await telegramRequest("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "Trade rejected",
      });
    }
    return;
  }

  if (callbackId) {
    await telegramRequest("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "Unsupported action",
    });
  }
}

async function handleMessageText(ctx: CommandContext, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  if (trimmed === "/") {
    await handleHelp(ctx.chatId);
    return;
  }

  // Legacy approval shortcuts
  if (trimmed.startsWith("/approve_")) {
    const approvalId = trimmed.replace("/approve_", "").trim();
    await handleApproval(approvalId, "approve", ctx.chatId);
    return;
  }
  if (trimmed.startsWith("/reject_")) {
    const approvalId = trimmed.replace("/reject_", "").trim();
    await handleApproval(approvalId, "reject", ctx.chatId);
    return;
  }

  const cmd = parseCommand(trimmed);
  if (!cmd) {
    // Natural language fallback in private chats
    if (ctx.chatType === "private" && isIronClawConfigured()) {
      await handleAsk(ctx, trimmed);
    }
    return;
  }

  switch (cmd.name) {
    case "start":
      await handleStart(ctx, cmd.args);
      break;
    case "help":
      await handleHelp(ctx.chatId);
      break;
    case "link":
      await handleLink(ctx, cmd.args);
      break;
    case "agents":
      await handleAgents(ctx);
      break;
    case "arena":
    case "standings":
      await handleArena(ctx);
      break;
    case "status":
      await handleStatus(ctx, cmd.args);
      break;
    case "positions":
      await handlePositions(ctx, cmd.args);
      break;
    case "orders":
      await handleOrders(ctx, cmd.args);
      break;
    case "exposure":
      await handleExposure(ctx, cmd.args);
      break;
    case "daily":
      await handleDaily(ctx, cmd.args);
      break;
    case "market":
      await handleMarket(ctx.chatId, cmd.args);
      break;
    case "book":
      await handleBook(ctx.chatId, cmd.args);
      break;
    case "trade":
      await handleTrade(ctx, cmd.args);
      break;
    case "buy":
    case "sell":
    case "long":
    case "short":
      await handleSideShortcutTrade(ctx, cmd.name, cmd.args);
      break;
    case "close":
      await handleClose(ctx, cmd.args);
      break;
    case "lev":
    case "leverage":
      await handleLeverage(ctx, cmd.args);
      break;
    case "run":
      await handleRun(ctx, cmd.args);
      break;
    case "pause":
      await handlePause(ctx, cmd.args);
      break;
    case "resume":
      await handleResume(ctx, cmd.args);
      break;
    case "health":
      await handleHealth(ctx);
      break;
    case "ask":
      await handleAsk(ctx, cmd.rawArgs);
      break;
    case "test":
      await handleTestAuth(ctx);
      break;
    default:
      await sendHtmlMessage(
        ctx.chatId,
        "Unknown command. Use <code>/help</code> or select from the command keyboard.",
        { replyMarkup: quickCommandKeyboard() }
      );
      break;
  }
}

async function handleStart(ctx: CommandContext, args: string[]): Promise<void> {
  let linkLine = "";
  if (args[0] && ctx.userId) {
    const privyUserId = args[0].trim();
    if (privyUserId) {
      const link = await linkTelegramPrivy({
        telegramUserId: ctx.userId,
        privyUserId,
        telegramChatId: ctx.chatId,
      });
      const claimedAgents = await claimAgentsForPrivy(link.privyUserId, ctx.chatId);
      linkLine = `Linked to Privy user <code>${escapeHtml(link.privyUserId)}</code>.`;
      if (claimedAgents.length > 0) {
        linkLine += ` Claimed <code>${claimedAgents.length}</code> agent(s).`;
      }
    }
  }

  const existingLink = ctx.userId ? await getTelegramPrivyLink(ctx.userId) : null;
  const scoped = await getScopedAgents(ctx);
  const message = [
    "<b>Hyperclaw Telegram Terminal Online</b>",
    "",
    `Chat ID: <code>${escapeHtml(ctx.chatId)}</code>`,
    `Telegram User ID: <code>${escapeHtml(ctx.userId ?? "unknown")}</code>`,
    linkLine,
    existingLink?.privyUserId
      ? `Current Privy link: <code>${escapeHtml(existingLink.privyUserId)}</code>`
      : "<b>Action required:</b> link your Privy user id before using commands.",
    "1) Open Hyperclaw PWA and hover your wallet address (top-right).",
    "2) Copy <b>Copy TG Cmd</b> (or copy the Privy ID directly).",
    "3) Paste command here: <code>/link &lt;privy_user_id&gt;</code>",
    `Agent scope: <code>${scoped.scopeType}</code> (${scoped.agents.length} agents)`,
    "",
    "Use <code>/help</code> or tap commands below.",
  ]
    .filter(Boolean)
    .join("\n");

  await sendHtmlMessage(ctx.chatId, message, { replyMarkup: quickCommandKeyboard() });
}

async function handleHelp(chatId: string): Promise<void> {
  const help = [
    "<b>Hyperclaw Telegram Commands</b>",
    "",
    "<pre>",
    "/arena",
    "/agents",
    "/status [agent]",
    "/positions [agent]",
    "/orders [agent]",
    "/exposure [agent]",
    "/daily [agent] [hours]",
    "/health",
    "/market <coin>",
    "/book <coin>",
    "/trade <agent> <buy|sell|long|short> <coin> <size> [leverage]",
    "/buy <agent> <coin> <size> [leverage]",
    "/sell <agent> <coin> <size> [leverage]",
    "/close <agent> <coin> [size]",
    "/lev <agent> <coin> <leverage> [cross|isolated]",
    "/run <agent>",
    "/pause <agent>",
    "/resume <agent>",
    "/link <privy_user_id>",
    "/ask <prompt>",
    "/test",
    "</pre>",
    "",
    "<b>Examples</b>",
    "<pre>/arena\n/status alpha\n/exposure\n/trade alpha long BTC 0.01 5\n/close alpha BTC\n/market ETH\n/ask summarize risk right now\n/test</pre>",
  ].join("\n");

  await sendHtmlMessage(chatId, help, { replyMarkup: quickCommandKeyboard() });
}

async function handleLink(ctx: CommandContext, args: string[]): Promise<void> {
  if (!ctx.userId) {
    await sendHtmlMessage(ctx.chatId, "Unable to read Telegram user id for this message.");
    return;
  }
  const privyUserId = args[0]?.trim();
  if (!privyUserId) {
    await sendHtmlMessage(ctx.chatId, "Usage: <code>/link &lt;privy_user_id&gt;</code>");
    return;
  }

  const link = await linkTelegramPrivy({
    telegramUserId: ctx.userId,
    privyUserId,
    telegramChatId: ctx.chatId,
  });

  const claimedAgents = await claimAgentsForPrivy(link.privyUserId, ctx.chatId);

  await sendHtmlMessage(
    ctx.chatId,
    [
      "<b>Identity Link Updated</b>",
      `Privy user: <code>${escapeHtml(link.privyUserId)}</code>`,
      `Telegram user: <code>${escapeHtml(link.telegramUserId)}</code>`,
      `Claimed agents: <code>${claimedAgents.length}</code>`,
    ].join("\n")
  );
}

async function handleAgents(ctx: CommandContext): Promise<void> {
  const scoped = await getScopedAgents(ctx);
  if (scoped.agents.length === 0) {
    await sendHtmlMessage(
      ctx.chatId,
      "No agents found for this chat scope. Link ownership with <code>/link &lt;privy_user_id&gt;</code> or attach this chat id when creating agents."
    );
    return;
  }

  const states = await Promise.all(
    scoped.agents.map(async (agent) => {
      const state = await getAgentHlState(agent.id).catch(() => null);
      return { agent, state };
    })
  );

  const header = "ID       NAME         MODE   STATUS  PNL(USD)     EQUITY      POS";
  const lines = states.map(({ agent, state }) => {
    const pnl = state?.totalPnl ?? agent.totalPnl;
    const equity = state ? toFiniteNumber(state.accountValue) : 0;
    const positions = state?.positions.length ?? 0;
    return [
      pad(shortId(agent.id, 7), 7),
      pad(trim(agent.name, 12), 12),
      pad(agent.autonomy.mode.toUpperCase(), 6),
      pad(agent.status.toUpperCase(), 7),
      pad(formatSignedCompact(pnl, 2), 11),
      pad(formatCompact(equity, 2), 10),
      pad(String(positions), 3),
    ].join(" ");
  });

  await sendHtmlMessage(
    ctx.chatId,
    [
      `<b>Agents (${scoped.agents.length})</b>`,
      `Scope: <code>${scoped.scopeType}${scoped.privyUserId ? `:${escapeHtml(scoped.privyUserId)}` : ""}</code>`,
      `<pre>${escapeHtml([header, ...lines].join("\n"))}</pre>`,
    ].join("\n")
  );
}

async function handleArena(ctx: CommandContext): Promise<void> {
  const scoped = await getScopedAgents(ctx);
  if (scoped.agents.length === 0) {
    await sendHtmlMessage(ctx.chatId, "No scoped agents found.");
    return;
  }

  const lifecycle = await getLifecycleSummary();
  const lifecycleById = new Map(lifecycle.agents.map((row) => [row.id, row]));
  const snapshots = await Promise.all(
    scoped.agents.map(async (agent) => {
      const state = await getAgentHlState(agent.id).catch(() => null);
      const row = lifecycleById.get(agent.id);
      return {
        agent,
        row,
        pnl: state?.totalPnl ?? agent.totalPnl,
        equity: state ? toFiniteNumber(state.accountValue) : 0,
        winRate: Number.isFinite(agent.winRate) ? agent.winRate : 0,
        positions: state?.positions.length ?? 0,
      };
    })
  );

  snapshots.sort((a, b) => {
    if (b.pnl !== a.pnl) return b.pnl - a.pnl;
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return b.equity - a.equity;
  });

  const maxAbsPnl = Math.max(1, ...snapshots.map((s) => Math.abs(s.pnl)));
  const header = "RK NAME         PNL(USD)     EQUITY      WIN%   POS  RUN  MOMENTUM";
  const rows = snapshots.map((s, idx) =>
    [
      pad(String(idx + 1), 2),
      pad(trim(s.agent.name, 12), 12),
      pad(formatSignedCompact(s.pnl, 2), 11),
      pad(formatCompact(s.equity, 2), 10),
      pad(formatCompact(s.winRate * 100, 1), 6),
      pad(String(s.positions), 4),
      pad(s.row?.runnerActive ? "ON" : "OFF", 4),
      centeredBar(s.pnl, maxAbsPnl, 13),
    ].join(" ")
  );

  const leaders = snapshots
    .slice(0, 3)
    .map(
      (s, idx) =>
        `${idx + 1}. <b>${escapeHtml(s.agent.name)}</b>  PnL <code>${escapeHtml(
          formatSignedCompact(s.pnl, 2)
        )}</code>  Win <code>${escapeHtml(formatCompact(s.winRate * 100, 1))}%</code>`
    )
    .join("\n");

  const out = [
    `<b>Live Arena Standings (${snapshots.length})</b>`,
    `Scope: <code>${scoped.scopeType}${scoped.privyUserId ? `:${escapeHtml(scoped.privyUserId)}` : ""}</code>`,
    leaders ? `<b>Leaders</b>\n${leaders}` : "",
    `<pre>${escapeHtml([header, ...rows].join("\n"))}</pre>`,
    "Refresh: <code>/arena</code>",
  ]
    .filter(Boolean)
    .join("\n");

  await sendHtmlMessage(ctx.chatId, out);
}

async function handleStatus(ctx: CommandContext, args: string[]): Promise<void> {
  const scoped = await getScopedAgents(ctx);
  if (scoped.agents.length === 0) {
    await sendHtmlMessage(ctx.chatId, "No scoped agents found.");
    return;
  }

  const target = resolveAgentReference(args[0], scoped.agents);
  if (target.error) {
    await sendHtmlMessage(ctx.chatId, escapeHtml(target.error));
    return;
  }

  const selectedAgents = target.agent ? [target.agent] : scoped.agents;
  const lifecycle = await getLifecycleSummary();
  const lifecycleById = new Map(lifecycle.agents.map((row) => [row.id, row]));

  const blocks: string[] = [];
  for (const agent of selectedAgents) {
    const state = await getAgentHlState(agent.id).catch(() => null);
    const row = lifecycleById.get(agent.id);
    const pnl = state?.totalPnl ?? agent.totalPnl;
    const eq = state ? toFiniteNumber(state.accountValue) : 0;
    const avail = state ? toFiniteNumber(state.availableBalance) : 0;
    const margin = state ? toFiniteNumber(state.marginUsed) : 0;
    const positionCount = state?.positions.length ?? 0;
    const strength = Math.min(1, Math.abs(pnl) / (Math.max(eq, 1) * 0.1));
    const pnlBar = bar(strength, 1, 12);

    blocks.push(
      [
        `<b>${escapeHtml(agent.name)}</b> <code>${escapeHtml(agent.id)}</code>`,
        `Status: <code>${escapeHtml(agent.status)}</code> | Mode: <code>${escapeHtml(agent.autonomy.mode)}</code>`,
        `Runner: <code>${row?.runnerActive ? "running" : "stopped"}</code> | Health: <code>${escapeHtml(row?.healthStatus ?? "unknown")}</code>`,
        `PnL: <code>${escapeHtml(formatSignedCompact(pnl, 2))}</code> [<code>${escapeHtml(pnlBar)}</code>]`,
        `Equity: <code>${escapeHtml(formatCompact(eq, 2))}</code> | Available: <code>${escapeHtml(formatCompact(avail, 2))}</code> | Margin: <code>${escapeHtml(formatCompact(margin, 2))}</code>`,
        `Open positions: <code>${positionCount}</code> | Markets: <code>${escapeHtml(agent.markets.join(","))}</code>`,
      ].join("\n")
    );
  }

  await sendHtmlMessage(ctx.chatId, blocks.join("\n\n"));
}

async function handlePositions(ctx: CommandContext, args: string[]): Promise<void> {
  const scoped = await getScopedAgents(ctx);
  if (scoped.agents.length === 0) {
    await sendHtmlMessage(ctx.chatId, "No scoped agents found.");
    return;
  }

  const target = resolveAgentReference(args[0], scoped.agents);
  if (target.error || !target.agent) {
    await sendHtmlMessage(
      ctx.chatId,
      escapeHtml(target.error ?? "Usage: /positions <agent>")
    );
    return;
  }

  const state = await getAgentHlState(target.agent.id);
  if (!state || state.positions.length === 0) {
    await sendHtmlMessage(
      ctx.chatId,
      `<b>${escapeHtml(target.agent.name)}</b>\nNo open positions.`
    );
    return;
  }

  const header = "COIN  SIDE  SIZE        ENTRY       MARK        PNL        PNL%    LEV";
  const rows = state.positions.map((p) =>
    [
      pad(trim(p.coin, 5), 5),
      pad(p.side.toUpperCase(), 5),
      pad(formatCompact(p.size, 4), 10),
      pad(formatCompact(p.entryPrice, 2), 10),
      pad(formatCompact(p.markPrice, 2), 10),
      pad(formatSignedCompact(p.unrealizedPnl, 2), 10),
      pad(formatSignedCompact(p.unrealizedPnlPercent, 2), 7),
      pad(`${Math.round(p.leverage)}x`, 4),
    ].join(" ")
  );

  const totalNotional = state.positions.reduce((sum, p) => sum + Math.abs(p.positionValue), 0);
  const totalPnl = state.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  await sendHtmlMessage(
    ctx.chatId,
    [
      `<b>${escapeHtml(target.agent.name)} Positions</b>`,
      `<pre>${escapeHtml([header, ...rows].join("\n"))}</pre>`,
      `Notional: <code>${escapeHtml(formatCompact(totalNotional, 2))}</code> | Unrealized: <code>${escapeHtml(formatSignedCompact(totalPnl, 2))}</code>`,
    ].join("\n")
  );
}

async function handleOrders(ctx: CommandContext, args: string[]): Promise<void> {
  const scoped = await getScopedAgents(ctx);
  if (scoped.agents.length === 0) {
    await sendHtmlMessage(ctx.chatId, "No scoped agents found.");
    return;
  }

  const target = resolveAgentReference(args[0], scoped.agents);
  if (target.error || !target.agent) {
    await sendHtmlMessage(ctx.chatId, escapeHtml(target.error ?? "Usage: /orders <agent>"));
    return;
  }

  const account = await getAccountForAgent(target.agent.id);
  if (!account) {
    await sendHtmlMessage(ctx.chatId, `No Hyperliquid account linked to ${escapeHtml(target.agent.name)}.`);
    return;
  }

  const orders = await getOpenOrders(account.address);
  if (!orders || orders.length === 0) {
    await sendHtmlMessage(ctx.chatId, `<b>${escapeHtml(target.agent.name)}</b>\nNo open orders.`);
    return;
  }

  const header = "OID        COIN  SIDE  TYPE      PRICE        SIZE     REDUCE";
  const rows = orders.slice(0, 20).map((o) => {
    const row = asRecord(o);
    const sideRaw = String(row.side ?? "").toUpperCase();
    const side = sideRaw === "B" ? "BUY" : sideRaw === "A" ? "SELL" : trim(sideRaw, 4);
    const orderTypeRaw = row.orderType;
    const orderType =
      typeof orderTypeRaw === "string"
        ? orderTypeRaw
        : orderTypeRaw && typeof orderTypeRaw === "object"
          ? "trigger"
          : "limit";

    return [
      pad(String(row.oid ?? "-"), 10),
      pad(trim(String(row.coin ?? "-"), 5), 5),
      pad(side, 5),
      pad(trim(orderType, 8), 8),
      pad(formatCompact(toFiniteNumber(row.limitPx), 4), 11),
      pad(formatCompact(toFiniteNumber(row.sz), 4), 8),
      pad(Boolean(row.reduceOnly) ? "yes" : "no", 6),
    ].join(" ");
  });

  await sendHtmlMessage(
    ctx.chatId,
    [
      `<b>${escapeHtml(target.agent.name)} Open Orders (${orders.length})</b>`,
      `<pre>${escapeHtml([header, ...rows].join("\n"))}</pre>`,
    ].join("\n")
  );
}

async function handleExposure(ctx: CommandContext, args: string[]): Promise<void> {
  const agent = args[0]?.trim();
  const report = await callMcpTool("hyperclaw_exposure", {
    agent: agent || undefined,
    include_positions: false,
    telegram_user_id: ctx.userId ?? undefined,
    telegram_chat_id: ctx.chatId,
  });

  if (typeof report === "string") {
    await sendHtmlMessage(ctx.chatId, escapeHtml(report));
    return;
  }

  const reportObj = asRecord(report);
  const totals = asRecord(reportObj.totals);
  const byCoin = asArray(reportObj.byCoin).map(asRecord);
  const warnings = asArray(reportObj.warnings).map((v) => String(v));

  const gross = toFiniteNumber(totals.grossExposureUsd);
  const net = toFiniteNumber(totals.netExposureUsd);
  const equity = toFiniteNumber(totals.accountValueUsd);
  const leverageProxy = toFiniteNumber(totals.exposureToEquity);

  const maxCoin = Math.max(
    1,
    ...byCoin.map((row) => toFiniteNumber(row.grossNotionalUsd))
  );
  const coinLines = byCoin.slice(0, 8).map((row) => {
    const coin = String(row.coin ?? "?").toUpperCase();
    const grossUsd = toFiniteNumber(row.grossNotionalUsd);
    const share = toFiniteNumber(row.exposureShare) * 100;
    return `${pad(trim(coin, 6), 6)} ${bar(grossUsd, maxCoin, 10)} ${pad(formatCompact(grossUsd, 2), 10)} ${pad(formatCompact(share, 1), 5)}%`;
  });

  const out = [
    `<b>Exposure ${agent ? `(${escapeHtml(agent)})` : "(portfolio)"}</b>`,
    `Gross: <code>${escapeHtml(formatCompact(gross, 2))}</code> | Net: <code>${escapeHtml(formatSignedCompact(net, 2))}</code> | Equity: <code>${escapeHtml(formatCompact(equity, 2))}</code>`,
    `Exposure/Equity: <code>${escapeHtml(formatCompact(leverageProxy, 2))}x</code>`,
    coinLines.length > 0
      ? `<pre>${escapeHtml(["COIN   DEPTH BAR   GROSS USD    SHARE", ...coinLines].join("\n"))}</pre>`
      : "No active exposure rows.",
  ];

  if (warnings.length > 0) {
    out.push(`<b>Warnings</b>\n${escapeHtml(warnings.slice(0, 5).join("\n"))}`);
  }

  await sendHtmlMessage(ctx.chatId, out.join("\n"));
}

async function handleDaily(ctx: CommandContext, args: string[]): Promise<void> {
  const maybeHours = args.length > 0 ? toFiniteNumber(args[args.length - 1]) : 0;
  const hasHours = Number.isFinite(maybeHours) && maybeHours >= 1;
  const windowHours = hasHours ? Math.floor(maybeHours) : 24;
  const agent = hasHours ? args.slice(0, -1).join(" ").trim() : args.join(" ").trim();

  const report = await callMcpTool("hyperclaw_daily_trade_summary", {
    agent: agent || undefined,
    window_hours: windowHours,
    telegram_user_id: ctx.userId ?? undefined,
    telegram_chat_id: ctx.chatId,
  });

  if (typeof report === "string") {
    await sendHtmlMessage(ctx.chatId, escapeHtml(report));
    return;
  }

  const obj = asRecord(report);
  const totals = asRecord(obj.totals);
  const topAssets = asArray(obj.topAssets).map(asRecord);
  const anomalies = asArray(obj.anomalies).map(asRecord);

  const attempted = toFiniteNumber(totals.attempted);
  const executed = toFiniteNumber(totals.executed);
  const rejected = toFiniteNumber(totals.rejected);
  const rejectionRate = toFiniteNumber(totals.rejectionRate) * 100;
  const avgConfidence = toFiniteNumber(totals.avgConfidence) * 100;
  const executedNotional = toFiniteNumber(totals.executedNotionalUsd);

  const maxAssetCount = Math.max(1, ...topAssets.map((a) => toFiniteNumber(a.count)));
  const assetLines = topAssets.slice(0, 8).map((a) => {
    const symbol = String(a.asset ?? "?");
    const count = toFiniteNumber(a.count);
    const share = toFiniteNumber(a.share) * 100;
    return `${pad(trim(symbol, 6), 6)} ${bar(count, maxAssetCount, 10)} ${pad(String(Math.floor(count)), 4)} ${pad(formatCompact(share, 1), 5)}%`;
  });

  const anomalyLines = anomalies.slice(0, 8).map((a) => {
    const severity = String(a.severity ?? "info").toUpperCase();
    const message = String(a.message ?? a.code ?? "anomaly");
    return `${severity}: ${message}`;
  });

  const out = [
    `<b>Daily Trade Summary (${windowHours}h)</b>`,
    `Attempted: <code>${Math.floor(attempted)}</code> | Executed: <code>${Math.floor(executed)}</code> | Rejected: <code>${Math.floor(rejected)}</code>`,
    `Reject rate: <code>${escapeHtml(formatCompact(rejectionRate, 1))}%</code> | Avg confidence: <code>${escapeHtml(formatCompact(avgConfidence, 1))}%</code>`,
    `Executed notional: <code>${escapeHtml(formatCompact(executedNotional, 2))}</code>`,
    assetLines.length > 0
      ? `<pre>${escapeHtml(["ASSET  ACTIVITY     CNT  SHARE", ...assetLines].join("\n"))}</pre>`
      : "No trade asset activity in this window.",
    anomalyLines.length > 0
      ? `<b>Anomalies</b>\n${escapeHtml(anomalyLines.join("\n"))}`
      : "<b>Anomalies</b>\nNone detected.",
  ];

  await sendHtmlMessage(ctx.chatId, out.join("\n"));
}

async function handleMarket(chatId: string, args: string[]): Promise<void> {
  const coin = (args[0] ?? "").toUpperCase();
  if (!coin) {
    await sendHtmlMessage(chatId, "Usage: <code>/market &lt;coin&gt;</code>");
    return;
  }

  const markets = await getEnrichedMarketData();
  const market = markets.find((m) => m.coin.toUpperCase() === coin);
  if (!market) {
    await sendHtmlMessage(chatId, `Market not found for <code>${escapeHtml(coin)}</code>.`);
    return;
  }

  const now = Date.now();
  const [funding, candles] = await Promise.all([
    getFundingHistory(coin, now - 24 * 60 * 60 * 1000).catch(() => []),
    getCandleData(coin, "15m", now - 6 * 60 * 60 * 1000, now).catch(() => []),
  ]);

  const fundingRows = Array.isArray(funding) ? funding.map(asRecord) : [];
  const lastFundingRow = fundingRows[fundingRows.length - 1];
  const fundingRate =
    lastFundingRow
      ? toFiniteNumber(lastFundingRow.fundingRate ?? lastFundingRow.rate ?? market.fundingRate / 100)
      : market.fundingRate / 100;

  const candleRows = Array.isArray(candles) ? candles.map(asRecord) : [];
  const closes = candleRows
    .map((row) => toFiniteNumber(row.c))
    .filter((n) => Number.isFinite(n) && n > 0);
  const spark = closes.length > 1 ? sparkline(closes.slice(-24)) : "n/a";

  const out = [
    `<b>${escapeHtml(coin)} Market Snapshot</b>`,
    `Price: <code>${escapeHtml(formatCompact(market.price, 4))}</code>`,
    `Funding: <code>${escapeHtml(formatSignedCompact(fundingRate * 100, 4))}%</code>`,
    `Open interest: <code>${escapeHtml(formatCompact(market.openInterest, 2))}</code>`,
    `24h volume: <code>${escapeHtml(formatCompact(market.volume24h, 2))}</code>`,
    `Trend(6h/15m): <code>${escapeHtml(spark)}</code>`,
  ];

  await sendHtmlMessage(chatId, out.join("\n"));
}

async function handleBook(chatId: string, args: string[]): Promise<void> {
  const coin = (args[0] ?? "").toUpperCase();
  if (!coin) {
    await sendHtmlMessage(chatId, "Usage: <code>/book &lt;coin&gt;</code>");
    return;
  }

  const book = asRecord(await getL2Book(coin));
  const levels = asArray(book.levels);
  const bidsRaw = levels.length > 0 ? asArray(levels[0]) : [];
  const asksRaw = levels.length > 1 ? asArray(levels[1]) : [];

  const bids = bidsRaw.slice(0, 8).map((row) => {
    const level = asRecord(row);
    return {
      price: toFiniteNumber(level.px),
      size: toFiniteNumber(level.sz),
    };
  });
  const asks = asksRaw.slice(0, 8).map((row) => {
    const level = asRecord(row);
    return {
      price: toFiniteNumber(level.px),
      size: toFiniteNumber(level.sz),
    };
  });

  if (bids.length === 0 || asks.length === 0) {
    await sendHtmlMessage(chatId, `No order book data for <code>${escapeHtml(coin)}</code>.`);
    return;
  }

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const spread = bestAsk - bestBid;
  const mid = (bestAsk + bestBid) / 2;
  const spreadPct = mid > 0 ? (spread / mid) * 100 : 0;

  const maxSize = Math.max(
    1,
    ...bids.map((l) => l.size),
    ...asks.map((l) => l.size)
  );
  const askLines = asks.map(
    (l) => `${pad(formatCompact(l.price, 4), 12)} ${pad(formatCompact(l.size, 4), 10)} ${bar(l.size, maxSize, 8)}`
  );
  const bidLines = bids.map(
    (l) => `${pad(formatCompact(l.price, 4), 12)} ${pad(formatCompact(l.size, 4), 10)} ${bar(l.size, maxSize, 8)}`
  );

  const out = [
    `<b>${escapeHtml(coin)} Order Book</b>`,
    `Best bid: <code>${escapeHtml(formatCompact(bestBid, 4))}</code> | Best ask: <code>${escapeHtml(formatCompact(bestAsk, 4))}</code>`,
    `Spread: <code>${escapeHtml(formatCompact(spread, 6))}</code> (<code>${escapeHtml(formatCompact(spreadPct, 4))}%</code>)`,
    "<pre>" + escapeHtml(["ASKS (price,size,depth)", ...askLines].join("\n")) + "</pre>",
    "<pre>" + escapeHtml(["BIDS (price,size,depth)", ...bidLines].join("\n")) + "</pre>",
  ];

  await sendHtmlMessage(chatId, out.join("\n"));
}

async function handleTrade(ctx: CommandContext, args: string[]): Promise<void> {
  if (args.length < 4) {
    await sendHtmlMessage(
      ctx.chatId,
      "Usage: <code>/trade &lt;agent&gt; &lt;buy|sell|long|short&gt; &lt;coin&gt; &lt;size&gt; [leverage]</code>"
    );
    return;
  }

  const scoped = await getScopedAgents(ctx);
  const resolution = resolveAgentReference(args[0], scoped.agents);
  if (resolution.error || !resolution.agent) {
    await sendHtmlMessage(ctx.chatId, escapeHtml(resolution.error ?? "Agent not found."));
    return;
  }

  const sideRaw = args[1].toLowerCase();
  if (!["buy", "sell", "long", "short"].includes(sideRaw)) {
    await sendHtmlMessage(ctx.chatId, "Side must be buy, sell, long, or short.");
    return;
  }
  const side = sideRaw as OrderSide;

  const coin = args[2].toUpperCase();
  const size = parseNumericArg(args[3]);
  if (size === null || size <= 0) {
    await sendHtmlMessage(ctx.chatId, "Size must be a positive number.");
    return;
  }

  const leverageRaw = parseNumericArg(args[4]);
  if (args[4] && (leverageRaw === null || leverageRaw <= 0)) {
    await sendHtmlMessage(ctx.chatId, "Leverage must be a positive number.");
    return;
  }
  const leverage =
    leverageRaw !== null ? Math.max(1, Math.min(50, Math.round(leverageRaw))) : undefined;

  const order: PlaceOrderParams = {
    coin,
    side,
    size,
    orderType: "market",
  };

  const execution = await executeOrderForAgent(resolution.agent.id, order, leverage, "cross");
  await sendHtmlMessage(
    ctx.chatId,
    [
      `<b>Trade submitted for ${escapeHtml(resolution.agent.name)}</b>`,
      `Order: <code>${escapeHtml(`${side.toUpperCase()} ${coin} ${size}`)}</code>`,
      leverage ? `Leverage set: <code>${leverage}x</code>` : "",
      `Signer: <code>${execution.signingMethod}</code>`,
      `<pre>${escapeHtml(truncate(JSON.stringify(execution.result, null, 2), 1400))}</pre>`,
    ]
      .filter(Boolean)
      .join("\n")
  );
}

async function handleSideShortcutTrade(
  ctx: CommandContext,
  side: "buy" | "sell" | "long" | "short",
  args: string[]
): Promise<void> {
  if (args.length < 3) {
    await sendHtmlMessage(
      ctx.chatId,
      `Usage: <code>/${side} &lt;agent&gt; &lt;coin&gt; &lt;size&gt; [leverage]</code>`
    );
    return;
  }
  await handleTrade(ctx, [args[0], side, args[1], args[2], args[3] ?? ""]);
}

async function handleClose(ctx: CommandContext, args: string[]): Promise<void> {
  if (args.length < 2) {
    await sendHtmlMessage(
      ctx.chatId,
      "Usage: <code>/close &lt;agent&gt; &lt;coin&gt; [size]</code>"
    );
    return;
  }

  const scoped = await getScopedAgents(ctx);
  const resolution = resolveAgentReference(args[0], scoped.agents);
  if (resolution.error || !resolution.agent) {
    await sendHtmlMessage(ctx.chatId, escapeHtml(resolution.error ?? "Agent not found."));
    return;
  }

  const coin = args[1].toUpperCase();
  const state = await getAgentHlState(resolution.agent.id);
  if (!state) {
    await sendHtmlMessage(ctx.chatId, "Unable to read agent state.");
    return;
  }

  const position = state.positions.find((p) => p.coin.toUpperCase() === coin);
  if (!position) {
    await sendHtmlMessage(ctx.chatId, `No open ${escapeHtml(coin)} position for this agent.`);
    return;
  }

  const explicitSize = parseNumericArg(args[2]);
  if (args[2] && (explicitSize === null || explicitSize <= 0)) {
    await sendHtmlMessage(ctx.chatId, "Close size must be a positive number.");
    return;
  }
  const closeSize = explicitSize !== null && explicitSize > 0 ? explicitSize : position.size;
  const closeSide: OrderSide = position.side === "long" ? "sell" : "buy";

  const order: PlaceOrderParams = {
    coin,
    side: closeSide,
    size: closeSize,
    orderType: "market",
    reduceOnly: true,
  };
  const execution = await executeOrderForAgent(resolution.agent.id, order);

  await sendHtmlMessage(
    ctx.chatId,
    [
      `<b>Close submitted for ${escapeHtml(resolution.agent.name)}</b>`,
      `Order: <code>${escapeHtml(`${closeSide.toUpperCase()} ${coin} ${closeSize}`)}</code> (reduce-only)`,
      `Signer: <code>${execution.signingMethod}</code>`,
      `<pre>${escapeHtml(truncate(JSON.stringify(execution.result, null, 2), 1400))}</pre>`,
    ].join("\n")
  );
}

async function handleLeverage(ctx: CommandContext, args: string[]): Promise<void> {
  if (args.length < 3) {
    await sendHtmlMessage(
      ctx.chatId,
      "Usage: <code>/lev &lt;agent&gt; &lt;coin&gt; &lt;leverage&gt; [cross|isolated]</code>"
    );
    return;
  }

  const scoped = await getScopedAgents(ctx);
  const resolution = resolveAgentReference(args[0], scoped.agents);
  if (resolution.error || !resolution.agent) {
    await sendHtmlMessage(ctx.chatId, escapeHtml(resolution.error ?? "Agent not found."));
    return;
  }

  const coin = args[1].toUpperCase();
  const leverageRaw = parseNumericArg(args[2]);
  if (leverageRaw === null || leverageRaw <= 0) {
    await sendHtmlMessage(ctx.chatId, "Leverage must be between 1 and 50.");
    return;
  }
  const leverage = Math.max(1, Math.min(50, Math.round(leverageRaw)));
  const mode = (args[3] ?? "cross").toLowerCase() === "isolated" ? "isolated" : "cross";

  const executionCtx = await getAgentExecutionContext(resolution.agent.id);
  const assetIndex = await getAssetIndex(coin);
  const result = await updateLeverage(assetIndex, leverage, mode === "cross", executionCtx.exchange);

  await sendHtmlMessage(
    ctx.chatId,
    [
      `<b>Leverage updated for ${escapeHtml(resolution.agent.name)}</b>`,
      `Market: <code>${escapeHtml(coin)}</code>`,
      `Leverage: <code>${leverage}x</code>`,
      `Mode: <code>${mode}</code>`,
      `Signer: <code>${executionCtx.signingMethod}</code>`,
      `<pre>${escapeHtml(truncate(JSON.stringify(result, null, 2), 900))}</pre>`,
    ].join("\n")
  );
}

async function handleRun(ctx: CommandContext, args: string[]): Promise<void> {
  if (args.length < 1) {
    await sendHtmlMessage(ctx.chatId, "Usage: <code>/run &lt;agent&gt;</code>");
    return;
  }

  const scoped = await getScopedAgents(ctx);
  const resolution = resolveAgentReference(args[0], scoped.agents);
  if (resolution.error || !resolution.agent) {
    await sendHtmlMessage(ctx.chatId, escapeHtml(resolution.error ?? "Agent not found."));
    return;
  }

  const log = await executeTick(resolution.agent.id);
  await sendHtmlMessage(
    ctx.chatId,
    [
      `<b>Tick executed for ${escapeHtml(resolution.agent.name)}</b>`,
      `Decision: <code>${escapeHtml(`${log.decision.action.toUpperCase()} ${log.decision.asset}`)}</code>`,
      `Confidence: <code>${escapeHtml(formatCompact(log.decision.confidence * 100, 1))}%</code>`,
      `Executed: <code>${log.executed ? "yes" : "no"}</code>`,
      `Reasoning: ${escapeHtml(truncate(log.decision.reasoning, 280))}`,
    ].join("\n")
  );
}

async function handlePause(ctx: CommandContext, args: string[]): Promise<void> {
  if (args.length < 1) {
    await sendHtmlMessage(ctx.chatId, "Usage: <code>/pause &lt;agent&gt;</code>");
    return;
  }

  const scoped = await getScopedAgents(ctx);
  const resolution = resolveAgentReference(args[0], scoped.agents);
  if (resolution.error || !resolution.agent) {
    await sendHtmlMessage(ctx.chatId, escapeHtml(resolution.error ?? "Agent not found."));
    return;
  }

  await deactivateAgent(resolution.agent.id);
  await sendHtmlMessage(
    ctx.chatId,
    `<b>Paused</b> <code>${escapeHtml(resolution.agent.name)}</code> (${escapeHtml(resolution.agent.id)})`
  );
}

async function handleResume(ctx: CommandContext, args: string[]): Promise<void> {
  if (args.length < 1) {
    await sendHtmlMessage(ctx.chatId, "Usage: <code>/resume &lt;agent&gt;</code>");
    return;
  }

  const scoped = await getScopedAgents(ctx);
  const resolution = resolveAgentReference(args[0], scoped.agents);
  if (resolution.error || !resolution.agent) {
    await sendHtmlMessage(ctx.chatId, escapeHtml(resolution.error ?? "Agent not found."));
    return;
  }

  const state = await activateAgent(resolution.agent.id);
  await sendHtmlMessage(
    ctx.chatId,
    [
      `<b>Resumed</b> <code>${escapeHtml(resolution.agent.name)}</code> (${escapeHtml(resolution.agent.id)})`,
      `Runner: <code>${state.runnerActive ? "running" : "stopped"}</code>`,
      `AIP: <code>${state.aipRegistered ? "registered" : "not-registered"}</code>`,
    ].join("\n")
  );
}

async function handleHealth(ctx: CommandContext): Promise<void> {
  const scoped = await getScopedAgents(ctx);
  if (scoped.agents.length === 0) {
    await sendHtmlMessage(ctx.chatId, "No scoped agents found.");
    return;
  }

  const summary = await getLifecycleSummary();
  const scopedIds = new Set(scoped.agents.map((a) => a.id));
  const scopedRows = summary.agents.filter((row) => scopedIds.has(row.id));

  const header = "ID       NAME         STATUS   RUNNER   HEALTH    ERR";
  const rows = scopedRows.map((row) =>
    [
      pad(shortId(row.id, 7), 7),
      pad(trim(row.name, 12), 12),
      pad(row.status.toUpperCase(), 8),
      pad(row.runnerActive ? "ON" : "OFF", 7),
      pad(row.healthStatus.toUpperCase(), 8),
      pad(String(row.errorCount), 3),
    ].join(" ")
  );

  await sendHtmlMessage(
    ctx.chatId,
    [
      `<b>Lifecycle Health (${scopedRows.length})</b>`,
      `<pre>${escapeHtml([header, ...rows].join("\n"))}</pre>`,
    ].join("\n")
  );
}

async function handleTestAuth(ctx: CommandContext): Promise<void> {
  if (!isIronClawConfigured()) {
    await sendHtmlMessage(ctx.chatId, "IronClaw webhook is not configured.");
    return;
  }

  const out: string[] = ["<b>NEAR AI / IronClaw Auth Test</b>", ""];

  try {
    const health = await ironClawHealth();
    if (!health.ok) {
      out.push("❌ Health: IronClaw endpoint unreachable.");
      await sendHtmlMessage(ctx.chatId, out.join("\n"));
      return;
    }
    out.push(`✓ Health: ${health.status ?? "ok"}`);
  } catch (e) {
    out.push(`❌ Health: ${escapeHtml(e instanceof Error ? e.message : String(e))}`);
    await sendHtmlMessage(ctx.chatId, out.join("\n"));
    return;
  }

  out.push("Testing LLM (NEAR AI session)...");

  try {
    const result = await sendToIronClaw({
      content: "Reply with exactly: OK",
      thread_id: `telegram:test:${ctx.chatId}`,
      wait_for_response: true,
    });

    if (result?.response) {
      const ok = /^\s*OK\s*$/i.test(result.response.trim());
      out.push(ok ? "✓ NEAR AI auth: OK" : `✓ Response: ${escapeHtml(truncate(result.response, 120))}`);
    } else {
      out.push("❌ No response from IronClaw (check NEARAI_SESSION_TOKEN).");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    out.push(`❌ NEAR AI auth failed: ${escapeHtml(msg)}`);
    if (msg.toLowerCase().includes("nearai") || msg.toLowerCase().includes("auth") || msg.toLowerCase().includes("session")) {
      out.push("");
      out.push("Tip: Set NEARAI_SESSION_TOKEN in IronClaw env or mount a valid session file.");
    }
  }

  await sendHtmlMessage(ctx.chatId, out.join("\n"));
}

async function handleAsk(ctx: CommandContext, prompt: string): Promise<void> {
  const content = prompt.trim();
  if (!content) {
    await sendHtmlMessage(ctx.chatId, "Usage: <code>/ask &lt;prompt&gt;</code>");
    return;
  }
  if (!isIronClawConfigured()) {
    await sendHtmlMessage(ctx.chatId, "IronClaw webhook is not configured.");
    return;
  }

  const scoped = await getScopedAgents(ctx);
  const agentNames = scoped.agents.slice(0, 8).map((a) => a.name).join(", ");
  const scopedPrompt = [
    `telegram_chat_id=${ctx.chatId}`,
    ctx.userId ? `telegram_user_id=${ctx.userId}` : "",
    agentNames ? `scoped_agents=${agentNames}` : "",
    `prompt=${content}`,
  ]
    .filter(Boolean)
    .join("\n");

  let result;
  try {
    result = await sendToIronClaw({
      content: scopedPrompt,
      thread_id: `telegram:${ctx.chatId}`,
      wait_for_response: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sendHtmlMessage(
      ctx.chatId,
      `<b>IronClaw error</b>\n\n${escapeHtml(msg)}\n\nTry <code>/test</code> to diagnose NEAR AI auth.`
    );
    return;
  }

  if (!result?.response) {
    await sendHtmlMessage(
      ctx.chatId,
      "No response from IronClaw. Try <code>/test</code> to check NEAR AI auth."
    );
    return;
  }

  if (isIronClawTempAuthFallback(result.response)) {
    const handled = await tryHandleAskFallbackIntent(ctx, content);
    if (handled) return;
  }

  const chunks = chunkString(result.response, MAX_TELEGRAM_MESSAGE - 120);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = i === 0 ? "<b>IronClaw</b>\n\n" : "";
    await sendHtmlMessage(ctx.chatId, `${prefix}${escapeHtml(chunks[i])}`);
  }
}

async function handleApproval(
  approvalId: string,
  action: "approve" | "reject",
  chatId: string
) {
  try {
    const agents = await getAgents();
    const agent = agents.find(
      (a) => a.pendingApproval?.id === approvalId && a.telegram?.chatId === chatId
    );

    if (!agent) {
      await sendHtmlMessage(chatId, "No matching approval found.");
      return NextResponse.json({ ok: true, message: "No matching approval found" });
    }

    if (action === "approve") {
      await executeApprovedTrade(agent.id, approvalId);
    } else {
      await updateAgent(agent.id, {
        pendingApproval: { ...agent.pendingApproval!, status: "rejected" },
      });
    }

    await sendHtmlMessage(
      chatId,
      action === "approve"
        ? `Trade approved and executed for <b>${escapeHtml(agent.name)}</b>.`
        : `Trade rejected for <b>${escapeHtml(agent.name)}</b>.`
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Approval handling error:", error);
    await sendHtmlMessage(chatId, "Approval action failed.");
    return NextResponse.json({ ok: true });
  }
}

async function claimAgentsForPrivy(privyUserId: string, chatId: string): Promise<Agent[]> {
  const allAgents = await getAgents();
  const ownedCount = allAgents.filter((a) => !!a.telegram?.ownerPrivyId).length;
  let candidates = allAgents.filter((a) => a.telegram?.chatId === chatId);

  // Bootstrap fallback: if there is no ownership metadata yet and no chat match,
  // claim unowned agents to the first linked identity.
  if (candidates.length === 0 && ownedCount === 0) {
    candidates = allAgents.filter((a) => !a.telegram?.ownerPrivyId);
  }

  for (const agent of candidates) {
    await updateAgent(agent.id, {
      telegram: {
        enabled: agent.telegram?.enabled ?? true,
        chatId: agent.telegram?.chatId ?? chatId,
        notifyOnTrade: agent.telegram?.notifyOnTrade ?? true,
        notifyOnPnl: agent.telegram?.notifyOnPnl ?? true,
        notifyOnTierUnlock: agent.telegram?.notifyOnTierUnlock ?? true,
        ownerPrivyId: privyUserId,
        ownerWalletAddress: agent.telegram?.ownerWalletAddress,
      },
    });
  }

  return candidates;
}

async function getScopedAgents(ctx: CommandContext): Promise<ScopedAgents> {
  const agents = await getAgents();
  const chatScoped = agents.filter((a) => a.telegram?.chatId === ctx.chatId);

  if (ctx.userId) {
    const link = await getTelegramPrivyLink(ctx.userId);
    if (link?.privyUserId) {
      const privyScoped = agents.filter((a) => a.telegram?.ownerPrivyId === link.privyUserId);
      if (privyScoped.length > 0) {
        return {
          agents: privyScoped,
          scopeType: "privy",
          privyUserId: link.privyUserId,
        };
      }
    }
  }

  return {
    agents: chatScoped,
    scopeType: "chat",
    privyUserId: null,
  };
}

function resolveAgentReference(reference: string | undefined, agents: Agent[]): AgentResolution {
  if (agents.length === 0) {
    return { agent: null, error: "No agents in scope." };
  }

  const raw = (reference ?? "").trim();
  if (!raw) {
    if (agents.length === 1) return { agent: agents[0], error: null };
    return {
      agent: null,
      error: `Multiple agents in scope. Specify one: ${agents
        .slice(0, 8)
        .map((a) => a.name)
        .join(", ")}`,
    };
  }

  const exactId = agents.find((a) => a.id === raw);
  if (exactId) return { agent: exactId, error: null };

  const byPrefix = agents.filter((a) => a.id.startsWith(raw));
  if (byPrefix.length === 1) return { agent: byPrefix[0], error: null };
  if (byPrefix.length > 1) {
    return { agent: null, error: `Ambiguous agent id prefix: ${raw}` };
  }

  const lowered = raw.toLowerCase();
  const exactName = agents.filter((a) => a.name.toLowerCase() === lowered);
  if (exactName.length === 1) return { agent: exactName[0], error: null };
  if (exactName.length > 1) {
    return { agent: null, error: `Ambiguous agent name: ${raw}` };
  }

  const fuzzy = agents.filter((a) => a.name.toLowerCase().includes(lowered));
  if (fuzzy.length === 1) return { agent: fuzzy[0], error: null };
  if (fuzzy.length > 1) {
    return {
      agent: null,
      error: `Ambiguous agent "${raw}". Matches: ${fuzzy
        .slice(0, 5)
        .map((a) => a.name)
        .join(", ")}`,
    };
  }

  return { agent: null, error: `Agent not found: ${raw}` };
}

async function getAgentExecutionContext(agentId: string): Promise<AgentExecutionContext> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const account = await getAccountForAgent(agentId);
  if (!account) throw new Error(`No Hyperliquid account for agent ${agentId}`);

  const pkp = await isPKPAccount(agentId);
  if (pkp) {
    const exchange = await getExchangeClientForPKP(agentId);
    return {
      address: account.address as Address,
      exchange,
      privateKey: null,
      signingMethod: "pkp",
    };
  }

  const privateKey = await getPrivateKeyForAgent(agentId);
  if (!privateKey) throw new Error(`No private key for agent ${agentId}`);
  const exchange = getExchangeClientForAgent(privateKey);
  return {
    address: account.address as Address,
    exchange,
    privateKey,
    signingMethod: "traditional",
  };
}

async function executeOrderForAgent(
  agentId: string,
  order: PlaceOrderParams,
  leverage?: number,
  mode: "cross" | "isolated" = "cross"
): Promise<{ result: unknown; signingMethod: "pkp" | "traditional" }> {
  const executionCtx = await getAgentExecutionContext(agentId);
  if (leverage && Number.isFinite(leverage) && leverage > 0) {
    const assetIndex = await getAssetIndex(order.coin);
    await updateLeverage(assetIndex, leverage, mode === "cross", executionCtx.exchange);
  }

  const result =
    executionCtx.signingMethod === "pkp"
      ? await executeOrderWithPKP(agentId, order)
      : await executeOrder(order, executionCtx.exchange, { skipBuilder: true });

  return { result, signingMethod: executionCtx.signingMethod };
}

async function callMcpTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  });

  if (response.error) {
    throw new Error(response.error.message);
  }

  const result = asRecord(response.result);
  const isError = Boolean(result.isError);
  const content = asArray(result.content).map(asRecord);
  const text = String(content[0]?.text ?? "");

  if (isError) throw new Error(text || `Tool call failed: ${name}`);

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function ensureTelegramCommandsConfigured(): Promise<void> {
  const token = getBotToken();
  if (!token) return;

  const now = Date.now();
  if (now - lastCommandSyncAt < COMMAND_SYNC_INTERVAL_MS) return;
  if (commandSyncInFlight) {
    await commandSyncInFlight;
    return;
  }

  commandSyncInFlight = (async () => {
    const scopes: Array<Record<string, unknown> | null> = [
      null,
      { type: "all_private_chats" },
      { type: "all_group_chats" },
    ];

    let ok = true;
    for (const scope of scopes) {
      const payload = await telegramRequest("setMyCommands", {
        commands: TELEGRAM_BOT_COMMANDS,
        ...(scope ? { scope } : {}),
      });
      ok = ok && isTelegramOk(payload);
    }

    // Make sure the client menu opens commands directly.
    const menuPayload = await telegramRequest("setChatMenuButton", {
      menu_button: { type: "commands" },
    });
    ok = ok && isTelegramOk(menuPayload);

    if (ok) {
      lastCommandSyncAt = Date.now();
    } else {
      console.error("[Telegram webhook] command catalog sync failed");
    }
  })()
    .catch((error) => {
      console.error("[Telegram webhook] command catalog sync error:", error);
    })
    .finally(() => {
      commandSyncInFlight = null;
    });

  await commandSyncInFlight;
}

function parseCommand(text: string): { name: string; rawArgs: string; args: string[] } | null {
  const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@[\w_]+)?(?:\s+([\s\S]+))?$/);
  if (!match) return null;

  const name = (match[1] ?? "").toLowerCase();
  const rawArgs = (match[2] ?? "").trim();
  const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [];
  return { name, rawArgs, args };
}

function getBotToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token || null;
}

async function telegramRequest(method: string, body: Record<string, unknown>): Promise<unknown> {
  const token = getBotToken();
  if (!token) {
    console.error(`[Telegram webhook] ${method} skipped: TELEGRAM_BOT_TOKEN is missing`);
    return null;
  }

  try {
    const res = await fetch(`${TELEGRAM_API}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const payload = parseJsonSafe(text);
    const ok = isTelegramOk(payload);

    if (!res.ok || !ok) {
      const description =
        payload && typeof payload === "object" && "description" in payload
          ? String((payload as Record<string, unknown>).description ?? "")
          : text.slice(0, 400);
      console.error(
        `[Telegram webhook] ${method} failed: status=${res.status} description=${description}`
      );
    }

    return payload;
  } catch (error) {
    console.error(`[Telegram webhook] ${method} failed:`, error);
    return null;
  }
}

function quickCommandKeyboard(): Record<string, unknown> {
  return {
    keyboard: QUICK_COMMAND_ROWS.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Type /help or tap a command",
  };
}

async function sendHtmlMessage(chatId: string, text: string, options?: SendHtmlOptions): Promise<void> {
  let safe = text;
  if (text.length > MAX_TELEGRAM_MESSAGE) {
    const plain = text.replace(/<[^>]+>/g, "");
    safe = `${escapeHtml(truncate(plain, MAX_TELEGRAM_MESSAGE - 40))}\n\n<code>[truncated]</code>`;
  }
  const payload = await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: safe,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
  });

  if (telegramEntityParseError(payload)) {
    const plain = safe.replace(/<[^>]+>/g, "");
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: plain,
      disable_web_page_preview: true,
    });
  }
}

function parseJsonSafe(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isTelegramOk(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.ok === true;
}

function telegramEntityParseError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.ok !== false) return false;
  const description = String(record.description ?? "").toLowerCase();
  return description.includes("can't parse entities");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseNumericArg(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function trim(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function shortId(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return `${value}${" ".repeat(width - value.length)}`;
}

function formatCompact(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function formatSignedCompact(value: number, decimals: number): string {
  const core = formatCompact(Math.abs(value), decimals);
  if (value > 0) return `+${core}`;
  if (value < 0) return `-${core}`;
  return core;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function bar(value: number, max: number, width: number): string {
  if (width <= 0) return "";
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const fill = Math.round(ratio * width);
  return `${"█".repeat(fill)}${"░".repeat(width - fill)}`;
}

function centeredBar(value: number, maxAbs: number, width: number): string {
  if (width < 3) return "";
  const side = Math.floor((width - 1) / 2);
  const safeMax = maxAbs > 0 ? maxAbs : 1;
  const ratio = Math.max(0, Math.min(1, Math.abs(value) / safeMax));
  const fill = Math.round(ratio * side);
  if (value >= 0) {
    return `${"░".repeat(side)}|${"█".repeat(fill)}${"░".repeat(side - fill)}`;
  }
  return `${"░".repeat(side - fill)}${"█".repeat(fill)}|${"░".repeat(side)}`;
}

function sparkline(values: number[]): string {
  const bars = "▁▂▃▄▅▆▇█";
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return bars[0].repeat(values.length);
  return values
    .map((v) => {
      const idx = Math.max(0, Math.min(bars.length - 1, Math.round(((v - min) / (max - min)) * (bars.length - 1))));
      return bars[idx] ?? bars[0];
    })
    .join("");
}

function isIronClawTempAuthFallback(response: string): boolean {
  return response.includes(IRONCLAW_TEMP_AUTH_FALLBACK);
}

async function tryHandleAskFallbackIntent(ctx: CommandContext, prompt: string): Promise<boolean> {
  const intent = parseAskFallbackIntent(prompt);
  if (!intent) return false;

  if (intent.kind === "exposure") {
    await handleExposure(ctx, intent.args);
    return true;
  }
  if (intent.kind === "daily") {
    await handleDaily(ctx, intent.args);
    return true;
  }
  if (intent.kind === "pause") {
    await handlePause(ctx, intent.args);
    return true;
  }
  return false;
}

function parseAskFallbackIntent(prompt: string): AskFallbackIntent | null {
  const trimmed = prompt.trim();
  if (!trimmed) return null;

  const cmd = parseCommand(trimmed);
  if (cmd?.name === "exposure") return { kind: "exposure", args: cmd.args };
  if (cmd?.name === "daily") return { kind: "daily", args: cmd.args };
  if (cmd?.name === "pause" || cmd?.name === "stop") return { kind: "pause", args: cmd.args };

  const normalized = trimmed.replace(/^\/+/, "").trim();
  const lower = normalized.toLowerCase();

  if (
    lower.includes("daily trade summary") ||
    (lower.includes("daily") &&
      (lower.includes("summary") || lower.includes("anomal") || lower.includes("outlier"))) ||
    (lower.includes("action") &&
      (lower.includes("being done") ||
        lower.includes("happening") ||
        lower.includes("today") ||
        lower.includes("recent")))
  ) {
    const args: string[] = [];
    const agent = extractAskAgentTarget(normalized, lower);
    if (agent) args.push(agent);
    const windowHours = extractAskWindowHours(lower);
    if (windowHours !== null) args.push(String(windowHours));
    return { kind: "daily", args };
  }

  if (
    lower.includes("exposure") ||
    lower.includes("portfolio risk") ||
    lower.includes("risk exposure")
  ) {
    const agent = extractAskAgentTarget(normalized, lower);
    return { kind: "exposure", args: agent ? [agent] : [] };
  }

  const pauseMatch = normalized.match(/\b(?:pause|stop)\s+(?:agent\s+)?(.+)$/i);
  if (pauseMatch) {
    const cleaned = pauseMatch[1]
      .trim()
      .replace(/^[\s"'`<>()]+|[\s"'`<>().,!?]+$/g, "");
    return { kind: "pause", args: cleaned ? [cleaned] : [] };
  }

  return null;
}

function extractAskAgentTarget(original: string, lower: string): string | null {
  const marker = " for ";
  const idx = lower.indexOf(marker);
  if (idx < 0) return null;

  const raw = original.slice(idx + marker.length).trim();
  if (!raw) return null;
  const withoutPrefix = raw.replace(/^agent\s+/i, "").trim();
  const cleaned = withoutPrefix.replace(/^[\s"'`<>()]+|[\s"'`<>().,!?]+$/g, "");
  return cleaned || null;
}

function extractAskWindowHours(lower: string): number | null {
  const match = lower.match(/\b(?:last|past)\s+(\d{1,3})\s*h(?:ours?)?\b/);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.floor(parsed);
}

function chunkString(value: string, max: number): string[] {
  if (value.length <= max) return [value];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const end = Math.min(value.length, cursor + max);
    chunks.push(value.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}
