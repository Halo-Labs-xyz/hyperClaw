import { type Address } from "viem";

// ============================================
// HyperclawVault ABI (for frontend wagmi hooks)
// ============================================

export const VAULT_ABI = [
  // Read functions
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
    inputs: [{ name: "agentId", type: "bytes32" }],
    name: "totalDepositsUSD",
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
    name: "whitelistedTokens",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  // Write functions
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
  // Events
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
// ERC20 minimal ABI (for approve + balanceOf)
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
  const addr = process.env.NEXT_PUBLIC_VAULT_ADDRESS;
  if (!addr) throw new Error("NEXT_PUBLIC_VAULT_ADDRESS not set");
  return addr as Address;
}

export function agentIdToBytes32(agentId: string): `0x${string}` {
  // Pad the agentId hex string to 32 bytes
  const hex = agentId.replace(/^0x/, "");
  return `0x${hex.padStart(64, "0")}` as `0x${string}`;
}
