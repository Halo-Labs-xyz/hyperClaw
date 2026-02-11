"use client";

import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NetworkProvider } from "./NetworkContext";
import { monadMainnet, monadTestnet } from "@/lib/chains";

const queryClient = new QueryClient();

type LoadedModules = {
  PrivyProvider: ComponentType<{
    children: ReactNode;
    appId: string;
    clientId?: string;
    config?: Record<string, unknown>;
  }>;
  WagmiProvider: ComponentType<{
    children: ReactNode;
    config: unknown;
  }>;
  createConfig: (args: unknown) => unknown;
  http: (url: string) => unknown;
};

export default function Providers({
  children,
}: {
  children: ReactNode;
}) {
  const [modules, setModules] = useState<LoadedModules | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [privyModule, privyWagmiModule, wagmiModule] = await Promise.all([
        import("@privy-io/react-auth"),
        import("@privy-io/wagmi"),
        import("wagmi"),
      ]);

      const PrivyProvider =
        (privyModule as { PrivyProvider?: LoadedModules["PrivyProvider"]; default?: { PrivyProvider?: LoadedModules["PrivyProvider"] } }).PrivyProvider ??
        (privyModule as { default?: { PrivyProvider?: LoadedModules["PrivyProvider"] } }).default?.PrivyProvider;
      const WagmiProvider =
        (privyWagmiModule as { WagmiProvider?: LoadedModules["WagmiProvider"]; default?: { WagmiProvider?: LoadedModules["WagmiProvider"] } }).WagmiProvider ??
        (privyWagmiModule as { default?: { WagmiProvider?: LoadedModules["WagmiProvider"] } }).default?.WagmiProvider;
      const createConfig =
        (privyWagmiModule as { createConfig?: LoadedModules["createConfig"]; default?: { createConfig?: LoadedModules["createConfig"] } }).createConfig ??
        (privyWagmiModule as { default?: { createConfig?: LoadedModules["createConfig"] } }).default?.createConfig;
      const http =
        (wagmiModule as { http?: LoadedModules["http"]; default?: { http?: LoadedModules["http"] } }).http ??
        (wagmiModule as { default?: { http?: LoadedModules["http"] } }).default?.http;

      if (!PrivyProvider || !WagmiProvider || !createConfig || !http) {
        throw new Error("Failed to load wallet provider modules");
      }

      if (!active) return;
      setModules({
        PrivyProvider,
        WagmiProvider,
        createConfig,
        http,
      });
    })().catch((error) => {
      console.error("[Providers] Failed to initialize providers:", error);
    });
    return () => {
      active = false;
    };
  }, []);

  const useTestnet = process.env.NEXT_PUBLIC_MONAD_TESTNET === "true";
  const wagmiConfig = useMemo(() => {
    if (!modules) return null;
    return modules.createConfig({
      chains: [monadMainnet, monadTestnet],
      transports: {
        [monadMainnet.id]: modules.http("https://rpc.monad.xyz"),
        [monadTestnet.id]: modules.http("https://testnet-rpc.monad.xyz"),
      },
    });
  }, [modules]);

  if (!modules || !wagmiConfig) return null;

  const PrivyProvider = modules.PrivyProvider;
  const WagmiProvider = modules.WagmiProvider;

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
                // Force EOA mode to avoid noisy smart-wallet initialization errors.
                options: "eoaOnly",
              },
            },
          },
        },
        defaultChain: useTestnet ? monadTestnet : monadMainnet,
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
