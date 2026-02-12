import type { Metadata } from "next";
import { HyperclawIcon } from "@/app/components/HyperclawIcon";

export const metadata: Metadata = {
  title: "Offline",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[#0f0f23] flex items-center justify-center text-white">
      <div className="text-center">
        <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-white/20 border border-white/30 flex items-center justify-center">
          <HyperclawIcon className="text-accent" size={36} />
        </div>
        <h1 className="text-2xl font-bold mb-2 gradient-title">You&apos;re Offline</h1>
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
