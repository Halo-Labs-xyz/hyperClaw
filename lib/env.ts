/**
 * Environment variable validation helpers.
 */
import { getAddress } from "viem";

export type MonadNetwork = "mainnet" | "testnet";

const PLACEHOLDER_VALUES = [
  "your_deployed_vault_contract_address",
  "your_hclaw_token_address_after_deployment",
  "your_privy_app_id_here",
  "your_operator_private_key_hex",
  "your_agent_private_key_hex",
];

// Optional production override for mainnet vault address.
// IMPORTANT: Do not default this to a hardcoded address. If this value is wrong,
// users will be instructed to deposit into the wrong vault.
const MAINNET_VAULT_HOTFIX_ADDRESS = normalizeHexAddress(
  process.env.NEXT_PUBLIC_MAINNET_VAULT_HOTFIX_ADDRESS
);

export function isEnvSet(value: string | undefined | null): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !PLACEHOLDER_VALUES.includes(trimmed);
}

export function isHexAddress(value: string | undefined | null): value is `0x${string}` {
  if (!value) return false;
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

export function normalizeHexAddress(value: string | undefined | null): `0x${string}` | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  try {
    // Accept non-checksummed input and return canonical checksum address.
    return getAddress(trimmed.toLowerCase()) as `0x${string}`;
  } catch {
    return null;
  }
}

export function getAddressIfSet(name: string): `0x${string}` | null {
  const value = process.env[name];
  if (!isEnvSet(value)) return null;
  return normalizeHexAddress(value);
}

function getAddressFromCandidates(candidates: string[]): `0x${string}` | null {
  for (const candidate of candidates) {
    const address = getAddressIfSet(candidate);
    if (address) return address;
  }
  return null;
}

function getNetworkScopedAddress(
  network: MonadNetwork | undefined,
  options: { fallback: string; mainnet: string[]; testnet: string[] }
): `0x${string}` | null {
  if (network === "mainnet") {
    return getAddressFromCandidates([...options.mainnet, options.fallback]);
  }
  if (network === "testnet") {
    return getAddressFromCandidates([...options.testnet, options.fallback]);
  }
  return getAddressFromCandidates([options.fallback]);
}

export function getVaultAddressIfDeployed(network?: MonadNetwork): `0x${string}` | null {
  const defaultMainnet = process.env.NEXT_PUBLIC_MONAD_TESTNET === "false";
  if (
    MAINNET_VAULT_HOTFIX_ADDRESS &&
    (network === "mainnet" || (network === undefined && defaultMainnet))
  ) {
    return MAINNET_VAULT_HOTFIX_ADDRESS;
  }

  return getNetworkScopedAddress(network, {
    fallback: "NEXT_PUBLIC_VAULT_ADDRESS",
    mainnet: [
      "MONAD_MAINNET_VAULT_ADDRESS",
      "NEXT_PUBLIC_MONAD_MAINNET_VAULT_ADDRESS",
      "NEXT_PUBLIC_VAULT_ADDRESS_MAINNET",
    ],
    testnet: [
      "MONAD_TESTNET_VAULT_ADDRESS",
      "NEXT_PUBLIC_MONAD_TESTNET_VAULT_ADDRESS",
      "NEXT_PUBLIC_VAULT_ADDRESS_TESTNET",
    ],
  });
}

export function getHclawAddressIfSet(network?: MonadNetwork): `0x${string}` | null {
  return getNetworkScopedAddress(network, {
    fallback: "NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS",
    mainnet: [
      "NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS_MAINNET",
      "NEXT_PUBLIC_MONAD_MAINNET_HCLAW_TOKEN_ADDRESS",
      "MONAD_MAINNET_HCLAW_TOKEN_ADDRESS",
    ],
    testnet: [
      "NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS_TESTNET",
      "NEXT_PUBLIC_MONAD_TESTNET_HCLAW_TOKEN_ADDRESS",
      "MONAD_TESTNET_HCLAW_TOKEN_ADDRESS",
    ],
  });
}

