import { NextResponse } from "next/server";
import { getAgents } from "@/lib/store";
import { executeApprovedTrade } from "@/lib/agent-runner";

/**
 * POST /api/telegram/webhook
 *
 * Telegram Bot webhook handler.
 * Processes:
 * - /start command (link telegram chat to agent)
 * - Inline button callbacks for trade approvals
 * - Messages in vault group chats
 */
export async function POST(request: Request) {
  try {
    const update = await request.json();

    // Handle callback queries (inline button presses)
    if (update.callback_query) {
      const callbackData = update.callback_query.data as string;
      const chatId = update.callback_query.message?.chat?.id;

      if (callbackData.startsWith("approve_")) {
        const approvalId = callbackData.replace("approve_", "");
        return await handleApproval(approvalId, "approve", chatId);
      }

      if (callbackData.startsWith("reject_")) {
        const approvalId = callbackData.replace("reject_", "");
        return await handleApproval(approvalId, "reject", chatId);
      }
    }

    // Handle text messages
    if (update.message?.text) {
      const text = update.message.text as string;
      const chatId = update.message.chat.id.toString();

      // /start command
      if (text.startsWith("/start")) {
        const TELEGRAM_API = "https://api.telegram.org/bot";
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (token) {
          await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: `🐾 *Welcome to Hyperclaw*\n\nI'm your trading agent notification bot.\n\nYour Chat ID: \`${chatId}\`\n\nCopy this ID and paste it when creating your agent to receive:\n• Trade notifications with edge explanations\n• Approval requests for semi-autonomous trades\n• Daily PnL summaries\n\nVisit the Hyperclaw app to get started!`,
              parse_mode: "Markdown",
            }),
          });
        }
        return NextResponse.json({ ok: true });
      }

      // /approve_<id> command
      if (text.startsWith("/approve_")) {
        const approvalId = text.replace("/approve_", "").trim();
        return await handleApproval(approvalId, "approve", chatId);
      }

      // /reject_<id> command
      if (text.startsWith("/reject_")) {
        const approvalId = text.replace("/reject_", "").trim();
        return await handleApproval(approvalId, "reject", chatId);
      }

      // /status command
      if (text === "/status") {
        const agents = await getAgents();
        const linkedAgents = agents.filter((a) => a.telegram?.chatId === chatId);

        const TELEGRAM_API = "https://api.telegram.org/bot";
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (token && linkedAgents.length > 0) {
          const { getAgentHlState } = await import("@/lib/hyperliquid");
          const pnlResults = await Promise.all(
            linkedAgents.map((a) => getAgentHlState(a.id).then((s) => s?.totalPnl ?? a.totalPnl))
          );
          const statusLines = linkedAgents.map((a, i) => {
            const modeEmoji = a.autonomy.mode === "full" ? "🤖" : a.autonomy.mode === "semi" ? "🤝" : "👤";
            const pnl = pnlResults[i] ?? a.totalPnl;
            return `${modeEmoji} *${a.name}*\nStatus: ${a.status} | PnL: $${pnl.toFixed(2)}\nMode: ${a.autonomy.mode} | Trades: ${a.totalTrades}`;
          });

          await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: `📊 *Your Agents*\n\n${statusLines.join("\n\n")}`,
              parse_mode: "Markdown",
            }),
          });
        }
        return NextResponse.json({ ok: true });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json({ ok: true }); // Always return 200 to Telegram
  }
}

async function handleApproval(approvalId: string, action: "approve" | "reject", chatId: string) {
  try {
    // Find agent with this pending approval
    const agents = await getAgents();
    const agent = agents.find(
      (a) => a.pendingApproval?.id === approvalId && a.telegram?.chatId === chatId
    );

    if (!agent) {
      return NextResponse.json({ ok: true, message: "No matching approval found" });
    }

    if (action === "approve") {
      await executeApprovedTrade(agent.id, approvalId);
    } else {
      const { updateAgent } = await import("@/lib/store");
      await updateAgent(agent.id, {
        pendingApproval: { ...agent.pendingApproval!, status: "rejected" },
      });
    }

    // Confirm to user
    const TELEGRAM_API = "https://api.telegram.org/bot";
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token) {
      await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: action === "approve"
            ? `✅ Trade approved and executed for *${agent.name}*`
            : `❌ Trade rejected for *${agent.name}*`,
          parse_mode: "Markdown",
        }),
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Approval handling error:", error);
    return NextResponse.json({ ok: true });
  }
}
