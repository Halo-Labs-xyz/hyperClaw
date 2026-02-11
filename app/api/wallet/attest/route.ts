import { NextResponse } from "next/server";
import {
  getWalletAttestationStatus,
  prepareWalletAttestation,
  verifyWalletAttestation,
} from "@/lib/wallet-attestation";

type AttestationRequestBody = {
  action?: "status" | "prepare" | "verify";
  privyUserId?: string;
  walletAddress?: string;
  challengeId?: string;
  signature?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AttestationRequestBody;
    const action = body.action ?? "status";

    if (!body.privyUserId || !body.walletAddress) {
      return NextResponse.json(
        { error: "privyUserId and walletAddress are required" },
        { status: 400 }
      );
    }

    if (action === "status") {
      const status = await getWalletAttestationStatus({
        privyUserId: body.privyUserId,
        walletAddress: body.walletAddress,
      });
      return NextResponse.json(status);
    }

    if (action === "prepare") {
      const prepared = await prepareWalletAttestation({
        privyUserId: body.privyUserId,
        walletAddress: body.walletAddress,
      });
      if (prepared.attested) {
        return NextResponse.json({
          attested: true,
          attestation: prepared.attestation,
        });
      }
      return NextResponse.json({
        attested: false,
        challengeId: prepared.challenge.id,
        message: prepared.challenge.message,
        expiresAt: prepared.challenge.expiresAt,
      });
    }

    if (action === "verify") {
      if (!body.challengeId || !body.signature) {
        return NextResponse.json(
          { error: "challengeId and signature are required for verify action" },
          { status: 400 }
        );
      }

      const verified = await verifyWalletAttestation({
        challengeId: body.challengeId,
        privyUserId: body.privyUserId,
        walletAddress: body.walletAddress,
        signature: body.signature,
      });

      if (!verified.success) {
        return NextResponse.json(
          { success: false, error: verified.error ?? "verification failed" },
          { status: 400 }
        );
      }

      return NextResponse.json({
        success: true,
        attestation: verified.attestation,
      });
    }

    return NextResponse.json(
      { error: "Unknown action. Use: status, prepare, verify" },
      { status: 400 }
    );
  } catch (error) {
    console.error("Wallet attestation error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Wallet attestation failed" },
      { status: 500 }
    );
  }
}
