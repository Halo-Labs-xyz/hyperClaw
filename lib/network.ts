/**
 * Network State
 *
 * Runtime-switchable network configuration for both Monad and Hyperliquid.
 * Allows toggling testnet/mainnet without server restart.
 *
 * The state is held in-memory on the server and synced to the client
 * via /api/network. Client stores preference in localStorage.
 */

export interface NetworkState {
  monadTestnet: boolean;
  hlTestnet: boolean;
}

// Server-side mutable state (initialized from env vars)
// If NEXT_PUBLIC_HYPERLIQUID_TESTNET is not explicitly set, mirror Monad's testnet setting
const monadTestnetDefault = process.env.NEXT_PUBLIC_MONAD_TESTNET !== "false";
let networkState: NetworkState = {
  monadTestnet: monadTestnetDefault,
  hlTestnet: process.env.NEXT_PUBLIC_HYPERLIQUID_TESTNET !== undefined
    ? process.env.NEXT_PUBLIC_HYPERLIQUID_TESTNET === "true"
    : monadTestnetDefault,
};

// Change listeners — modules register to flush their cached clients
type NetworkChangeListener = (state: NetworkState) => void;
const listeners: NetworkChangeListener[] = [];

export function getNetworkState(): NetworkState {
  return { ...networkState };
}

export function isMonadTestnet(): boolean {
  return networkState.monadTestnet;
}

export function isHlTestnet(): boolean {
  return networkState.hlTestnet;
}

/**
 * Switch network at runtime. Notifies all registered listeners
 * so they can invalidate cached clients/transports.
 */
export function setNetworkState(update: Partial<NetworkState>): NetworkState {
  const changed =
    (update.monadTestnet !== undefined && update.monadTestnet !== networkState.monadTestnet) ||
    (update.hlTestnet !== undefined && update.hlTestnet !== networkState.hlTestnet);

  networkState = { ...networkState, ...update };

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
