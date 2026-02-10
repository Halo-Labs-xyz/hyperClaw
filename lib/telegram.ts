/**
 * Telegram Bot Integration
 *
 * Handles:
 * - Trade notifications (with edge explanation)
 * - Trade approval requests (semi-autonomous mode)
 * - Vault chat room messages
 * - Investor questions -> AI responses
 */

import type { TradeDecision, Agent, VaultChatMessage } from "./types";

const TELEGRAM_API = "https://api.telegram.org/bot";

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return token;
}

async function telegramRequest(method: string, body: Record<string, unknown>) {
  const token = getBotToken();
  const res = await fetch(`${TELEGRAM_API}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ============================================
// Trade Notifications
// ============================================

export async function notifyTradeExecuted(
  chatId: string,
  agent: Agent,
  decision: TradeDecision,
  executed: boolean
) {
  const emoji = decision.action === "long" ? "📈" : decision.action === "short" ? "📉" : decision.action === "close" ? "🔄" : "⏸";
  const actionLabel = decision.action.toUpperCase();
  const confidenceBar = "█".repeat(Math.round(decision.confidence * 10)) + "░".repeat(10 - Math.round(decision.confidence * 10));

  const message = `${emoji} *${agent.name}* — ${executed ? "EXECUTED" : "PROPOSED"}

*${actionLabel} ${decision.asset}*
Size: ${(decision.size * 100).toFixed(0)}% of capital
Leverage: ${decision.leverage}x
Confidence: ${confidenceBar} ${(decision.confidence * 100).toFixed(0)}%

*Edge:* ${decision.reasoning}${decision.stopLoss ? `\nStop Loss: $${decision.stopLoss}` : ""}${decision.takeProfit ? `\nTake Profit: $${decision.takeProfit}` : ""}`;

  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text: message,
    parse_mode: "Markdown",
  });
}

// ============================================
// Approval Requests (Semi-Autonomous)
// ============================================

export async function sendApprovalRequest(
  chatId: string,
  agent: Agent,
  decision: TradeDecision,
  approvalId: string
) {
  const emoji = decision.action === "long" ? "📈" : "📉";

  const message = `🔔 *APPROVAL NEEDED — ${agent.name}*

${emoji} Proposed: *${decision.action.toUpperCase()} ${decision.asset}*
Size: ${(decision.size * 100).toFixed(0)}% | Leverage: ${decision.leverage}x
Confidence: ${(decision.confidence * 100).toFixed(0)}%

*Why:* ${decision.reasoning}

Reply with:
✅ /approve\\_${approvalId} — Execute this trade
❌ /reject\\_${approvalId} — Skip this trade

⏰ Auto-expires in ${Math.round(agent.autonomy.approvalTimeoutMs / 60000)} min`;

  const result = await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: message,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve_${approvalId}` },
          { text: "❌ Reject", callback_data: `reject_${approvalId}` },
        ],
      ],
    },
  });

  return result?.result?.message_id;
}

// ============================================
// Vault Chat Room Messages
// ============================================

export async function postToVaultGroup(
  groupId: string,
  message: VaultChatMessage
) {
  let text = "";

  switch (message.type) {
    case "trade_proposal":
      text = `🤖 *${message.senderName}* is considering:\n\n${message.content}`;
      break;
    case "trade_executed":
      text = `✅ *Trade Executed*\n\n${message.content}`;
      break;
    case "pnl_update":
      text = `📊 *PnL Update*\n\n${message.content}`;
      break;
    case "ai_response":
      text = `💡 *${message.senderName} responds:*\n\n${message.content}`;
      break;
    case "discussion":
      text = `💬 *${message.senderName}:* ${message.content}`;
      break;
    default:
      text = message.content;
  }

  return telegramRequest("sendMessage", {
    chat_id: groupId,
    text,
    parse_mode: "Markdown",
  });
}

// ============================================
// Daily PnL Summary
// ============================================

export async function sendPnlSummary(
  chatId: string,
  agent: Agent,
  dailyPnl: number,
  openPositions: Array<{ coin: string; pnl: number; side: string }>,
  /** Holistic total PnL (realized + unrealized). When provided, used instead of agent.totalPnl. */
  totalPnlOverride?: number
) {
  const totalPnl = typeof totalPnlOverride === "number" ? totalPnlOverride : agent.totalPnl;
  const pnlEmoji = dailyPnl >= 0 ? "🟢" : "🔴";
  const positionLines = openPositions.length === 0
    ? "No open positions"
    : openPositions
        .map((p) => `  ${p.side === "long" ? "📈" : "📉"} ${p.coin}: ${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)}`)
        .join("\n");

  const message = `${pnlEmoji} *Daily Summary — ${agent.name}*

PnL Today: ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}
Total PnL: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}
Trades Today: ${agent.totalTrades}
Win Rate: ${(agent.winRate * 100).toFixed(1)}%

*Open Positions:*
${positionLines}

Vault TVL: $${agent.vaultTvlUsd.toLocaleString()}`;

  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text: message,
    parse_mode: "Markdown",
  });
}

// ============================================
// Investor Question -> AI Response
// ============================================

export async function handleInvestorQuestion(
  groupId: string,
  question: string,
  agent: Agent,
  agentContext: string,
  /** Holistic total PnL (realized + unrealized). When provided, used instead of agent.totalPnl. */
  totalPnlOverride?: number
): Promise<string> {
  const totalPnl = typeof totalPnlOverride === "number" ? totalPnlOverride : agent.totalPnl;
  // Use OpenAI to generate a response as the agent
  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are ${agent.name}, an AI trading agent on Hyperclaw. You trade perpetual futures on Hyperliquid.
Your strategy: ${agent.description}
Markets: ${agent.markets.join(", ")}
Risk level: ${agent.riskLevel}
Current performance: PnL $${totalPnl.toFixed(2)}, Win rate ${(agent.winRate * 100).toFixed(1)}%

${agentContext}

Respond to investor questions concisely and honestly. Explain your reasoning simply. If asked about specific trades, reference your recent activity. Never give financial advice — explain what YOU are doing and why.`,
      },
      { role: "user", content: question },
    ],
    temperature: 0.5,
    max_tokens: 300,
  });

  const answer = response.choices[0]?.message?.content || "I need more data to answer that.";

  // Post to group
  await postToVaultGroup(groupId, {
    id: `ai_${Date.now()}`,
    agentId: agent.id,
    timestamp: Date.now(),
    sender: "agent",
    senderName: agent.name,
    type: "ai_response",
    content: answer,
  });

  return answer;
}

// ============================================
// Utility: Format trade for simple explanation
// ============================================

export function formatTradeExplanation(decision: TradeDecision): string {
  if (decision.action === "hold") {
    return `Holding — no strong edge right now. ${decision.reasoning}`;
  }

  const direction = decision.action === "long" ? "buying" : decision.action === "short" ? "shorting" : "closing";

  return `I'm ${direction} ${decision.asset} at ${decision.leverage}x with ${(decision.confidence * 100).toFixed(0)}% confidence. ${decision.reasoning}`;
}
