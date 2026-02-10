/**
 * MCP HTTP endpoint for IronClaw.
 *
 * POST with JSON-RPC body: initialize, tools/list, tools/call.
 * Auth: HYPERCLAW_API_KEY or MCP_API_KEY in Authorization: Bearer <key> or x-api-key header.
 */

import { NextResponse } from "next/server";
import { handleMcpRequest, type McpRequest } from "@/lib/mcp-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isAuthorized(request: Request): boolean {
  const apiKey = process.env.HYPERCLAW_API_KEY || process.env.MCP_API_KEY;
  if (!apiKey?.trim()) return true; // No key configured = open (e.g. local dev)

  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const xKey = request.headers.get("x-api-key")?.trim() ?? null;
  const key = bearer ?? xKey;
  return key === apiKey;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: 0, error: { code: -32001, message: "Unauthorized" } },
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  let body: McpRequest;
  try {
    body = (await request.json()) as McpRequest;
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: 0, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (body.jsonrpc !== "2.0" || body.method === undefined) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: body.id ?? 0, error: { code: -32600, message: "Invalid Request" } },
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const response = await handleMcpRequest(body);
    return NextResponse.json(response, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: body.id ?? 0,
        error: { code: -32603, message: `Internal error: ${message}` },
      },
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
