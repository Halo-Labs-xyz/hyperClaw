/**
 * API route to proxy requests to the IronClaw HTTP webhook.
 *
 * POST: send a message to IronClaw and optionally wait for response.
 * GET: health check (proxies to IronClaw /health when configured).
 */

import { NextResponse } from "next/server";
import {
  isIronClawConfigured,
  sendToIronClaw,
  ironClawHealth,
} from "@/lib/ironclaw";

export async function POST(request: Request) {
  if (!isIronClawConfigured()) {
    return NextResponse.json(
      { error: "IronClaw webhook not configured (set IRONCLAW_WEBHOOK_URL)" },
      { status: 503 }
    );
  }

  let body: { content?: string; thread_id?: string; wait_for_response?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return NextResponse.json(
      { error: "content is required" },
      { status: 400 }
    );
  }

  try {
    const result = await sendToIronClaw({
      content,
      thread_id: typeof body.thread_id === "string" ? body.thread_id : undefined,
      wait_for_response: body.wait_for_response ?? true,
    });
    if (!result) {
      return NextResponse.json(
        { error: "IronClaw webhook not available" },
        { status: 503 }
      );
    }
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "IronClaw request failed";
    return NextResponse.json(
      { error: message },
      { status: 502 }
    );
  }
}

export async function GET() {
  const health = await ironClawHealth();
  if (!health.ok) {
    return NextResponse.json(
      {
        configured: !!process.env.IRONCLAW_WEBHOOK_URL?.trim(),
        ironclaw: health.status ?? "unreachable",
      },
      { status: 503 }
    );
  }
  return NextResponse.json({
    configured: true,
    ironclaw: health.status ?? "healthy",
  });
}
