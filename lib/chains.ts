import { defineChain } from "viem";

function parseChainId(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const EVM_MAINNET_CHAIN_ID = parseChainId(
  process.env.NEXT_PUBLIC_EVM_MAINNET_CHAIN_ID,
  parseChainId(process.env.NEXT_PUBLIC_MONAD_MAINNET_CHAIN_ID, 143)
);
const EVM_TESTNET_CHAIN_ID = parseChainId(
  process.env.NEXT_PUBLIC_EVM_TESTNET_CHAIN_ID,
  parseChainId(process.env.NEXT_PUBLIC_MONAD_TESTNET_CHAIN_ID, 10143)
);
const EVM_MAINNET_CHAIN_NAME =
  process.env.NEXT_PUBLIC_EVM_MAINNET_CHAIN_NAME ||
  process.env.NEXT_PUBLIC_MONAD_MAINNET_CHAIN_NAME ||
  "EVM Mainnet";
const EVM_TESTNET_CHAIN_NAME =
  process.env.NEXT_PUBLIC_EVM_TESTNET_CHAIN_NAME ||
  process.env.NEXT_PUBLIC_MONAD_TESTNET_CHAIN_NAME ||
  "EVM Testnet";
const EVM_NATIVE_NAME = process.env.NEXT_PUBLIC_EVM_NATIVE_NAME || "Native";
export const evmNativeSymbol = process.env.NEXT_PUBLIC_EVM_NATIVE_SYMBOL || "ETH";
const EVM_MAINNET_RPC_URL =
  process.env.NEXT_PUBLIC_EVM_MAINNET_RPC_URL ||
  process.env.NEXT_PUBLIC_MONAD_MAINNET_RPC_URL ||
  "https://rpc.monad.xyz";
const EVM_TESTNET_RPC_URL =
  process.env.NEXT_PUBLIC_EVM_TESTNET_RPC_URL ||
  process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL ||
  "https://testnet-rpc.monad.xyz";
const EVM_MAINNET_EXPLORER_URL =
  process.env.NEXT_PUBLIC_EVM_MAINNET_EXPLORER_URL || "https://monadvision.com";
const EVM_TESTNET_EXPLORER_URL =
  process.env.NEXT_PUBLIC_EVM_TESTNET_EXPLORER_URL || "https://testnet.monadexplorer.com";

export const evmMainnet = defineChain({
  id: EVM_MAINNET_CHAIN_ID,
  name: EVM_MAINNET_CHAIN_NAME,
  nativeCurrency: { name: EVM_NATIVE_NAME, symbol: evmNativeSymbol, decimals: 18 },
  rpcUrls: {
    default: { http: [EVM_MAINNET_RPC_URL] },
  },
  blockExplorers: {
    default: { name: `${EVM_MAINNET_CHAIN_NAME} Explorer`, url: EVM_MAINNET_EXPLORER_URL },
  },
});

export const evmTestnet = defineChain({
  id: EVM_TESTNET_CHAIN_ID,
  name: EVM_TESTNET_CHAIN_NAME,
  nativeCurrency: { name: EVM_NATIVE_NAME, symbol: evmNativeSymbol, decimals: 18 },
  rpcUrls: {
    default: { http: [EVM_TESTNET_RPC_URL] },
  },
  blockExplorers: {
    default: {
      name: `${EVM_TESTNET_CHAIN_NAME} Explorer`,
      url: EVM_TESTNET_EXPLORER_URL,
    },
  },
  testnet: true,
});

// Backward-compatible aliases
export const monadMainnet = evmMainnet;
export const monadTestnet = evmTestnet;
