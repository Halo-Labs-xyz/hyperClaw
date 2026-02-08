import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Offline",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[#0f0f23] flex items-center justify-center text-white">
      <div className="text-center">
        <span className="text-5xl block mb-4">🦞</span>
        <h1 className="text-2xl font-bold mb-2">You&apos;re Offline</h1>
        <p className="text-gray-400">
          Hyperclaw needs an internet connection to fetch market data and trade.
        </p>
        <p className="text-gray-500 mt-4 text-sm">
          Please check your connection and try again.
        </p>
      </div>
    </div>
  );
}
