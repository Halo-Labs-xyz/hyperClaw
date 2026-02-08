/**
 * API Route Authentication
 *
 * Provides server-side auth helpers for API routes.
 * - Orchestrator routes: shared secret via X-Orchestrator-Key header
 * - User routes: Privy JWT verification via Authorization header
 * - Internal routes: no auth (market data, token info)
 *
 * For hackathon: uses a simple API key approach. In production, integrate
 * Privy server-side verification (verifyAuthToken from @privy-io/server-auth).
 */

import { NextResponse } from "next/server";

/**
 * Verify orchestrator requests (EC2 -> Vercel).
 * Returns true if auth passes or no secret is configured (dev mode).
 */
export function verifyOrchestratorAuth(request: Request): boolean {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) return true; // Dev mode: no auth
  const key = request.headers.get("x-orchestrator-key");
  return key === secret;
}

/**
 * Verify API key for sensitive routes (trade, accounts, fund).
 * Uses HYPERCLAW_API_KEY env var. If not set, allows all (dev mode).
 */
export function verifyApiKey(request: Request): boolean {
  const apiKey = process.env.HYPERCLAW_API_KEY;
  if (!apiKey) return true; // Dev mode: no auth
  const headerKey = request.headers.get("x-api-key") ||
    request.headers.get("authorization")?.replace("Bearer ", "");
  return headerKey === apiKey;
}

/**
 * Returns 401 response for unauthorized requests.
 */
export function unauthorizedResponse() {
  return NextResponse.json(
    { error: "Unauthorized. Provide a valid API key." },
    { status: 401 }
  );
}
