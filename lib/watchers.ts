/**
 * WebSocket Watcher Manager
 *
 * Thin wrapper around @nktkas/hyperliquid SubscriptionClient.
 * Manages subscription lifecycle and data normalization for SSE routes.
 * Mirrors the CLI's *-watcher.ts pattern but adapted for server-side Next.js.
 */

import { type Address } from "viem";
import { getSubscriptionClient, getInfoClient, closeWsTransport } from "./hyperliquid";
import type {
  StreamPosition,
  StreamOrder,
  StreamBalance,
  StreamBook,
  StreamBookLevel,
  StreamPrice,
} from "./types";

// ============================================
// Types
// ============================================

type Listener<T> = (data: T) => void;
type Unsubscribe = () => Promise<void>;

interface WatcherHandle {
  unsubscribe: Unsubscribe;
  listeners: Set<Listener<unknown>>;
}

// Active subscription handles keyed by channel+params
const activeWatchers = new Map<string, WatcherHandle>();

function watcherKey(channel: string, params: Record<string, unknown>): string {
  return `${channel}:${JSON.stringify(params)}`;
}

// ============================================
// Position Watcher
// ============================================

export async function watchPositions(
  user: Address,
  listener: Listener<StreamPosition[]>
): Promise<Unsubscribe> {
  const key = watcherKey("clearinghouseState", { user });

  // If already watching this user, just add listener
  const existing = activeWatchers.get(key);
  if (existing) {
    existing.listeners.add(listener as Listener<unknown>);
    return async () => {
      existing.listeners.delete(listener as Listener<unknown>);
      if (existing.listeners.size === 0) {
        await existing.unsubscribe();
        activeWatchers.delete(key);
      }
    };
  }

  const client = await getSubscriptionClient();
  const listeners = new Set<Listener<unknown>>([listener as Listener<unknown>]);

  const sub = await client.clearinghouseState({ user }, (event) => {
    const state = event.clearinghouseState;
    const positions: StreamPosition[] = (state.assetPositions || [])
      .filter((p) => parseFloat(p.position.szi) !== 0)
      .map((p) => {
        const size = parseFloat(p.position.szi);
        const entryPrice = parseFloat(p.position.entryPx || "0");
        const positionValue = Math.abs(size) * entryPrice;
        const unrealizedPnl = parseFloat(p.position.unrealizedPnl);
        const leverageVal = parseFloat(
          String(p.position.leverage?.value ?? "1")
        );

        return {
          coin: p.position.coin,
          size: Math.abs(size),
          entryPrice,
          positionValue,
          unrealizedPnl,
          unrealizedPnlPercent:
            positionValue > 0 ? (unrealizedPnl / positionValue) * 100 : 0,
          leverage: leverageVal,
          liquidationPrice: p.position.liquidationPx
            ? parseFloat(p.position.liquidationPx)
            : null,
          marginUsed: parseFloat(p.position.marginUsed || "0"),
          side: size > 0 ? ("long" as const) : ("short" as const),
        };
      });

    Array.from(listeners).forEach((l) => {
      (l as Listener<StreamPosition[]>)(positions);
    });
  });

  activeWatchers.set(key, {
    unsubscribe: () => sub.unsubscribe(),
    listeners,
  });

  return async () => {
    listeners.delete(listener as Listener<unknown>);
    if (listeners.size === 0) {
      await sub.unsubscribe();
      activeWatchers.delete(key);
    }
  };
}

// ============================================
// Order Watcher
// ============================================

export async function watchOrders(
  user: Address,
  listener: Listener<StreamOrder[]>
): Promise<Unsubscribe> {
  const key = watcherKey("openOrders", { user });

  const existing = activeWatchers.get(key);
  if (existing) {
    existing.listeners.add(listener as Listener<unknown>);
    return async () => {
      existing.listeners.delete(listener as Listener<unknown>);
      if (existing.listeners.size === 0) {
        await existing.unsubscribe();
        activeWatchers.delete(key);
      }
    };
  }

  const client = await getSubscriptionClient();
  const listeners = new Set<Listener<unknown>>([listener as Listener<unknown>]);

  const sub = await client.openOrders({ user }, (event) => {
    const orders: StreamOrder[] = (event.orders || []).map((o) => ({
      oid: o.oid,
      coin: o.coin,
      side: o.side === "B" ? ("buy" as const) : ("sell" as const),
      price: parseFloat(o.limitPx),
      size: parseFloat(o.sz),
      originalSize: parseFloat(o.origSz),
      orderType: o.orderType || "limit",
      reduceOnly: o.reduceOnly ?? false,
      timestamp: o.timestamp,
    }));

    Array.from(listeners).forEach((l) => {
      (l as Listener<StreamOrder[]>)(orders);
    });
  });

  activeWatchers.set(key, {
    unsubscribe: () => sub.unsubscribe(),
    listeners,
  });

  return async () => {
    listeners.delete(listener as Listener<unknown>);
    if (listeners.size === 0) {
      await sub.unsubscribe();
      activeWatchers.delete(key);
    }
  };
}

