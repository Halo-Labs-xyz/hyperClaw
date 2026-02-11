"use client";

/**
 * Deterministic avatar from agent name + description.
 * Same name+desc always produces the same identicon.
 */
const PALETTE = [
  "#30e8a0", // green
  "#836ef9", // purple
  "#4af0ff", // cyan
  "#e8a030", // amber
  "#e8308a", // pink
  "#8a30e8", // violet
];

function hash(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function AgentAvatar({
  name,
  description = "",
  size = 40,
  className = "",
}: {
  name: string;
  description?: string;
  size?: number;
  className?: string;
}) {
  const seed = `${name}|${description}`;
  const h = hash(seed);
  const bgColor = PALETTE[h % PALETTE.length];
  const fgColor = PALETTE[(h >> 4) % PALETTE.length];
  const invert = (h >> 8) % 2 === 0;

  // 5x5 identicon grid (left half mirrored) - 15 bits
  const cellSize = size / 5;
  const cells: { x: number; y: number; fill: boolean }[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const bit = ((h >> (row * 3 + col)) & 1) === 1;
      cells.push({ x: col, y: row, fill: bit });
      if (col < 2) cells.push({ x: 4 - col, y: row, fill: bit });
    }
  }

  const fillColor = invert ? fgColor : bgColor;
  const accentColor = invert ? bgColor : fgColor;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
    >
      <rect width={size} height={size} fill={fillColor} rx={size * 0.2} />
      <g fill={accentColor}>
        {cells
          .filter((c) => c.fill)
          .map((c, i) => (
            <rect
              key={i}
              x={c.x * cellSize + cellSize * 0.1}
              y={c.y * cellSize + cellSize * 0.1}
              width={cellSize * 0.8}
              height={cellSize * 0.8}
              rx={cellSize * 0.15}
            />
          ))}
      </g>
    </svg>
  );
}
