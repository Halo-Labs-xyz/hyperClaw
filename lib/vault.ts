import { type Address } from "viem";
import { getVaultAddressIfDeployed } from "@/lib/env";

// ============================================
// HyperclawVault ABI
// ============================================

export const VAULT_ABI = [
  {
    inputs: [{ name: "agentId", type: "bytes32" }],
    name: "totalShares",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "agentId", type: "bytes32" },
      { name: "user", type: "address" },
    ],
    name: "userShares",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "agentId", type: "bytes32" },
      { name: "user", type: "address" },
    ],
    name: "userDepositsUSD",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agentId", type: "bytes32" }],
    name: "totalDepositsUSD",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agentId", type: "bytes32" }],
    name: "getVaultTVL",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getMaxDepositUSD",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "token", type: "address" }],
    name: "tokenPrices",
    outputs: [
      { name: "usdPriceE18", type: "uint256" },
      { name: "updatedAt", type: "uint64" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "maxPriceAge",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getMaxDepositUSDForUser",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "token", type: "address" }],
    name: "whitelistedTokens",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "agentId", type: "bytes32" }],
    name: "depositMON",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { name: "agentId", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "depositERC20",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "agentId", type: "bytes32" },
      { name: "shares", type: "uint256" },
    ],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "agentId", type: "bytes32" },
      { indexed: true, name: "user", type: "address" },
      { indexed: false, name: "token", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "shares", type: "uint256" },
    ],
    name: "Deposited",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "agentId", type: "bytes32" },
      { indexed: true, name: "user", type: "address" },
      { indexed: false, name: "shares", type: "uint256" },
      { indexed: false, name: "monAmount", type: "uint256" },
    ],
    name: "Withdrawn",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: "newMaxDeposit", type: "uint256" },
      { indexed: false, name: "hclawMarketCap", type: "uint256" },
    ],
    name: "CapTierUnlocked",
    type: "event",
  },
] as const;

// ============================================
// HCLAW lock/policy/rewards ABIs
// ============================================

export const HCLAW_LOCK_ABI = [
  {
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "durationDays", type: "uint16" },
    ],
    name: "lock",
    outputs: [{ name: "lockId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "lockId", type: "uint256" },
      { name: "newDurationDays", type: "uint16" },
    ],
    name: "extendLock",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "lockId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    name: "increaseLock",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "lockId", type: "uint256" }],
    name: "unlock",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserPower",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserTier",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserLockIds",
    outputs: [{ name: "", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "lockId", type: "uint256" }],
    name: "locks",
    outputs: [
      { name: "lockId", type: "uint256" },
      { name: "owner", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "startTs", type: "uint64" },
      { name: "endTs", type: "uint64" },
      { name: "durationDays", type: "uint16" },
      { name: "multiplierBps", type: "uint16" },
      { name: "unlocked", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const HCLAW_POLICY_ABI = [
  {
    inputs: [],
    name: "getBaseCapUsd",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserCapUsd",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserRebateBps",
    outputs: [{ name: "", type: "uint16" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserBoostBps",
    outputs: [{ name: "", type: "uint16" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserTier",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserPower",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const HCLAW_REWARDS_ABI = [
  {
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "user", type: "address" },
    ],
    name: "getClaimable",
    outputs: [
      { name: "rebateClaimable", type: "uint256" },
      { name: "incentiveClaimable", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "epochId", type: "uint256" }],
    name: "claim",
    outputs: [
      { name: "rebatePaid", type: "uint256" },
      { name: "incentivePaid", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export const AGENTIC_LP_VAULT_ABI = [
  {
    inputs: [],
    name: "getStatus",
    outputs: [
      { name: "isPaused", type: "bool" },
      { name: "isKilled", type: "bool" },
      { name: "inventorySkewBps", type: "uint16" },
      { name: "dailyTurnoverBps", type: "uint16" },
      { name: "drawdownBps", type: "uint16" },
      { name: "totalRealizedPnlUsd", type: "int256" },
      { name: "lastExecTs", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "maxInventorySkewBps",
    outputs: [{ name: "", type: "uint16" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "maxDailyTurnoverBps",
    outputs: [{ name: "", type: "uint16" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "maxDrawdownBps",
    outputs: [{ name: "", type: "uint16" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const HCLAW_TREASURY_ROUTER_ABI = [
  {
    inputs: [],
    name: "buybackSplitBps",
    outputs: [{ name: "", type: "uint16" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "incentiveSplitBps",
    outputs: [{ name: "", type: "uint16" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "reserveSplitBps",
    outputs: [{ name: "", type: "uint16" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ============================================
// ERC20 minimal ABI
// ============================================

export const ERC20_ABI = [
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ============================================
// Helpers
// ============================================

export function getVaultAddress(): Address {
  const addr = getVaultAddressIfDeployed();
  if (!addr) throw new Error("NEXT_PUBLIC_VAULT_ADDRESS not set");
  return addr as Address;
}

export function agentIdToBytes32(agentId: string): `0x${string}` {
  const hex = agentId.replace(/^0x/, "");
  return `0x${hex.padStart(64, "0")}` as `0x${string}`;
}