// ============================================
// Balance Watcher (via clearinghouseState)
// ============================================

export async function watchBalances(
  user: Address,
  listener: Listener<StreamBalance>
): Promise<Unsubscribe> {
  const key = watcherKey("balances", { user });

  const existing = activeWatchers.get(key);
  if (existing) {
    existing.listeners.add(listener as Listener<unknown>);
    return async () => {
      existing.listeners.delete(listener as Listener<unknown>);
      if (existing.listeners.size === 0) {
        await existing.unsubscribe();
        activeWatchers.delete(key);
      }
    };
  }

  const client = await getSubscriptionClient();
  const listeners = new Set<Listener<unknown>>([listener as Listener<unknown>]);

  const sub = await client.clearinghouseState({ user }, (event) => {
    const state = event.clearinghouseState;
    const balance: StreamBalance = {
      totalEquity: parseFloat(state.marginSummary?.accountValue || "0"),
      availableBalance: parseFloat(state.withdrawable || "0"),
      marginUsed: parseFloat(state.marginSummary?.totalMarginUsed || "0"),
      unrealizedPnl: parseFloat(
        state.marginSummary?.totalNtlPos || "0"
      ),
      accountValue: parseFloat(state.marginSummary?.accountValue || "0"),
    };

    Array.from(listeners).forEach((l) => {
      (l as Listener<StreamBalance>)(balance);
    });
  });

  activeWatchers.set(key, {
    unsubscribe: () => sub.unsubscribe(),
    listeners,
  });

  return async () => {
    listeners.delete(listener as Listener<unknown>);
    if (listeners.size === 0) {
      await sub.unsubscribe();
      activeWatchers.delete(key);
    }
  };
}

// ============================================
// Price Watcher (allMids)
// ============================================

export async function watchPrices(
  listener: Listener<Record<string, StreamPrice>>
): Promise<Unsubscribe> {
  const key = watcherKey("allMids", {});

  const existing = activeWatchers.get(key);
  if (existing) {
    existing.listeners.add(listener as Listener<unknown>);
    return async () => {
      existing.listeners.delete(listener as Listener<unknown>);
      if (existing.listeners.size === 0) {
        await existing.unsubscribe();
        activeWatchers.delete(key);
      }
    };
  }

  const client = await getSubscriptionClient();
  const listeners = new Set<Listener<unknown>>([listener as Listener<unknown>]);

  const sub = await client.allMids((event) => {
    const now = Date.now();
    const prices: Record<string, StreamPrice> = {};
    for (const [coin, price] of Object.entries(event.mids)) {
      prices[coin] = {
        coin,
        price: parseFloat(price),
        timestamp: now,
      };
    }

    Array.from(listeners).forEach((l) => {
      (l as Listener<Record<string, StreamPrice>>)(prices);
    });
  });

  activeWatchers.set(key, {
    unsubscribe: () => sub.unsubscribe(),
    listeners,
  });

  return async () => {
    listeners.delete(listener as Listener<unknown>);
    if (listeners.size === 0) {
      await sub.unsubscribe();
      activeWatchers.delete(key);
    }
  };
}

// ============================================
// Book Watcher
// ============================================

