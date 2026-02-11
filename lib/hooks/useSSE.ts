"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface UseSSEOptions {
  url: string;
  event: string;
  enabled?: boolean;
}

/**
 * React hook for consuming SSE streams.
 * Connects to an SSE endpoint and returns live-updating data.
 */
export function useSSE<T>(options: UseSSEOptions): {
  data: T | null;
  connected: boolean;
  error: string | null;
  reconnect: () => void;
} {
  const { url, event, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (!enabled || !url) return;

    // Close existing connection
    if (sourceRef.current) {
      sourceRef.current.close();
    }

    const source = new EventSource(url);
    sourceRef.current = source;

    source.addEventListener("connected", () => {
      setConnected(true);
      setError(null);
    });

    source.addEventListener(event, (e) => {
      try {
        const parsed = JSON.parse(e.data) as T;
        setData(parsed);
      } catch {
        // Parse error
      }
    });

    source.addEventListener("error", () => {
      setConnected(false);
      setError("Connection lost, reconnecting...");
    });

    source.onerror = () => {
      setConnected(false);
    };
  }, [url, event, enabled]);

  useEffect(() => {
    connect();
    return () => {
      sourceRef.current?.close();
    };
  }, [connect]);

  const reconnect = useCallback(() => {
    setError(null);
    connect();
  }, [connect]);

  return { data, connected, error, reconnect };
}

/**
 * Hook for SSE with multiple event types on the same stream
 */
export function useSSEMulti<T extends Record<string, unknown>>(
  url: string,
  events: string[],
  enabled: boolean = true
): {
  data: Partial<T>;
  connected: boolean;
  error: string | null;
} {
  const [data, setData] = useState<Partial<T>>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled || !url) return;

    const source = new EventSource(url);
    sourceRef.current = source;

    source.addEventListener("connected", () => {
      setConnected(true);
      setError(null);
    });

    for (const event of events) {
      source.addEventListener(event, (e) => {
        try {
          const parsed = JSON.parse(e.data);
          setData((prev) => ({ ...prev, [event]: parsed }));
        } catch {
          // Parse error
        }
      });
    }

    source.onerror = () => {
      setConnected(false);
      setError("Connection lost");
    };

    return () => {
      source.close();
    };
  }, [url, events, enabled]);

  return { data, connected, error };
}
