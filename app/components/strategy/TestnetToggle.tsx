"use client";

interface Props {
  isTestnet: boolean;
  onChange: (testnet: boolean) => void;
}

export function TestnetToggle({ isTestnet, onChange }: Props) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => onChange(false)}
        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
          !isTestnet
            ? "bg-accent text-white"
            : "bg-background border border-card-border text-muted hover:text-white"
        }`}
      >
        Mainnet
      </button>
      <button
        onClick={() => onChange(true)}
        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
          isTestnet
            ? "bg-warning text-black"
            : "bg-background border border-card-border text-muted hover:text-white"
        }`}
      >
        Testnet
      </button>
      {isTestnet && (
        <span className="text-xs text-warning font-medium">
          Using testnet -- trades are simulated
        </span>
      )}
    </div>
  );
}
