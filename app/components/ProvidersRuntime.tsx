"use client";

import { useMemo, type ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http } from "wagmi";
import { NetworkProvider } from "./NetworkContext";
import { monadMainnet, monadTestnet } from "@/lib/chains";

const queryClient = new QueryClient();

export default function ProvidersRuntime({
  children,
}: {
  children: ReactNode;
}) {
  const wagmiConfig = useMemo(
    () =>
      createConfig({
        chains: [monadMainnet, monadTestnet],
        transports: {
          [monadMainnet.id]: http(monadMainnet.rpcUrls.default.http[0]),
          [monadTestnet.id]: http(monadTestnet.rpcUrls.default.http[0]),
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
                // Monad chains are not supported by Coinbase Smart Wallet.
                options: "eoaOnly",
              },
            },
          },
        },
        defaultChain: monadMainnet,
        supportedChains: [monadMainnet, monadTestnet],
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