export async function watchBook(
  coin: string,
  listener: Listener<StreamBook>
): Promise<Unsubscribe> {
  const key = watcherKey("l2Book", { coin });

  const existing = activeWatchers.get(key);
  if (existing) {
    existing.listeners.add(listener as Listener<unknown>);
    return async () => {
      existing.listeners.delete(listener as Listener<unknown>);
      if (existing.listeners.size === 0) {
        await existing.unsubscribe();
        activeWatchers.delete(key);
      }
    };
  }

  const client = await getSubscriptionClient();
  const listeners = new Set<Listener<unknown>>([listener as Listener<unknown>]);

  const sub = await client.l2Book({ coin }, (event) => {
    const bids = parseBookLevels(event.levels[0] || []);
    const asks = parseBookLevels(event.levels[1] || []);

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadPercent = midPrice > 0 ? (spread / midPrice) * 100 : 0;

    const book: StreamBook = {
      coin,
      bids,
      asks,
      spread,
      spreadPercent,
      midPrice,
    };

    Array.from(listeners).forEach((l) => {
      (l as Listener<StreamBook>)(book);
    });
  });

  activeWatchers.set(key, {
    unsubscribe: () => sub.unsubscribe(),
    listeners,
  });

  return async () => {
    listeners.delete(listener as Listener<unknown>);
    if (listeners.size === 0) {
      await sub.unsubscribe();
      activeWatchers.delete(key);
    }
  };
}

function parseBookLevels(
  levels: Array<{ px: string; sz: string; n: number }>
): StreamBookLevel[] {
  let cumulative = 0;
  const parsed = levels.map((l) => {
    const size = parseFloat(l.sz);
    cumulative += size;
    return {
      price: parseFloat(l.px),
      size,
      cumulative,
      percent: 0,
    };
  });

  // Calculate depth percentages
  const totalDepth = cumulative;
  for (const level of parsed) {
    level.percent = totalDepth > 0 ? (level.cumulative / totalDepth) * 100 : 0;
  }

  return parsed;
}

// ============================================
// One-shot data fetchers (non-streaming)
// ============================================

export async function fetchPositionsSnapshot(
  user: Address
): Promise<StreamPosition[]> {
  const info = getInfoClient();
  const state = await info.clearinghouseState({ user });

  return (state.assetPositions || [])
    .filter((p) => parseFloat(p.position.szi) !== 0)
    .map((p) => {
      const size = parseFloat(p.position.szi);
      const entryPrice = parseFloat(p.position.entryPx || "0");
      const positionValue = Math.abs(size) * entryPrice;
      const unrealizedPnl = parseFloat(p.position.unrealizedPnl);
      const leverageVal = parseFloat(
        String(p.position.leverage?.value ?? "1")
      );

      return {
        coin: p.position.coin,
        size: Math.abs(size),
        entryPrice,
        positionValue,
        unrealizedPnl,
        unrealizedPnlPercent:
          positionValue > 0 ? (unrealizedPnl / positionValue) * 100 : 0,
        leverage: leverageVal,
        liquidationPrice: p.position.liquidationPx
          ? parseFloat(p.position.liquidationPx)
          : null,
        marginUsed: parseFloat(p.position.marginUsed || "0"),
        side: size > 0 ? ("long" as const) : ("short" as const),
      };
    });
}

export async function fetchBalanceSnapshot(
  user: Address
): Promise<StreamBalance> {
  const info = getInfoClient();
  const state = await info.clearinghouseState({ user });

  return {
    totalEquity: parseFloat(state.marginSummary?.accountValue || "0"),
    availableBalance: parseFloat(state.withdrawable || "0"),
    marginUsed: parseFloat(state.marginSummary?.totalMarginUsed || "0"),
    unrealizedPnl: parseFloat(state.marginSummary?.totalNtlPos || "0"),
    accountValue: parseFloat(state.marginSummary?.accountValue || "0"),
  };
}

export async function fetchBookSnapshot(coin: string): Promise<StreamBook> {
  const info = getInfoClient();
  const rawBook = await info.l2Book({ coin, nSigFigs: 5 });

  const bids = parseBookLevels((rawBook?.levels?.[0]) || []);
  const asks = parseBookLevels((rawBook?.levels?.[1]) || []);

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const midPrice = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadPercent = midPrice > 0 ? (spread / midPrice) * 100 : 0;

  return { coin, bids, asks, spread, spreadPercent, midPrice };
}

// ============================================
// Cleanup
// ============================================

export async function cleanupAllWatchers(): Promise<void> {
  const entries = Array.from(activeWatchers.entries());
  for (let i = 0; i < entries.length; i++) {
    const [key, handle] = entries[i];
    await handle.unsubscribe();
    activeWatchers.delete(key);
  }
  await closeWsTransport();
}
