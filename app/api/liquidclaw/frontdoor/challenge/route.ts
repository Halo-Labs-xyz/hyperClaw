import { NextResponse } from "next/server";
import { frontdoorGatewayFetch } from "@/lib/liquidclaw-frontdoor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChallengeRequestBody = {
  wallet_address?: string;
  privy_user_id?: string | null;
  chain_id?: number | null;
};

function normalizeWalletAddress(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
  return normalized;
}

export async function POST(request: Request) {
  let body: ChallengeRequestBody;
  try {
    body = (await request.json()) as ChallengeRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const walletAddress =
    typeof body.wallet_address === "string"
      ? normalizeWalletAddress(body.wallet_address)
      : null;
  if (!walletAddress) {
    return NextResponse.json(
      { error: "wallet_address must be a 0x-prefixed 40-hex address" },
      { status: 400 }
    );
  }

  const privyUserId =
    typeof body.privy_user_id === "string" && body.privy_user_id.trim().length > 0
      ? body.privy_user_id.trim()
      : null;
  const chainId =
    typeof body.chain_id === "number" && Number.isFinite(body.chain_id)
      ? Math.floor(body.chain_id)
      : null;

  try {
    const payload = await frontdoorGatewayFetch<Record<string, unknown>>(
      "/api/frontdoor/challenge",
      {
        method: "POST",
        body: JSON.stringify({
          wallet_address: walletAddress,
          privy_user_id: privyUserId,
          chain_id: chainId,
        }),
      }
    );
    return NextResponse.json(payload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Frontdoor challenge request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
