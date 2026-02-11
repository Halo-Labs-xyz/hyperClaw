import { randomBytes } from "crypto";
import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { readJSON, writeJSON } from "@/lib/store-backend";

const CHALLENGES_FILE = "wallet_attestation_challenges.json";
const ATTESTATIONS_FILE = "wallet_attestations.json";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const ATTESTATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CHALLENGES = 500;
const MAX_ATTESTATIONS = 1000;

export interface WalletAttestationChallenge {
  id: string;
  privyUserId: string;
  walletAddress: Address;
  nonce: string;
  message: string;
  issuedAt: number;
  expiresAt: number;
  used: boolean;
  usedAt?: number;
}

export interface WalletAttestation {
  id: string;
  privyUserId: string;
  walletAddress: Address;
  message: string;
  signature: Hex;
  createdAt: number;
  verifiedAt: number;
  expiresAt: number;
}

function normalizePrivyUserId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("privyUserId is required");
  }
  return normalized;
}

function normalizeWalletAddress(value: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw new Error("walletAddress is invalid");
  }
}

function nowMs(): number {
  return Date.now();
}

function buildAttestationMessage(params: {
  privyUserId: string;
  walletAddress: Address;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}): string {
  return [
    "HyperClaw Wallet Authorization",
    "",
    "Sign this gasless message to authorize your wallet for HyperClaw.",
    "This links your wallet with your Privy identity for secure app features and Telegram linking.",
    "",
    `Privy User ID: ${params.privyUserId}`,
    `Wallet Address: ${params.walletAddress}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${new Date(params.issuedAt).toISOString()}`,
    `Expires At: ${new Date(params.expiresAt).toISOString()}`,
  ].join("\n");
}

function pruneChallenges(challenges: WalletAttestationChallenge[]): WalletAttestationChallenge[] {
  const now = nowMs();
  const kept = challenges.filter((challenge) => {
    if (!challenge.used && challenge.expiresAt >= now) return true;
    if (challenge.used && typeof challenge.usedAt === "number") {
      return challenge.usedAt >= now - 24 * 60 * 60 * 1000;
    }
    return false;
  });
  return kept.slice(-MAX_CHALLENGES);
}

function pruneAttestations(attestations: WalletAttestation[]): WalletAttestation[] {
  const now = nowMs();
  return attestations.filter((attestation) => attestation.expiresAt >= now).slice(-MAX_ATTESTATIONS);
}

function keyFor(privyUserId: string, walletAddress: Address): string {
  return `${privyUserId.toLowerCase()}::${walletAddress.toLowerCase()}`;
}

async function readChallenges(): Promise<WalletAttestationChallenge[]> {
  return readJSON<WalletAttestationChallenge[]>(CHALLENGES_FILE, []);
}

async function writeChallenges(challenges: WalletAttestationChallenge[]): Promise<void> {
  await writeJSON(CHALLENGES_FILE, pruneChallenges(challenges));
}

async function readAttestations(): Promise<WalletAttestation[]> {
  return readJSON<WalletAttestation[]>(ATTESTATIONS_FILE, []);
}

async function writeAttestations(attestations: WalletAttestation[]): Promise<void> {
  await writeJSON(ATTESTATIONS_FILE, pruneAttestations(attestations));
}

export async function getWalletAttestationStatus(params: {
  privyUserId: string;
  walletAddress: string;
}): Promise<{
  attested: boolean;
  attestation?: WalletAttestation;
}> {
  const privyUserId = normalizePrivyUserId(params.privyUserId);
  const walletAddress = normalizeWalletAddress(params.walletAddress);
  const attestations = await readAttestations();
  const targetKey = keyFor(privyUserId, walletAddress);
  const now = nowMs();
  const attestation = attestations.find(
    (item) =>
      keyFor(item.privyUserId, item.walletAddress) === targetKey &&
      item.expiresAt >= now
  );
  if (!attestation) {
    return { attested: false };
  }
  return { attested: true, attestation };
}

export async function prepareWalletAttestation(params: {
  privyUserId: string;
  walletAddress: string;
}): Promise<
  | { attested: true; attestation: WalletAttestation }
  | { attested: false; challenge: WalletAttestationChallenge }
> {
  const status = await getWalletAttestationStatus(params);
  if (status.attested && status.attestation) {
    return { attested: true, attestation: status.attestation };
  }

  const privyUserId = normalizePrivyUserId(params.privyUserId);
  const walletAddress = normalizeWalletAddress(params.walletAddress);
  const issuedAt = nowMs();
  const expiresAt = issuedAt + CHALLENGE_TTL_MS;
  const nonce = randomBytes(16).toString("hex");
  const challenge: WalletAttestationChallenge = {
    id: randomBytes(12).toString("hex"),
    privyUserId,
    walletAddress,
    nonce,
    message: buildAttestationMessage({
      privyUserId,
      walletAddress,
      nonce,
      issuedAt,
      expiresAt,
    }),
    issuedAt,
    expiresAt,
    used: false,
  };

  const challenges = await readChallenges();
  challenges.push(challenge);
  await writeChallenges(challenges);

  return { attested: false, challenge };
}

export async function verifyWalletAttestation(params: {
  challengeId: string;
  privyUserId: string;
  walletAddress: string;
  signature: string;
}): Promise<{
  success: boolean;
  error?: string;
  attestation?: WalletAttestation;
}> {
  const challengeId = params.challengeId.trim();
  if (!challengeId) {
    return { success: false, error: "challengeId is required" };
  }

  const privyUserId = normalizePrivyUserId(params.privyUserId);
  const walletAddress = normalizeWalletAddress(params.walletAddress);
  const signature = params.signature.trim();
  if (!/^0x[a-fA-F0-9]+$/.test(signature)) {
    return { success: false, error: "signature is invalid" };
  }

  const challenges = await readChallenges();
  const index = challenges.findIndex((challenge) => challenge.id === challengeId);
  if (index === -1) {
    return { success: false, error: "challenge not found" };
  }

  const challenge = challenges[index];
  const now = nowMs();
  if (challenge.used) {
    return { success: false, error: "challenge already used" };
  }
  if (challenge.expiresAt < now) {
    return { success: false, error: "challenge expired" };
  }
  if (challenge.privyUserId !== privyUserId) {
    return { success: false, error: "privyUserId mismatch" };
  }
  if (challenge.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    return { success: false, error: "walletAddress mismatch" };
  }

  let recoveredAddress: Address;
  try {
    recoveredAddress = await recoverMessageAddress({
      message: challenge.message,
      signature: signature as Hex,
    });
  } catch {
    return { success: false, error: "signature recovery failed" };
  }

  if (recoveredAddress.toLowerCase() !== challenge.walletAddress.toLowerCase()) {
    return { success: false, error: "signature does not match wallet" };
  }

  challenges[index] = {
    ...challenge,
    used: true,
    usedAt: now,
  };
  await writeChallenges(challenges);

  const attestation: WalletAttestation = {
    id: randomBytes(12).toString("hex"),
    privyUserId: challenge.privyUserId,
    walletAddress: challenge.walletAddress,
    message: challenge.message,
    signature: signature as Hex,
    createdAt: challenge.issuedAt,
    verifiedAt: now,
    expiresAt: now + ATTESTATION_TTL_MS,
  };

  const attestations = await readAttestations();
  const targetKey = keyFor(attestation.privyUserId, attestation.walletAddress);
  const nextAttestations = attestations.filter(
    (item) => keyFor(item.privyUserId, item.walletAddress) !== targetKey
  );
  nextAttestations.push(attestation);
  await writeAttestations(nextAttestations);

  return { success: true, attestation };
}
