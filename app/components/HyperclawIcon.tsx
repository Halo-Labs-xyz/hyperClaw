"use client";

/**
 * Hyperclaw icon: stylized claw marks.
 * Represents AI trading agents, perps, and sharp execution.
 */
export function HyperclawIcon({ className = "", size = 18 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Three claw scratches - curved, predatory */}
      <path d="M6 6 Q12 10 18 5" />
      <path d="M6 12 Q12 14 18 11" />
      <path d="M6 18 Q12 18 18 15" />
    </svg>
  );
}
