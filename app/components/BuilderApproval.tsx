"use client";

import { useState, useEffect } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import { type Address } from "viem";

interface BuilderInfo {
  enabled: boolean;
  builder?: {
    address: Address;
    feePoints: number;
    feePercent: string;
  };
  user?: {
    address: Address;
    hasApproval: boolean;
    needsApproval: boolean;
    maxApprovedFee: number;
    maxApprovedPercent: string;
  };
}

interface BuilderApprovalProps {
  onApprovalComplete?: () => void;
  showIfNotNeeded?: boolean;
  mode?: "info" | "approval"; // "info" = informational only, "approval" = show approval button
}

/**
 * BuilderApproval Component (Updated for Vincent-style auto-approval)
 * 
 * Now primarily informational since builder codes are auto-approved on first trade.
 * 
 * Modes:
 * - "info" (default): Shows info banner about builder fees, no action required
 * - "approval": Shows manual approval button (for users who want to pre-approve)
 * 
 * Note: Agent wallets auto-approve builder codes on:
 * 1. Wallet provisioning (when agent is created)
 * 2. First trade execution (if not already approved)
 */
export default function BuilderApproval({ 
  onApprovalComplete,
  showIfNotNeeded = false,
  mode = "info"
}: BuilderApprovalProps) {
  const { address, isConnected, chain } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  
  const [builderInfo, setBuilderInfo] = useState<BuilderInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch builder info and user approval status
  useEffect(() => {
    if (!address) return;

    const fetchInfo = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/builder/info?user=${address}`);
        const data = await res.json();
        setBuilderInfo(data);
      } catch (err) {
        console.error("Failed to fetch builder info:", err);
        setError("Failed to load builder information");
      } finally {
        setLoading(false);
      }
    };

    fetchInfo();
  }, [address]);

  const handleApprove = async () => {
    if (!address || !chain || !builderInfo?.builder) return;

    try {
      setApproving(true);
      setError(null);

      // Get the typed data for signing
      const nonce = Date.now();
      const typedDataRes = await fetch(
        `/api/builder/approve/typed-data?chainId=${chain.id}&nonce=${nonce}`
      );
      const { typedData } = await typedDataRes.json();

      // Sign the approval
      const signature = await signTypedDataAsync({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });

      // Split signature into r, s, v
      const r = signature.slice(0, 66);
      const s = "0x" + signature.slice(66, 130);
      const v = parseInt(signature.slice(130, 132), 16);

      // Submit to Hyperliquid
      const submitRes = await fetch("/api/builder/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signature: { r, s, v },
          nonce,
          chainId: chain.id,
        }),
      });

      const result = await submitRes.json();

      if (!submitRes.ok) {
        throw new Error(result.error || "Approval failed");
      }

      // Refresh builder info
      const refreshRes = await fetch(`/api/builder/info?user=${address}`);
      const refreshedData = await refreshRes.json();
      setBuilderInfo(refreshedData);

      if (onApprovalComplete) {
        onApprovalComplete();
      }
    } catch (err: any) {
      console.error("Approval error:", err);
      setError(err.message || "Failed to approve builder fee");
    } finally {
      setApproving(false);
    }
  };

  // Don't render if not connected (for "approval" mode)
  if (mode === "approval" && (!isConnected || !address)) {
    return null;
  }

  // Don't render if builder not configured
  if (!loading && (!builderInfo?.enabled || !builderInfo.builder)) {
    return null;
  }

  // In "info" mode, always show (unless showIfNotNeeded is false and user is approved)
  if (mode === "info") {
    if (!loading && builderInfo?.user?.hasApproval && !showIfNotNeeded) {
      return null;
    }

    return (
      <div className="border border-[#30e8a0]/20 rounded-lg p-5 bg-black/40">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-[#30e8a0]/10 border border-[#30e8a0]/20 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-[#30e8a0]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-[#30e8a0] mb-1">
              Builder Fees Auto-Approved
            </h3>
            <p className="text-xs text-gray-400 leading-relaxed">
              HyperClaw charges a {builderInfo?.builder?.feePercent} builder fee on trades. 
              Agent wallets automatically approve this fee when created or on first trade - no action needed from you.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // "approval" mode - manual approval UI
  if (!loading && builderInfo?.user?.hasApproval && !showIfNotNeeded) {
    return null;
  }

  if (loading) {
    return (
      <div className="border border-[#30e8a0]/20 rounded-lg p-6 bg-black/40">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-[#30e8a0] border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-400">Loading builder information...</p>
        </div>
      </div>
    );
  }

  const hasApproval = builderInfo?.user?.hasApproval;

  return (
    <div className="border border-[#30e8a0]/20 rounded-lg p-6 bg-black/40">
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-[#30e8a0]">
            {hasApproval ? "✓ Builder Fee Approved" : "Pre-Approve Builder Fee"}
          </h3>
          <p className="text-sm text-gray-400 mt-2">
            {hasApproval
              ? `You've approved a ${builderInfo.user?.maxApprovedPercent} builder fee for HyperClaw trades.`
              : `Optional: Pre-approve the ${builderInfo?.builder?.feePercent} builder fee now, or it will be automatically approved on your first trade.`}
          </p>
        </div>

        {!hasApproval && (
          <div className="space-y-3">
            <div className="bg-[#30e8a0]/5 border border-[#30e8a0]/20 rounded p-3 text-xs text-gray-300">
              <p className="font-medium text-[#30e8a0] mb-1">Auto-Approval Info</p>
              <p>Agent wallets automatically approve builder fees on first trade. You can pre-approve here if you prefer, but it's not required.</p>
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded p-3 text-xs text-red-400">
                {error}
              </div>
            )}

            <button
              onClick={handleApprove}
              disabled={approving}
              className="w-full py-3 bg-[#30e8a0] hover:bg-[#30e8a0]/80 disabled:bg-[#30e8a0]/50 text-black font-medium rounded-lg transition-colors"
            >
              {approving ? "Approving..." : "Pre-Approve Builder Fee"}
            </button>
          </div>
        )}

        {hasApproval && showIfNotNeeded && (
          <div className="bg-[#30e8a0]/5 border border-[#30e8a0]/20 rounded p-3">
            <div className="flex items-center gap-2 text-sm text-[#30e8a0]">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span>All set! You can start trading.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
