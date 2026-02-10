import { NextResponse } from "next/server";
import { getAgent, getVaultMessages, appendVaultMessage } from "@/lib/store";
import { getAgentHlState } from "@/lib/hyperliquid";
import { handleInvestorQuestion, postToVaultGroup } from "@/lib/telegram";
import type { VaultChatMessage } from "@/lib/types";
import { randomBytes } from "crypto";

/**
 * GET /api/agents/[id]/chat
 *
 * Fetch vault chat messages for an agent.
 * Query: ?limit=50
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const agentId = params.id;

  try {
    const agent = await getAgent(agentId);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const messages = await getVaultMessages(agentId, limit);

    return NextResponse.json({ messages });
  } catch (error) {
    console.error("Chat fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch messages" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/agents/[id]/chat
 *
 * Post a message to the vault chat room.
 * If message is a question, the agent will auto-respond.
 *
 * Body: { content: string, senderName: string, senderId?: string, type?: string }
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const agentId = params.id;

  try {
    const agent = await getAgent(agentId);
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    if (!agent.vaultSocial?.isOpenVault) {
      return NextResponse.json(
        { error: "This agent does not have an open vault chat" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { content, senderName, senderId, type } = body;

    if (!content?.trim()) {
      return NextResponse.json(
        { error: "Message content is required" },
        { status: 400 }
      );
    }

    // Store the investor/user message
    const messageType = type || "discussion";
    const isQuestion = messageType === "question" || content.trim().endsWith("?");

    const userMessage: VaultChatMessage = {
      id: randomBytes(8).toString("hex"),
      agentId,
      timestamp: Date.now(),
      sender: "investor",
      senderName: senderName || "Anonymous",
      senderId,
      type: isQuestion ? "question" : "discussion",
      content: content.trim(),
    };

    await appendVaultMessage(userMessage);

    // Post to Telegram group if configured
    if (agent.vaultSocial.telegramGroupId) {
      try {
        await postToVaultGroup(agent.vaultSocial.telegramGroupId, userMessage);
      } catch {
        // Ignore Telegram errors
      }
    }

    // If it's a question and agent responds to questions, generate AI response
    let aiResponse: string | undefined;
    if (isQuestion && agent.vaultSocial.agentRespondsToQuestions) {
      try {
        // Build context from recent messages
        const recentMessages = await getVaultMessages(agentId, 10);
        const contextStr = recentMessages
          .map((m) => `[${m.sender}] ${m.senderName}: ${m.content}`)
          .join("\n");

        if (agent.vaultSocial.telegramGroupId) {
          let totalPnl: number | undefined;
          try {
            const hlState = await getAgentHlState(agentId);
            if (hlState) totalPnl = hlState.totalPnl;
          } catch {
            // use agent.totalPnl if HL fetch fails
          }
          aiResponse = await handleInvestorQuestion(
            agent.vaultSocial.telegramGroupId,
            content.trim(),
            agent,
            contextStr,
            totalPnl
          );
        } else {
          // No Telegram group, just generate and store
          const OpenAI = (await import("openai")).default;
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: `You are ${agent.name}, an AI trading agent on Hyperclaw. You trade ${agent.markets.join(", ")} perpetual futures on Hyperliquid. Risk level: ${agent.riskLevel}. Respond concisely to investor questions.`,
              },
              { role: "user", content: content.trim() },
            ],
            temperature: 0.5,
            max_tokens: 300,
          });

          aiResponse = response.choices[0]?.message?.content || "I need more data to answer that.";

          const aiMsg: VaultChatMessage = {
            id: `ai_${Date.now()}`,
            agentId,
            timestamp: Date.now(),
            sender: "agent",
            senderName: agent.name,
            type: "ai_response",
            content: aiResponse,
          };
          await appendVaultMessage(aiMsg);
        }
      } catch (aiError) {
        console.error("AI response error:", aiError);
      }
    }

    return NextResponse.json({
      success: true,
      message: userMessage,
      aiResponse,
    });
  } catch (error) {
    console.error("Chat post error:", error);
    return NextResponse.json(
      { error: "Failed to post message" },
      { status: 500 }
    );
  }
}
