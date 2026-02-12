"use client";

import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { monadMainnet } from "@/lib/chains";
import { useNetwork } from "./NetworkContext";

export function NetworkToggle() {
  const { monadTestnet, hlTestnet, switching, toggleNetwork } = useNetwork();
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  const isTestnet = monadTestnet || hlTestnet;
  const onMainnetWallet = chainId === monadMainnet.id;
  const showMainnetNudge = isConnected && !onMainnetWallet;

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={toggleNetwork}
        disabled={switching}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all text-xs font-medium select-none"
        style={{
          borderColor: isTestnet
            ? "rgba(251, 191, 36, 0.3)"
            : "rgba(34, 197, 94, 0.3)",
          backgroundColor: isTestnet
            ? "rgba(251, 191, 36, 0.08)"
            : "rgba(34, 197, 94, 0.08)",
          color: isTestnet ? "rgb(251, 191, 36)" : "rgb(34, 197, 94)",
          opacity: switching ? 0.6 : 1,
          cursor: switching ? "wait" : "pointer",
        }}
        title={`Click to switch to ${isTestnet ? "Mainnet" : "Testnet"}`}
      >
        {switching ? (
          <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
        ) : (
          <span
            className="w-2 h-2 rounded-full"
            style={{
              backgroundColor: isTestnet
                ? "rgb(251, 191, 36)"
                : "rgb(34, 197, 94)",
              boxShadow: isTestnet
                ? "0 0 6px rgba(251, 191, 36, 0.5)"
                : "0 0 6px rgba(34, 197, 94, 0.5)",
            }}
          />
        )}
        {isTestnet ? "Testnet" : "Mainnet"}
      </button>

      {showMainnetNudge ? (
        <button
          onClick={() => void switchChainAsync({ chainId: monadMainnet.id })}
          className="px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition-all"
          style={{
            borderColor: "rgba(34, 197, 94, 0.35)",
            backgroundColor: "rgba(34, 197, 94, 0.08)",
            color: "rgb(74, 222, 128)",
          }}
          title="Recommended: switch wallet to Monad Mainnet"
        >
          Use Mainnet
        </button>
      ) : null}
    </div>
  );
}
