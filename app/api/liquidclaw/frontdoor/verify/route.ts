import { NextResponse } from "next/server";
import { frontdoorGatewayFetch } from "@/lib/liquidclaw-frontdoor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VerifyRequestBody = {
  session_id?: string;
  wallet_address?: string;
  privy_user_id?: string | null;
  privy_identity_token?: string | null;
  privy_access_token?: string | null;
  message?: string;
  signature?: string;
  config?: Record<string, unknown>;
};

function normalizeWalletAddress(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
  return normalized;
}

export async function POST(request: Request) {
  let body: VerifyRequestBody;
  try {
    body = (await request.json()) as VerifyRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
  const walletAddress =
    typeof body.wallet_address === "string"
      ? normalizeWalletAddress(body.wallet_address)
      : null;
  const message = typeof body.message === "string" ? body.message : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";

  if (!sessionId) {
    return NextResponse.json({ error: "session_id is required" }, { status: 400 });
  }
  if (!walletAddress) {
    return NextResponse.json(
      { error: "wallet_address must be a 0x-prefixed 40-hex address" },
      { status: 400 }
    );
  }
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  if (!signature || !/^0x[a-fA-F0-9]{130}$/.test(signature)) {
    return NextResponse.json(
      { error: "signature must be a 65-byte hex string (0x-prefixed)" },
      { status: 400 }
    );
  }
  if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) {
    return NextResponse.json({ error: "config object is required" }, { status: 400 });
  }

  const privyUserId =
    typeof body.privy_user_id === "string" && body.privy_user_id.trim().length > 0
      ? body.privy_user_id.trim()
      : null;
  const privyIdentityToken =
    typeof body.privy_identity_token === "string" &&
    body.privy_identity_token.trim().length > 0
      ? body.privy_identity_token.trim()
      : null;
  const privyAccessToken =
    typeof body.privy_access_token === "string" &&
    body.privy_access_token.trim().length > 0
      ? body.privy_access_token.trim()
      : null;

  try {
    const payload = await frontdoorGatewayFetch<Record<string, unknown>>(
      "/api/frontdoor/verify",
      {
        method: "POST",
        body: JSON.stringify({
          session_id: sessionId,
          wallet_address: walletAddress,
          privy_user_id: privyUserId,
          privy_identity_token: privyIdentityToken,
          privy_access_token: privyAccessToken,
          message,
          signature,
          config: body.config,
        }),
      }
    );
    return NextResponse.json(payload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Frontdoor verify request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
