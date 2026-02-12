"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { monadTestnet, monadMainnet } from "@/lib/chains";

interface NetworkContextValue {
  monadTestnet: boolean;
  hlTestnet: boolean;
  switching: boolean;
  /** Toggle both Monad + HL together */
  toggleNetwork: () => Promise<void>;
  /** Set specific network flags */
  setNetwork: (
    update: {
      monadTestnet?: boolean;
      hlTestnet?: boolean;
    },
    options?: { syncWalletChain?: boolean }
  ) => Promise<void>;
}

const NetworkContext = createContext<NetworkContextValue>({
  monadTestnet: true,
  hlTestnet: true,
  switching: false,
  toggleNetwork: async () => {},
  setNetwork: async () => {},
});

export function useNetwork() {
  return useContext(NetworkContext);
}

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [monadTest, setMonadTest] = useState(true);
  const [hlTest, setHlTest] = useState(true);
  const [switching, setSwitching] = useState(false);
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const persistNetworkState = useCallback(
    (next: { monadTestnet: boolean; hlTestnet: boolean }) => {
      localStorage.setItem(
        "hyperclaw-network",
        JSON.stringify({
          monadTestnet: next.monadTestnet,
          hlTestnet: next.hlTestnet,
        })
      );
    },
    []
  );

  // Load initial state from server, fall back to localStorage if unavailable.
  useEffect(() => {
    let cancelled = false;
    async function loadNetwork() {
      try {
        const res = await fetch("/api/network");
        const data = await res.json();
        if (cancelled) return;
        setMonadTest(data.monadTestnet ?? true);
        setHlTest(data.hlTestnet ?? true);
        localStorage.setItem(
          "hyperclaw-network",
          JSON.stringify({
            monadTestnet: data.monadTestnet ?? true,
            hlTestnet: data.hlTestnet ?? true,
          })
        );
      } catch {
        const stored = localStorage.getItem("hyperclaw-network");
        if (!stored || cancelled) return;
        try {
          const parsed = JSON.parse(stored);
          if (typeof parsed.monadTestnet === "boolean") setMonadTest(parsed.monadTestnet);
          if (typeof parsed.hlTestnet === "boolean") setHlTest(parsed.hlTestnet);
        } catch {
          // ignore malformed local data
        }
      }
    }
    void loadNetwork();
    return () => {
      cancelled = true;
    };
  }, []);

  const setNetwork = useCallback(
    async (
      update: { monadTestnet?: boolean; hlTestnet?: boolean },
      options?: { syncWalletChain?: boolean }
    ) => {
      const syncWalletChain = options?.syncWalletChain ?? true;
      const previous = {
        monadTestnet: monadTest,
        hlTestnet: hlTest,
      };
      const optimistic = {
        monadTestnet: update.monadTestnet ?? monadTest,
        hlTestnet: update.hlTestnet ?? hlTest,
      };

      setSwitching(true);
      setMonadTest(optimistic.monadTestnet);
      setHlTest(optimistic.hlTestnet);
      persistNetworkState(optimistic);

      let resolved = previous;

      try {
        const res = await fetch("/api/network", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });
        const data = await res.json().catch(() => ({} as { error?: string }));

        if (res.ok && data.success) {
          resolved = {
            monadTestnet: Boolean(data.monadTestnet),
            hlTestnet: Boolean(data.hlTestnet),
          };
          setMonadTest(resolved.monadTestnet);
          setHlTest(resolved.hlTestnet);
          persistNetworkState(resolved);
        } else {
          console.warn(
            "[Network] Server-side switch failed; reverting to previous network state:",
            data.error || `HTTP ${res.status}`
          );
          setMonadTest(previous.monadTestnet);
          setHlTest(previous.hlTestnet);
          persistNetworkState(previous);
        }
      } catch (e) {
        console.warn("[Network] Server request failed; reverting to previous network state:", e);
        setMonadTest(previous.monadTestnet);
        setHlTest(previous.hlTestnet);
        persistNetworkState(previous);
      } finally {
        if (syncWalletChain) {
          const targetChainId = resolved.monadTestnet
            ? monadTestnet.id
            : monadMainnet.id;
          try {
            await switchChainAsync({ chainId: targetChainId });
          } catch {
            // User may reject or already on chain
          }
        }
        setSwitching(false);
      }
    },
    [hlTest, monadTest, persistNetworkState, switchChainAsync]
  );

  const toggleNetwork = useCallback(async () => {
    const newTestnet = !monadTest;
    await setNetwork({ monadTestnet: newTestnet, hlTestnet: newTestnet });
  }, [monadTest, setNetwork]);

  // Keep runtime network in sync with the connected wallet chain.
  useEffect(() => {
    if (!isConnected) return;
    if (switching) return;

    if (chainId === monadMainnet.id && (monadTest || hlTest)) {
      void setNetwork(
        { monadTestnet: false, hlTestnet: false },
        { syncWalletChain: false }
      );
      return;
    }

    if (chainId === monadTestnet.id && (!monadTest || !hlTest)) {
      void setNetwork(
        { monadTestnet: true, hlTestnet: true },
        { syncWalletChain: false }
      );
    }
  }, [chainId, hlTest, isConnected, monadTest, setNetwork, switching]);

  return (
    <NetworkContext.Provider
      value={{
        monadTestnet: monadTest,
        hlTestnet: hlTest,
        switching,
        toggleNetwork,
        setNetwork,
      }}
    >
      {children}
    </NetworkContext.Provider>
  );
}
