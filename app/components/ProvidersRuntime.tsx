"use client";

import { useMemo, type ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http } from "wagmi";
import { NetworkProvider } from "./NetworkContext";
import { evmMainnet, evmTestnet } from "@/lib/chains";

const queryClient = new QueryClient();

export default function ProvidersRuntime({
  children,
}: {
  children: ReactNode;
}) {
  const wagmiConfig = useMemo(
    () =>
      createConfig({
        chains: [evmMainnet, evmTestnet],
        transports: {
          [evmMainnet.id]: http(evmMainnet.rpcUrls.default.http[0]),
          [evmTestnet.id]: http(evmTestnet.rpcUrls.default.http[0]),
        },
      }),
    []
  );

  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID || ""}
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
        externalWallets: {
          coinbaseWallet: {
            config: {
              preference: {
                // Some custom EVM chains are not supported by Coinbase Smart Wallet.
                options: "eoaOnly",
              },
            },
          },
        },
        defaultChain: evmMainnet,
        supportedChains: [evmMainnet, evmTestnet],
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          <NetworkProvider>{children}</NetworkProvider>
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
