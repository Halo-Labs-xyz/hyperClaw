/**
 * Environment variable validation.
 *
 * Validates that vault address is set and not a placeholder.
 * Used by UI components to determine vault availability.
 */

const PLACEHOLDER_VALUES = [
  "your_deployed_vault_contract_address",
  "your_hclaw_token_address_after_deployment",
  "your_privy_app_id_here",
  "your_operator_private_key_hex",
  "your_agent_private_key_hex",
];

/**
 * Returns true if the given value is a real env var (not empty, not a placeholder).
 */
export function isEnvSet(value: string | undefined | null): boolean {
  if (!value) return false;
  return !PLACEHOLDER_VALUES.includes(value.trim());
}

/**
 * Returns the vault address if it's a valid deployed address, null otherwise.
 */
export function getVaultAddressIfDeployed(): string | null {
  const addr = process.env.NEXT_PUBLIC_VAULT_ADDRESS;
  if (!addr || !isEnvSet(addr)) return null;
  if (!addr.startsWith("0x") || addr.length !== 42) return null;
  return addr;
}

/**
 * Returns the $HCLAW token address if set, null otherwise.
 */
export function getHclawAddressIfSet(): string | null {
  const addr = process.env.NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS;
  if (!addr || !isEnvSet(addr)) return null;
  if (!addr.startsWith("0x") || addr.length !== 42) return null;
  return addr;
}
