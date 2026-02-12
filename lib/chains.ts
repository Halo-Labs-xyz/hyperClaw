import { defineChain } from "viem";

const MONAD_MAINNET_RPC_URL =
  process.env.NEXT_PUBLIC_MONAD_MAINNET_RPC_URL ||
  "https://rpc.monad.xyz";
const MONAD_TESTNET_RPC_URL =
  process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL ||
  "https://testnet-rpc.monad.xyz";

// Monad Mainnet chain definition
export const monadMainnet = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [MONAD_MAINNET_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Monad Explorer", url: "https://explorer.monad.xyz" },
  },
});

// Monad Testnet chain definition
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [MONAD_TESTNET_RPC_URL] },
  },
  blockExplorers: {
    default: {
      name: "Monad Testnet Explorer",
      url: "https://testnet.monadexplorer.com",
    },
  },
  testnet: true,
});
