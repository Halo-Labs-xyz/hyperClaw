"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import {
  useLogin,
  usePrivy,
  WalletWithMetadata,
} from "@privy-io/react-auth";
import { createPublicClient, http, formatEther } from "viem";
import { evmMainnet, evmNativeSymbol } from "@/lib/chains";
import { QRCodeSVG } from "qrcode.react";

const publicClient = createPublicClient({
  chain: evmMainnet,
  transport: http(evmMainnet.rpcUrls.default.http[0]),
});

export default function UseLoginPrivy() {
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState(false);
  const [copied, setCopied] = useState(false);
  const { ready, user, logout } = usePrivy();

  const ethereumEmbeddedWallets = useMemo<WalletWithMetadata[]>(
    () =>
      (user?.linkedAccounts.filter(
        (account) =>
          account.type === "wallet" &&
          account.walletClientType === "privy" &&
          account.chainType === "ethereum"
      ) as WalletWithMetadata[]) ?? [],
    [user]
  );

  const hasEthereumWallet = ethereumEmbeddedWallets.length > 0;
  const walletAddress = ethereumEmbeddedWallets[0]?.address;

  const fetchBalance = useCallback(async () => {
    if (!walletAddress) return;

    setBalanceLoading(true);
    setBalanceError(false);

    try {
      const balanceWei = await publicClient.getBalance({
        address: walletAddress as `0x${string}`,
      });
      const balanceEth = formatEther(balanceWei);
      setBalance(balanceEth);
    } catch (error) {
      console.error("Error fetching balance:", error);
      setBalanceError(true);
    } finally {
      setBalanceLoading(false);
    }
  }, [walletAddress]);

  const copyToClipboard = useCallback(async () => {
    if (!walletAddress) return;

    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy address:", error);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (walletAddress) {
      fetchBalance();
    }
  }, [walletAddress, fetchBalance]);

  const { login } = useLogin();

  if (!ready) {
    return <div className="text-muted">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Wallet Info Card */}
      {hasEthereumWallet && (
        <div className="bg-card border border-card-border rounded-xl p-6">
          <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
            <span className="w-8 h-8 bg-accent/20 rounded-full flex items-center justify-center text-sm">
              W
            </span>
            EVM Wallet
          </h3>

          <div className="space-y-4">
            <div>
              <label className="block text-xs text-muted mb-1">Address</label>
              <div className="bg-background border border-card-border rounded-lg p-3 flex items-center justify-between gap-2">
                <span className="font-mono text-sm break-all">
                  {walletAddress}
                </span>
                <button
                  onClick={copyToClipboard}
                  className="flex-shrink-0 p-1.5 rounded bg-card-border/30 hover:bg-card-border text-muted hover:text-white transition-colors text-xs"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>

            {/* QR Code */}
            <div className="flex flex-col items-center">
              <div className="bg-white p-3 rounded-xl">
                <QRCodeSVG
                  value={walletAddress || ""}
                  size={160}
                  level="H"
                  includeMargin={true}
                />
              </div>
              <p className="mt-2 text-xs text-muted">
                Scan to send {evmNativeSymbol} to this wallet
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-muted">Balance</label>
                <button
                  onClick={fetchBalance}
                  disabled={balanceLoading}
                  className="text-xs text-accent hover:text-accent-light transition-colors"
                >
                  {balanceLoading ? "..." : "Refresh"}
                </button>
              </div>
              <div className="bg-background border border-card-border rounded-lg p-3">
                <span className="text-xl font-bold">
                  {balanceLoading ? (
                    <span className="text-muted">Loading...</span>
                  ) : balanceError ? (
                    <span className="text-danger">Error</span>
                  ) : (
                    `${parseFloat(balance || "0").toFixed(4)} ${evmNativeSymbol}`
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Auth Actions */}
      {!user ? (
        <button
          onClick={() => login()}
          className="w-full bg-accent hover:bg-accent/80 text-white py-3 rounded-lg font-medium transition-all"
        >
          Connect Wallet
        </button>
      ) : (
        <button
          onClick={() => logout()}
          className="w-full bg-danger/10 hover:bg-danger/20 text-danger border border-danger/20 py-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Disconnect Wallet
        </button>
      )}
    </div>
  );
}