export function getHclawLockAddressIfSet(network?: MonadNetwork): `0x${string}` | null {
  return getNetworkScopedAddress(network, {
    fallback: "NEXT_PUBLIC_HCLAW_LOCK_ADDRESS",
    mainnet: [
      "NEXT_PUBLIC_HCLAW_LOCK_ADDRESS_MAINNET",
      "NEXT_PUBLIC_MONAD_MAINNET_HCLAW_LOCK_ADDRESS",
      "MONAD_MAINNET_HCLAW_LOCK_ADDRESS",
    ],
    testnet: [
      "NEXT_PUBLIC_HCLAW_LOCK_ADDRESS_TESTNET",
      "NEXT_PUBLIC_MONAD_TESTNET_HCLAW_LOCK_ADDRESS",
      "MONAD_TESTNET_HCLAW_LOCK_ADDRESS",
    ],
  });
}

export function getHclawPolicyAddressIfSet(network?: MonadNetwork): `0x${string}` | null {
  return getNetworkScopedAddress(network, {
    fallback: "NEXT_PUBLIC_HCLAW_POLICY_ADDRESS",
    mainnet: [
      "NEXT_PUBLIC_HCLAW_POLICY_ADDRESS_MAINNET",
      "NEXT_PUBLIC_MONAD_MAINNET_HCLAW_POLICY_ADDRESS",
      "MONAD_MAINNET_HCLAW_POLICY_ADDRESS",
    ],
    testnet: [
      "NEXT_PUBLIC_HCLAW_POLICY_ADDRESS_TESTNET",
      "NEXT_PUBLIC_MONAD_TESTNET_HCLAW_POLICY_ADDRESS",
      "MONAD_TESTNET_HCLAW_POLICY_ADDRESS",
    ],
  });
}

export function getHclawRewardsAddressIfSet(network?: MonadNetwork): `0x${string}` | null {
  return getNetworkScopedAddress(network, {
    fallback: "NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS",
    mainnet: [
      "NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS_MAINNET",
      "NEXT_PUBLIC_MONAD_MAINNET_HCLAW_REWARDS_ADDRESS",
      "MONAD_MAINNET_HCLAW_REWARDS_ADDRESS",
    ],
    testnet: [
      "NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS_TESTNET",
      "NEXT_PUBLIC_MONAD_TESTNET_HCLAW_REWARDS_ADDRESS",
      "MONAD_TESTNET_HCLAW_REWARDS_ADDRESS",
    ],
  });
}

export function getAgenticLpVaultAddressIfSet(network?: MonadNetwork): `0x${string}` | null {
  return getNetworkScopedAddress(network, {
    fallback: "NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS",
    mainnet: [
      "NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS_MAINNET",
      "NEXT_PUBLIC_MONAD_MAINNET_AGENTIC_LP_VAULT_ADDRESS",
      "MONAD_MAINNET_AGENTIC_LP_VAULT_ADDRESS",
    ],
    testnet: [
      "NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS_TESTNET",
      "NEXT_PUBLIC_MONAD_TESTNET_AGENTIC_LP_VAULT_ADDRESS",
      "MONAD_TESTNET_AGENTIC_LP_VAULT_ADDRESS",
    ],
  });
}

export function getHclawPointsCloseKey(): string | null {
  const key = process.env.HCLAW_POINTS_CLOSE_KEY;
  if (!isEnvSet(key)) return null;
  return key!.trim();
}

function parseBps(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) return fallback;
  return parsed;
}

export function getHclawSplitConfig() {
  return {
    buybackBps: parseBps("HCLAW_BUYBACK_SPLIT_BPS", 4000),
    incentiveBps: parseBps("HCLAW_INCENTIVE_SPLIT_BPS", 4000),
    reserveBps: parseBps("HCLAW_RESERVE_SPLIT_BPS", 2000),
  };
}

export function getHclawEpochDurationDays(): number {
  const raw = process.env.HCLAW_EPOCH_DURATION_DAYS;
  const parsed = raw ? Number.parseInt(raw, 10) : 7;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 30) return 7;
  return parsed;
}
