/**
 * GET /api/phala
 *
 * Check Phala CVM connection and return status for the configured VM.
 * Uses PHALA_API_KEY, PHALA_CVM_ID, PHALA_APP_ID from env.
 */
import { NextResponse } from "next/server";
import {
  checkPhalaConnection,
  getPhalaCvmId,
  getPhalaAppId,
  getCvmDetails,
  getCvmNetwork,
  getCvmState,
} from "@/lib/phala";

export async function GET() {
  if (!process.env.PHALA_API_KEY) {
    return NextResponse.json(
      { error: "PHALA_API_KEY not configured" },
      { status: 503 }
    );
  }

  try {
    const [auth, cvmId, appId] = [
      await checkPhalaConnection(),
      getPhalaCvmId(),
      getPhalaAppId(),
    ];

    if (!auth.ok) {
      return NextResponse.json(
        {
          connected: false,
          error: auth.error,
          configured: { cvmId: !!cvmId, appId: !!appId },
        },
        { status: 503 }
      );
    }

    const payload: Record<string, unknown> = {
      connected: true,
      user: auth.user,
      configured: {
        cvmId: cvmId ?? null,
        appId: appId ?? null,
      },
    };

    if (cvmId) {
      try {
        const [details, network, state] = await Promise.all([
          getCvmDetails(cvmId),
          getCvmNetwork(cvmId),
          getCvmState(cvmId),
        ]);
        payload.cvm = {
          details: details ?? null,
          network: network ?? null,
          state: state?.state ?? null,
        };
      } catch (e) {
        payload.cvmError =
          e instanceof Error ? e.message : String(e);
      }
    }

    return NextResponse.json(payload);
  } catch (error) {
    console.error("Phala API error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Phala connection failed",
      },
      { status: 500 }
    );
  }
}
