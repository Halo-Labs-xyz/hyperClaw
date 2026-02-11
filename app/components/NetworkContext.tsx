"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useSwitchChain } from "wagmi";
import { monadTestnet, monadMainnet } from "@/lib/chains";

interface NetworkContextValue {
  monadTestnet: boolean;
  hlTestnet: boolean;
  switching: boolean;
  /** Toggle both Monad + HL together */
  toggleNetwork: () => Promise<void>;
  /** Set specific network flags */
  setNetwork: (update: {
    monadTestnet?: boolean;
    hlTestnet?: boolean;
  }) => Promise<void>;
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
  const { switchChainAsync } = useSwitchChain();

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
    async (update: { monadTestnet?: boolean; hlTestnet?: boolean }) => {
      setSwitching(true);
      try {
        // Update server
        const res = await fetch("/api/network", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });
        const data = await res.json().catch(() => ({} as { error?: string }));

        if (!res.ok || !data.success) {
          throw new Error(
            data.error || `Failed to switch network (HTTP ${res.status})`
          );
        }

        setMonadTest(data.monadTestnet);
        setHlTest(data.hlTestnet);

        // Persist to localStorage
        localStorage.setItem(
          "hyperclaw-network",
          JSON.stringify({
            monadTestnet: data.monadTestnet,
            hlTestnet: data.hlTestnet,
          })
        );

        // Switch wallet chain
        const targetChainId = data.monadTestnet
          ? monadTestnet.id
          : monadMainnet.id;
        try {
          await switchChainAsync({ chainId: targetChainId });
        } catch {
          // User may reject or already on chain
        }
      } catch (e) {
        console.error("Network switch failed:", e);
      } finally {
        setSwitching(false);
      }
    },
    [switchChainAsync]
  );

  const toggleNetwork = useCallback(async () => {
    const newTestnet = !monadTest;
    await setNetwork({ monadTestnet: newTestnet, hlTestnet: newTestnet });
  }, [monadTest, setNetwork]);

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
