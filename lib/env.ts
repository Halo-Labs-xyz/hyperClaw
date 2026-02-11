/**
 * Environment variable validation helpers.
 */

const PLACEHOLDER_VALUES = [
  "your_deployed_vault_contract_address",
  "your_hclaw_token_address_after_deployment",
  "your_privy_app_id_here",
  "your_operator_private_key_hex",
  "your_agent_private_key_hex",
];

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

export function getAddressIfSet(name: string): `0x${string}` | null {
  const value = process.env[name];
  if (!isEnvSet(value)) return null;
  if (!isHexAddress(value)) return null;
  return value as `0x${string}`;
}

export function getVaultAddressIfDeployed(): `0x${string}` | null {
  return getAddressIfSet("NEXT_PUBLIC_VAULT_ADDRESS");
}

export function getHclawAddressIfSet(): `0x${string}` | null {
  return getAddressIfSet("NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS");
}

export function getHclawLockAddressIfSet(): `0x${string}` | null {
  return getAddressIfSet("NEXT_PUBLIC_HCLAW_LOCK_ADDRESS");
}

export function getHclawPolicyAddressIfSet(): `0x${string}` | null {
  return getAddressIfSet("NEXT_PUBLIC_HCLAW_POLICY_ADDRESS");
}

export function getHclawRewardsAddressIfSet(): `0x${string}` | null {
  return getAddressIfSet("NEXT_PUBLIC_HCLAW_REWARDS_ADDRESS");
}

export function getAgenticLpVaultAddressIfSet(): `0x${string}` | null {
  return getAddressIfSet("NEXT_PUBLIC_AGENTIC_LP_VAULT_ADDRESS");
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
