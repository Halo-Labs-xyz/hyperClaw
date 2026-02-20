/**
 * Network State
 *
 * Runtime-switchable network configuration for both EVM and Hyperliquid.
 * Allows toggling testnet/mainnet without server restart.
 *
 * The state is held in-memory on the server and synced to the client
 * via /api/network. Client stores preference in localStorage.
 */

export interface NetworkState {
  evmTestnet: boolean;
  // Backward-compat field. Mirrors evmTestnet.
  monadTestnet: boolean;
  hlTestnet: boolean;
}

// Server-side mutable state (initialized from env vars)
// If NEXT_PUBLIC_HYPERLIQUID_TESTNET is not explicitly set, mirror EVM testnet setting.
const evmTestnetDefault = process.env.NEXT_PUBLIC_EVM_TESTNET !== undefined
  ? process.env.NEXT_PUBLIC_EVM_TESTNET === "true"
  : process.env.NEXT_PUBLIC_MONAD_TESTNET !== "false";
let networkState: NetworkState = {
  evmTestnet: evmTestnetDefault,
  monadTestnet: evmTestnetDefault,
  hlTestnet: process.env.NEXT_PUBLIC_HYPERLIQUID_TESTNET !== undefined
    ? process.env.NEXT_PUBLIC_HYPERLIQUID_TESTNET === "true"
    : evmTestnetDefault,
};

// Change listeners — modules register to flush their cached clients
type NetworkChangeListener = (state: NetworkState) => void;
const listeners: NetworkChangeListener[] = [];

export function getNetworkState(): NetworkState {
  return { ...networkState };
}

export function isEvmTestnet(): boolean {
  return networkState.evmTestnet;
}

export function isMonadTestnet(): boolean {
  return isEvmTestnet();
}

export function isHlTestnet(): boolean {
  return networkState.hlTestnet;
}

/**
 * Switch network at runtime. Notifies all registered listeners
 * so they can invalidate cached clients/transports.
 */
export function setNetworkState(update: Partial<NetworkState>): NetworkState {
  const nextEvmTestnet =
    update.evmTestnet !== undefined
      ? update.evmTestnet
      : update.monadTestnet !== undefined
        ? update.monadTestnet
        : networkState.evmTestnet;
  const nextHlTestnet = update.hlTestnet ?? networkState.hlTestnet;

  const changed =
    nextEvmTestnet !== networkState.evmTestnet ||
    nextHlTestnet !== networkState.hlTestnet;

  networkState = {
    ...networkState,
    ...update,
    evmTestnet: nextEvmTestnet,
    monadTestnet: nextEvmTestnet,
    hlTestnet: nextHlTestnet,
  };

  if (changed) {
    for (const listener of listeners) {
      try {
        listener(networkState);
      } catch (e) {
        console.error("[Network] Listener error:", e);
      }
    }
  }

  return { ...networkState };
}

/**
 * Register a listener that fires when network changes.
 * Returns an unsubscribe function.
 */
export function onNetworkChange(listener: NetworkChangeListener): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}
