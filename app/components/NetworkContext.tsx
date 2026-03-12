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
import { evmTestnet, evmMainnet } from "@/lib/chains";

interface NetworkContextValue {
  evmTestnet: boolean;
  // Backward-compat alias for existing UI consumers.
  monadTestnet: boolean;
  hlTestnet: boolean;
  switching: boolean;
  /** Toggle both EVM + HL together */
  toggleNetwork: () => Promise<void>;
  /** Set specific network flags */
  setNetwork: (
    update: {
      evmTestnet?: boolean;
      monadTestnet?: boolean;
      hlTestnet?: boolean;
    },
    options?: { syncWalletChain?: boolean }
  ) => Promise<void>;
}

const NetworkContext = createContext<NetworkContextValue>({
  evmTestnet: true,
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
  const [evmTest, setEvmTest] = useState(true);
  const [hlTest, setHlTest] = useState(true);
  const [switching, setSwitching] = useState(false);
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const persistNetworkState = useCallback(
    (next: { evmTestnet: boolean; hlTestnet: boolean }) => {
      localStorage.setItem(
        "hyperclaw-network",
        JSON.stringify({
          evmTestnet: next.evmTestnet,
          monadTestnet: next.evmTestnet,
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
        const nextEvmTestnet = data.evmTestnet ?? data.monadTestnet ?? true;
        setEvmTest(nextEvmTestnet);
        setHlTest(data.hlTestnet ?? true);
        localStorage.setItem(
          "hyperclaw-network",
          JSON.stringify({
            evmTestnet: nextEvmTestnet,
            monadTestnet: nextEvmTestnet,
            hlTestnet: data.hlTestnet ?? true,
          })
        );
      } catch {
        const stored = localStorage.getItem("hyperclaw-network");
        if (!stored || cancelled) return;
        try {
          const parsed = JSON.parse(stored);
          const parsedEvm =
            typeof parsed.evmTestnet === "boolean"
              ? parsed.evmTestnet
              : typeof parsed.monadTestnet === "boolean"
                ? parsed.monadTestnet
                : undefined;
          if (typeof parsedEvm === "boolean") setEvmTest(parsedEvm);
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
      update: { evmTestnet?: boolean; monadTestnet?: boolean; hlTestnet?: boolean },
      options?: { syncWalletChain?: boolean }
    ) => {
      const syncWalletChain = options?.syncWalletChain ?? true;
      const previous = {
        evmTestnet: evmTest,
        hlTestnet: hlTest,
      };
      const nextEvmTestnet =
        update.evmTestnet ?? update.monadTestnet ?? evmTest;
      const optimistic = {
        evmTestnet: nextEvmTestnet,
        hlTestnet: update.hlTestnet ?? hlTest,
      };

      setSwitching(true);
      setEvmTest(optimistic.evmTestnet);
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
          const resolvedEvmTestnet = Boolean(data.evmTestnet ?? data.monadTestnet);
          resolved = {
            evmTestnet: resolvedEvmTestnet,
            hlTestnet: Boolean(data.hlTestnet),
          };
          setEvmTest(resolved.evmTestnet);
          setHlTest(resolved.hlTestnet);
          persistNetworkState(resolved);
        } else {
          console.warn(
            "[Network] Server-side switch failed; reverting to previous network state:",
            data.error || `HTTP ${res.status}`
          );
          setEvmTest(previous.evmTestnet);
          setHlTest(previous.hlTestnet);
          persistNetworkState(previous);
        }
      } catch (e) {
        console.warn("[Network] Server request failed; reverting to previous network state:", e);
        setEvmTest(previous.evmTestnet);
        setHlTest(previous.hlTestnet);
        persistNetworkState(previous);
      } finally {
        if (syncWalletChain) {
          const targetChainId = resolved.evmTestnet
            ? evmTestnet.id
            : evmMainnet.id;
          try {
            await switchChainAsync({ chainId: targetChainId });
          } catch {
            // User may reject or already on chain
          }
        }
        setSwitching(false);
      }
    },
    [hlTest, evmTest, persistNetworkState, switchChainAsync]
  );

  const toggleNetwork = useCallback(async () => {
    const newTestnet = !evmTest;
    await setNetwork({ evmTestnet: newTestnet, hlTestnet: newTestnet });
  }, [evmTest, setNetwork]);

  // Keep runtime network in sync with the connected wallet chain.
  useEffect(() => {
    if (!isConnected) return;
    if (switching) return;

    if (chainId === evmMainnet.id && (evmTest || hlTest)) {
      void setNetwork(
        { evmTestnet: false, hlTestnet: false },
        { syncWalletChain: false }
      );
      return;
    }

    if (chainId === evmTestnet.id && (!evmTest || !hlTest)) {
      void setNetwork(
        { evmTestnet: true, hlTestnet: true },
        { syncWalletChain: false }
      );
    }
  }, [chainId, hlTest, isConnected, evmTest, setNetwork, switching]);

  return (
    <NetworkContext.Provider
      value={{
        evmTestnet: evmTest,
        monadTestnet: evmTest,
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
