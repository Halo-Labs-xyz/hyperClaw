"use client";

import { PrivyProvider as BasePrivyProvider } from "@privy-io/react-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createConfig } from "@privy-io/wagmi";
import { http } from "wagmi";
import { WagmiProvider } from "@privy-io/wagmi";
import { defineChain } from "viem";
import { NetworkProvider } from "./NetworkContext";

// Monad Mainnet chain definition
export const monadMainnet = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.monad.xyz"] },
  },
  blockExplorers: {
    default: { name: "Monad Explorer", url: "https://explorer.monad.xyz" },
  },
});

// Monad Testnet chain definition (fallback)
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet-rpc.monad.xyz"] },
  },
  blockExplorers: {
    default: {
      name: "Monad Testnet Explorer",
      url: "https://testnet.monadexplorer.com",
    },
  },
  testnet: true,
});

export const config = createConfig({
  chains: [monadMainnet, monadTestnet],
  transports: {
    [monadMainnet.id]: http("https://rpc.monad.xyz"),
    [monadTestnet.id]: http("https://testnet-rpc.monad.xyz"),
  },
});

const queryClient = new QueryClient();

// Use testnet when NEXT_PUBLIC_MONAD_TESTNET is set
const useTestnet = process.env.NEXT_PUBLIC_MONAD_TESTNET === "true";

export default function Providers({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <BasePrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      clientId={process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID || ""}
      config={{
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets",
          },
          priceDisplay: {
            primary: "native-token",
            secondary: null,
          },
        },
        defaultChain: useTestnet ? monadTestnet : monadMainnet,
        supportedChains: [monadMainnet, monadTestnet],
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={config}>
          <NetworkProvider>{children}</NetworkProvider>
        </WagmiProvider>
      </QueryClientProvider>
    </BasePrivyProvider>
  );
}
