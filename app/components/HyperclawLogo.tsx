"use client";

import { useId } from "react";

/** Logo: AI perp trading agents on Hyperliquid + Monad. Uses brand gradient. */
export function HyperclawLogo({ className = "" }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 140 24"
      className={`inline-block ${className}`}
      style={{ height: "1.25em" }}
    >
      <defs>
        <linearGradient id={`hyperclaw-logo-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#30e8a0" />
          <stop offset="53%" stopColor="#30e8a0" />
          <stop offset="57%" stopColor="#836ef9" />
        </linearGradient>
      </defs>
      <text
        x="0"
        y="18"
        fill={`url(#hyperclaw-logo-${id})`}
        fontSize="18"
        fontFamily="var(--font-geist-sans), system-ui, sans-serif"
        fontWeight="bold"
        letterSpacing="-0.02em"
      >
        Hyperclaw
      </text>
    </svg>
  );
}
