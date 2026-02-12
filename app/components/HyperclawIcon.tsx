"use client";

import Image from "next/image";

/**
 * Hyperclaw icon: HCLAW logo mark.
 */
export function HyperclawIcon({ className = "", size = 28 }: { className?: string; size?: number }) {
  return (
    <Image
      src="/icons/hclawlogo.png"
      alt="Hyperclaw"
      width={size}
      height={size}
      className={`object-contain ${className}`}
      aria-hidden="true"
    />
  );
}
