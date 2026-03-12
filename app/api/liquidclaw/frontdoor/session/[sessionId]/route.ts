import { NextResponse } from "next/server";
import {
  frontdoorGatewayFetch,
  sanitizeFrontdoorLaunchUrl,
} from "@/lib/liquidclaw-frontdoor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = {
  params: {
    sessionId: string;
  };
};

type SessionResponse = {
  instance_url?: string | null;
  verify_url?: string | null;
  status?: string;
  detail?: string;
  [key: string]: unknown;
};

export async function GET(_request: Request, context: RouteParams) {
  const sessionId = context.params.sessionId?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    const payload = await frontdoorGatewayFetch<SessionResponse>(
      `/api/frontdoor/session/${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
      }
    );

    const instanceUrl = sanitizeFrontdoorLaunchUrl(payload.instance_url);
    const verifyUrl = sanitizeFrontdoorLaunchUrl(payload.verify_url);
    const launchUrl = instanceUrl ?? verifyUrl ?? null;
    const launchBlocked =
      Boolean(payload.instance_url || payload.verify_url) && launchUrl === null;

    return NextResponse.json({
      ...payload,
      instance_url: instanceUrl,
      verify_url: verifyUrl,
      launch_url: launchUrl,
      launch_blocked: launchBlocked,
      launch_blocked_reason: launchBlocked
        ? "Destination URL host is not in LIQUIDCLAW_FRONTDOOR_REDIRECT_ALLOWLIST"
        : null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Frontdoor session request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
