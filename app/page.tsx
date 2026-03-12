"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIdentityToken, usePrivy } from "@privy-io/react-auth";
import { useAccount, useChainId, useSignMessage } from "wagmi";
import { HyperclawIcon } from "@/app/components/HyperclawIcon";
import { HyperclawLogo } from "@/app/components/HyperclawLogo";

type FrontdoorBootstrap = {
  enabled: boolean;
  require_privy: boolean;
  privy_app_id?: string;
  privy_client_id?: string;
  poll_interval_ms?: number;
  mandatory_steps?: string[];
};

type FrontdoorChallengeResponse = {
  session_id: string;
  wallet_address: string;
  message: string;
  expires_at: string;
  version: number;
};

type FrontdoorVerifyResponse = {
  session_id: string;
  status: string;
  detail: string;
};

type FrontdoorSessionResponse = {
  session_id: string;
  wallet_address: string;
  privy_user_id?: string;
  version: number;
  status: string;
  detail: string;
  instance_url?: string | null;
  verify_url?: string | null;
  launch_url?: string | null;
  launch_blocked?: boolean;
  launch_blocked_reason?: string | null;
  eigen_app_id?: string | null;
  error?: string | null;
  profile_name?: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

type StoredSession = {
  sessionId: string;
  version: number;
  launchUrl: string;
  profileName: string;
  updatedAt: string;
};

type ProvisionState = "idle" | "signing" | "provisioning" | "ready" | "failed";

type FrontdoorFormState = {
  profileName: string;
  hyperliquidNetwork: string;
  paperLivePolicy: string;
  hyperliquidApiBaseUrl: string;
  hyperliquidWsUrl: string;
  requestTimeoutMs: string;
  maxRetries: string;
  retryBackoffMs: string;
  maxPositionUsd: string;
  leverageCap: string;
  maxAllocationUsd: string;
  perTradeCapUsd: string;
  maxLeverage: string;
  maxSlippageBps: string;
  symbolAllowlist: string;
  symbolDenylist: string;
  custodyMode: string;
  operatorWalletAddress: string;
  userWalletAddress: string;
  vaultAddress: string;
  informationSharingScope: string;
  killSwitchEnabled: boolean;
  killSwitchBehavior: string;
  enableMemory: boolean;
  gatewayAuthKey: string;
  eigencloudAuthKey: string;
  verificationBackend: string;
  verificationEigencloudEndpoint: string;
  verificationEigencloudAuthScheme: string;
  verificationEigencloudTimeoutMs: string;
  verificationFallbackEnabled: boolean;
  verificationFallbackSigningKeyId: string;
  verificationFallbackChainPath: string;
  verificationFallbackRequireSignedReceipts: boolean;
  acceptTerms: boolean;
};

function randomGatewayAuthKey(): string {
  if (typeof window === "undefined" || !window.crypto?.getRandomValues) {
    return `lc_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += alphabet[byte % alphabet.length];
  }
  return `lc_${out}`;
}

function defaultFormState(): FrontdoorFormState {
  return {
    profileName: "",
    hyperliquidNetwork: "testnet",
    paperLivePolicy: "paper_first",
    hyperliquidApiBaseUrl: "",
    hyperliquidWsUrl: "",
    requestTimeoutMs: "15000",
    maxRetries: "3",
    retryBackoffMs: "1000",
    maxPositionUsd: "10000",
    leverageCap: "5",
    maxAllocationUsd: "5000",
    perTradeCapUsd: "500",
    maxLeverage: "3",
    maxSlippageBps: "80",
    symbolAllowlist: "BTC,ETH,SOL",
    symbolDenylist: "",
    custodyMode: "user_wallet",
    operatorWalletAddress: "",
    userWalletAddress: "",
    vaultAddress: "",
    informationSharingScope: "signals_only",
    killSwitchEnabled: true,
    killSwitchBehavior: "cancel_and_flatten",
    enableMemory: true,
    gatewayAuthKey: randomGatewayAuthKey(),
    eigencloudAuthKey: "",
    verificationBackend: "eigencloud_primary",
    verificationEigencloudEndpoint: "",
    verificationEigencloudAuthScheme: "bearer",
    verificationEigencloudTimeoutMs: "5000",
    verificationFallbackEnabled: true,
    verificationFallbackSigningKeyId: "",
    verificationFallbackChainPath: "",
    verificationFallbackRequireSignedReceipts: true,
    acceptTerms: false,
  };
}

function parseIntegerField(label: string, raw: string, min: number, max: number): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid number`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseSymbols(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item.length > 0);
}

function normalizeOptionalWallet(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^0x[a-f0-9]{40}$/.test(trimmed)) {
    throw new Error("Wallet addresses must be 0x-prefixed 40-hex values");
  }
  return trimmed;
}

function buildFrontdoorConfig(form: FrontdoorFormState, connectedWallet: string) {
  const profileName = form.profileName.trim();
  if (!profileName) throw new Error("Profile name is required");
  if (profileName.length > 64) throw new Error("Profile name must be 64 chars or less");

  const symbolAllowlist = parseSymbols(form.symbolAllowlist);
  if (symbolAllowlist.length === 0) {
    throw new Error("Symbol allowlist must contain at least one market");
  }

  const symbolDenylist = parseSymbols(form.symbolDenylist);
  const custodyMode = form.custodyMode;
  if (!["operator_wallet", "user_wallet", "dual_mode"].includes(custodyMode)) {
    throw new Error("Invalid custody mode");
  }

  const operatorWalletAddress = normalizeOptionalWallet(form.operatorWalletAddress);
  const connected = normalizeOptionalWallet(connectedWallet);
  if (!connected) throw new Error("Connected wallet unavailable");

  let userWalletAddress = normalizeOptionalWallet(form.userWalletAddress) ?? null;
  if (custodyMode === "user_wallet" || custodyMode === "dual_mode") {
    userWalletAddress = userWalletAddress ?? connected;
    if (!userWalletAddress) {
      throw new Error("User wallet is required for selected custody mode");
    }
    if (userWalletAddress !== connected) {
      throw new Error("User wallet must match the connected wallet");
    }
  }

  if ((custodyMode === "operator_wallet" || custodyMode === "dual_mode") && !operatorWalletAddress) {
    throw new Error("Operator wallet is required for selected custody mode");
  }

  const gatewayAuthKey = form.gatewayAuthKey.trim();
  if (gatewayAuthKey.length < 16 || gatewayAuthKey.length > 128 || /\s/.test(gatewayAuthKey)) {
    throw new Error("Gateway auth key must be 16-128 characters with no whitespace");
  }

  const verificationBackend = form.verificationBackend.trim();
  if (!["eigencloud_primary", "fallback_only"].includes(verificationBackend)) {
    throw new Error("Verification backend must be eigencloud_primary or fallback_only");
  }
  if (verificationBackend === "fallback_only" && !form.verificationFallbackEnabled) {
    throw new Error("Fallback verification must be enabled for fallback_only backend");
  }

  if (!["bearer", "api_key"].includes(form.verificationEigencloudAuthScheme)) {
    throw new Error("Verification auth scheme must be bearer or api_key");
  }

  if (!form.acceptTerms) {
    throw new Error("Risk acknowledgement is required");
  }

  const maxAllocationUsd = parseIntegerField("Max allocation", form.maxAllocationUsd, 1, 10_000_000);
  const perTradeCapUsd = parseIntegerField("Per trade cap", form.perTradeCapUsd, 1, 10_000_000);
  const leverageCap = parseIntegerField("Leverage cap", form.leverageCap, 1, 20);
  const maxLeverage = parseIntegerField("Copy max leverage", form.maxLeverage, 1, 20);
  if (perTradeCapUsd > maxAllocationUsd) {
    throw new Error("Per trade cap must be less than or equal to max allocation");
  }
  if (maxLeverage > leverageCap) {
    throw new Error("Copy max leverage must be less than or equal to leverage cap");
  }

  return {
    profile_name: profileName,
    hyperliquid_network: form.hyperliquidNetwork,
    paper_live_policy: form.paperLivePolicy,
    hyperliquid_api_base_url: form.hyperliquidApiBaseUrl.trim() || null,
    hyperliquid_ws_url: form.hyperliquidWsUrl.trim() || null,
    request_timeout_ms: parseIntegerField("Request timeout", form.requestTimeoutMs, 1000, 120000),
    max_retries: parseIntegerField("Max retries", form.maxRetries, 0, 10),
    retry_backoff_ms: parseIntegerField("Retry backoff", form.retryBackoffMs, 0, 30000),
    max_position_size_usd: parseIntegerField("Max position size", form.maxPositionUsd, 1, 10_000_000),
    leverage_cap: leverageCap,
    max_allocation_usd: maxAllocationUsd,
    per_trade_notional_cap_usd: perTradeCapUsd,
    max_leverage: maxLeverage,
    max_slippage_bps: parseIntegerField("Max slippage", form.maxSlippageBps, 1, 5000),
    symbol_allowlist: symbolAllowlist,
    symbol_denylist: symbolDenylist,
    custody_mode: custodyMode,
    operator_wallet_address: operatorWalletAddress,
    user_wallet_address: userWalletAddress,
    vault_address: normalizeOptionalWallet(form.vaultAddress),
    information_sharing_scope: form.informationSharingScope,
    kill_switch_enabled: form.killSwitchEnabled,
    kill_switch_behavior: form.killSwitchBehavior,
    enable_memory: form.enableMemory,
    gateway_auth_key: gatewayAuthKey,
    eigencloud_auth_key: form.eigencloudAuthKey.trim() || null,
    verification_backend: verificationBackend,
    verification_eigencloud_endpoint: form.verificationEigencloudEndpoint.trim() || null,
    verification_eigencloud_auth_scheme: form.verificationEigencloudAuthScheme,
    verification_eigencloud_timeout_ms: parseIntegerField(
      "Verification timeout",
      form.verificationEigencloudTimeoutMs,
      1,
      120000
    ),
    verification_fallback_enabled: form.verificationFallbackEnabled,
    verification_fallback_signing_key_id: form.verificationFallbackSigningKeyId.trim() || null,
    verification_fallback_chain_path: form.verificationFallbackChainPath.trim() || null,
    verification_fallback_require_signed_receipts: form.verificationFallbackRequireSignedReceipts,
    accept_terms: form.acceptTerms,
  };
}

async function readJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const message =
      (typeof payload.error === "string" && payload.error) ||
      (typeof payload.detail === "string" && payload.detail) ||
      (typeof payload.message === "string" && payload.message) ||
      `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload as T;
}

export default function FrontdoorLauncher() {
  const { ready, authenticated, login, linkWallet, user, getAccessToken } = usePrivy();
  const { identityToken } = useIdentityToken();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();

  const [bootstrap, setBootstrap] = useState<FrontdoorBootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [form, setForm] = useState<FrontdoorFormState>(() => defaultFormState());
  const [provisionState, setProvisionState] = useState<ProvisionState>("idle");
  const [provisionMessage, setProvisionMessage] = useState("Waiting for signature");
  const [progress, setProgress] = useState(8);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<FrontdoorSessionResponse | null>(null);
  const [lastSession, setLastSession] = useState<StoredSession | null>(null);

  const pollTimerRef = useRef<number | null>(null);
  const redirectTimerRef = useRef<number | null>(null);

  const normalizedAddress = address?.toLowerCase() ?? "";
  const sessionStorageKey = useMemo(() => {
    if (!user?.id || !normalizedAddress) return null;
    return `hyperclaw-frontdoor:${user.id}:${normalizedAddress}`;
  }, [normalizedAddress, user?.id]);

  const stopTimers = useCallback(() => {
    if (pollTimerRef.current) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (redirectTimerRef.current) {
      window.clearTimeout(redirectTimerRef.current);
      redirectTimerRef.current = null;
    }
  }, []);

  const persistSession = useCallback(
    (session: FrontdoorSessionResponse) => {
      if (!sessionStorageKey || !session.launch_url || typeof window === "undefined") return;
      const stored: StoredSession = {
        sessionId: session.session_id,
        version: session.version,
        launchUrl: session.launch_url,
        profileName: session.profile_name ?? form.profileName,
        updatedAt: session.updated_at,
      };
      window.localStorage.setItem(sessionStorageKey, JSON.stringify(stored));
      setLastSession(stored);
    },
    [form.profileName, sessionStorageKey]
  );

  const pollSession = useCallback(
    (sessionId: string) => {
      stopTimers();
      const intervalMs = bootstrap?.poll_interval_ms ?? 1500;

      const run = async () => {
        try {
          const session = await readJson<FrontdoorSessionResponse>(
            `/api/liquidclaw/frontdoor/session/${encodeURIComponent(sessionId)}`
          );
          setActiveSession(session);

          if (session.launch_blocked) {
            setProvisionState("failed");
            setLaunchError(
              session.launch_blocked_reason ??
                "Destination URL is blocked by redirect allowlist"
            );
            return;
          }

          if (session.status === "ready" && session.launch_url) {
            setProgress(100);
            setProvisionState("ready");
            setProvisionMessage("Enclave ready. Redirecting to your private instance...");
            persistSession(session);
            redirectTimerRef.current = window.setTimeout(() => {
              window.location.assign(session.launch_url as string);
            }, 1400);
            return;
          }

          if (session.status === "failed" || session.status === "expired") {
            setProvisionState("failed");
            setLaunchError(session.error ?? session.detail ?? "Provisioning failed");
            return;
          }

          setProvisionState("provisioning");
          setProvisionMessage(session.detail || "Provisioning in progress...");
          setProgress((value) => Math.min(94, value + 11));
          pollTimerRef.current = window.setTimeout(run, intervalMs);
        } catch (error) {
          setProvisionState("failed");
          setLaunchError(
            error instanceof Error
              ? error.message
              : "Unable to query provisioning session"
          );
        }
      };

      void run();
    },
    [bootstrap?.poll_interval_ms, persistSession, stopTimers]
  );

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const payload = await readJson<FrontdoorBootstrap>(
          "/api/liquidclaw/frontdoor/bootstrap"
        );
        if (cancelled) return;
        setBootstrap(payload);
        if (!payload.enabled) {
          setBootstrapError("Frontdoor provisioning is disabled on the target LiquidClaw gateway");
        }
      } catch (error) {
        if (cancelled) return;
        setBootstrapError(
          error instanceof Error ? error.message : "Unable to load frontdoor bootstrap"
        );
      }
    };

    void run();
    return () => {
      cancelled = true;
      stopTimers();
    };
  }, [stopTimers]);

  useEffect(() => {
    if (!sessionStorageKey || typeof window === "undefined") {
      setLastSession(null);
      return;
    }
    const raw = window.localStorage.getItem(sessionStorageKey);
    if (!raw) {
      setLastSession(null);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as StoredSession;
      if (parsed?.sessionId && parsed?.launchUrl) {
        setLastSession(parsed);
      } else {
        setLastSession(null);
      }
    } catch {
      setLastSession(null);
    }
  }, [sessionStorageKey]);

  useEffect(() => {
    if (!normalizedAddress) return;
    if (form.custodyMode === "user_wallet" || form.custodyMode === "dual_mode") {
      setForm((prev) => ({ ...prev, userWalletAddress: normalizedAddress }));
    }
  }, [form.custodyMode, normalizedAddress]);

  const onFieldChange = useCallback(
    (field: keyof FrontdoorFormState, value: string | boolean) => {
      setForm((prev) => ({
        ...prev,
        [field]: value,
      }));
    },
    []
  );

  const handleConnectWallet = useCallback(() => {
    if (authenticated) {
      linkWallet();
      return;
    }
    login();
  }, [authenticated, linkWallet, login]);

  const handleLaunch = useCallback(async () => {
    try {
      setLaunchError(null);
      if (!bootstrap?.enabled) {
        throw new Error("Frontdoor is not enabled on gateway");
      }
      if (!normalizedAddress || !isConnected) {
        throw new Error("Connect wallet before launching");
      }

      const privyUserId = user?.id ?? null;
      if (bootstrap.require_privy) {
        if (!authenticated || !privyUserId) {
          throw new Error("Privy authentication is required before launch");
        }
      }

      const accessToken = bootstrap.require_privy
        ? await getAccessToken().catch(() => null)
        : null;
      if (bootstrap.require_privy && !identityToken && !accessToken) {
        throw new Error("Privy identity token unavailable. Reauthenticate wallet session");
      }

      const config = buildFrontdoorConfig(form, normalizedAddress);

      setProvisionState("signing");
      setProvisionMessage("Creating launch challenge...");
      setProgress(18);

      const challenge = await readJson<FrontdoorChallengeResponse>(
        "/api/liquidclaw/frontdoor/challenge",
        {
          method: "POST",
          body: JSON.stringify({
            wallet_address: normalizedAddress,
            privy_user_id: privyUserId,
            chain_id: Number.isFinite(chainId) ? chainId : null,
          }),
        }
      );

      setProvisionMessage("Challenge issued. Confirm signature in your wallet...");
      setProgress(34);

      const signature = await signMessageAsync({ message: challenge.message });

      setProvisionMessage("Signature accepted. Spinning up your enclave...");
      setProgress(48);

      const verify = await readJson<FrontdoorVerifyResponse>(
        "/api/liquidclaw/frontdoor/verify",
        {
          method: "POST",
          body: JSON.stringify({
            session_id: challenge.session_id,
            wallet_address: normalizedAddress,
            privy_user_id: privyUserId,
            privy_identity_token: identityToken ?? null,
            privy_access_token: accessToken ?? null,
            message: challenge.message,
            signature,
            config,
          }),
        }
      );

      setProvisionState("provisioning");
      setProvisionMessage(verify.detail || "Provisioning submitted");
      setProgress(58);
      setActiveSession((prev) => ({
        session_id: challenge.session_id,
        wallet_address: normalizedAddress,
        version: challenge.version,
        status: verify.status || prev?.status || "provisioning",
        detail: verify.detail || "Provisioning submitted",
        created_at: prev?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: challenge.expires_at,
      }));
      pollSession(challenge.session_id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Launch flow failed unexpectedly";
      setProvisionState("failed");
      setLaunchError(message);
    }
  }, [
    authenticated,
    bootstrap?.enabled,
    bootstrap?.require_privy,
    chainId,
    form,
    getAccessToken,
    identityToken,
    isConnected,
    normalizedAddress,
    pollSession,
    signMessageAsync,
    user?.id,
  ]);

  const handleUseLastSession = useCallback(() => {
    if (!lastSession?.launchUrl) return;
    window.location.assign(lastSession.launchUrl);
  }, [lastSession?.launchUrl]);

  const canLaunch =
    ready &&
    bootstrap?.enabled &&
    isConnected &&
    Boolean(normalizedAddress) &&
    form.acceptTerms &&
    provisionState !== "signing" &&
    provisionState !== "provisioning";

  if (!ready) {
    return (
      <div className="min-h-screen page-bg flex items-center justify-center px-6">
        <div className="glass-card p-8 w-full max-w-md text-center">
          <div className="mx-auto w-12 h-12 rounded-xl bg-accent/10 border border-accent/30 flex items-center justify-center mb-4">
            <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          </div>
          <p className="text-sm text-muted">Loading frontdoor provisioning state...</p>
        </div>
      </div>
    );
  }

  if (!bootstrap && bootstrapError) {
    return (
      <div className="min-h-screen page-bg flex items-center justify-center px-6">
        <div className="glass-card p-8 w-full max-w-lg text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-danger mb-3">Frontdoor Unavailable</p>
          <p className="text-sm text-muted mb-5">{bootstrapError}</p>
          <button
            type="button"
            className="btn-secondary px-4 py-2 text-sm"
            onClick={() => {
              window.location.reload();
            }}
          >
            Retry Bootstrap
          </button>
        </div>
      </div>
    );
  }

  if (!bootstrap) {
    return (
      <div className="min-h-screen page-bg flex items-center justify-center px-6">
        <div className="glass-card p-8 w-full max-w-md text-center">
          <div className="mx-auto w-12 h-12 rounded-xl bg-accent/10 border border-accent/30 flex items-center justify-center mb-4">
            <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          </div>
          <p className="text-sm text-muted">Loading frontdoor provisioning state...</p>
        </div>
      </div>
    );
  }

  if (provisionState === "signing" || provisionState === "provisioning" || provisionState === "ready") {
    return (
      <ProvisioningScreen
        message={provisionMessage}
        progress={progress}
        session={activeSession}
        state={provisionState}
        error={launchError}
      />
    );
  }

  return (
    <div className="min-h-screen page-bg relative overflow-hidden">
      <div className="orb orb-green w-[620px] h-[620px] -top-[260px] -right-[200px] fixed" />
      <div className="orb orb-purple w-[540px] h-[540px] top-[58%] -left-[240px] fixed" />

      <header className="glass sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-lg bg-white/20 border border-white/30 flex items-center justify-center">
              <HyperclawIcon className="text-accent" size={28} />
            </div>
            <HyperclawLogo className="text-lg font-bold tracking-tight" />
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wider text-dim">Live Eigen Build</p>
            <p className="text-xs text-muted">Wallet + Signature + Enclave Provisioning</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12 relative z-10">
        <section className="mb-6">
          <div className="gradient-border">
            <div className="p-6 rounded-2xl">
              <p className="text-xs uppercase tracking-[0.2em] text-accent mb-3">Mandatory Launch Sequence</p>
              <h1 className="text-3xl sm:text-4xl font-bold gradient-title mb-3">
                Connect. Sign. Launch Your Personal Enclave.
              </h1>
              <p className="text-sm sm:text-base text-muted max-w-3xl">
                This gateway only handles identity and mandatory controls. After signature verification,
                your dedicated LiquidClaw enclave is provisioned and you are redirected to your live instance URL.
              </p>
            </div>
          </div>
        </section>

        {bootstrapError && (
          <section className="mb-6">
            <div className="card border border-danger/40 bg-danger/5 rounded-2xl p-4 text-sm text-danger">
              {bootstrapError}
            </div>
          </section>
        )}

        {launchError && (
          <section className="mb-6">
            <div className="card border border-danger/40 bg-danger/5 rounded-2xl p-4 text-sm text-danger">
              {launchError}
            </div>
          </section>
        )}

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <div className="glass-card p-5">
            <p className="text-xs uppercase tracking-[0.2em] text-accent mb-3">Step 1</p>
            <h2 className="text-lg font-semibold mb-2">Connect Wallet + Privy Identity</h2>
            <p className="text-sm text-muted mb-4">
              Wallet connection is required. Privy authentication is enforced by gateway policy when enabled.
            </p>

            <div className="space-y-2 text-sm">
              <StatusRow
                label="Wallet"
                value={isConnected && normalizedAddress ? `${normalizedAddress.slice(0, 6)}...${normalizedAddress.slice(-4)}` : "Not connected"}
                tone={isConnected && normalizedAddress ? "success" : "muted"}
              />
              <StatusRow
                label="Privy"
                value={authenticated && user?.id ? user.id : bootstrap.require_privy ? "Required, not authenticated" : "Optional"}
                tone={authenticated && user?.id ? "success" : bootstrap.require_privy ? "danger" : "muted"}
              />
              <StatusRow
                label="Chain"
                value={Number.isFinite(chainId) ? String(chainId) : "Unknown"}
                tone="muted"
              />
            </div>

            <button
              type="button"
              onClick={handleConnectWallet}
              className="btn-primary px-5 py-2.5 text-sm mt-4"
            >
              {authenticated ? "Link / Switch Wallet" : "Connect Wallet"}
            </button>

            {lastSession && (
              <div className="mt-4 p-3 rounded-xl bg-background border border-card-border">
                <p className="text-[11px] uppercase tracking-wider text-dim mb-2">Last Provisioned Session</p>
                <p className="text-xs text-muted mb-1">Profile: {lastSession.profileName || "n/a"}</p>
                <p className="text-xs text-muted mb-1">Version: v{lastSession.version}</p>
                <p className="text-xs text-muted mb-3">Updated: {new Date(lastSession.updatedAt).toLocaleString()}</p>
                <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={handleUseLastSession}>
                  Resume Last Enclave
                </button>
              </div>
            )}
          </div>

          <div className="glass-card p-5">
            <p className="text-xs uppercase tracking-[0.2em] text-accent mb-3">Step 2</p>
            <h2 className="text-lg font-semibold mb-2">Mandatory Runtime Configuration</h2>
            <p className="text-sm text-muted mb-4">
              These controls are enforced before enclave provisioning. Advanced settings remain editable in-instance.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="Profile Name"
                value={form.profileName}
                onChange={(value) => onFieldChange("profileName", value)}
                placeholder="team-alpha"
              />
              <TextField
                label="Gateway Auth Key"
                value={form.gatewayAuthKey}
                onChange={(value) => onFieldChange("gatewayAuthKey", value)}
                placeholder="16-128 chars"
              />
              <SelectField
                label="Hyperliquid Network"
                value={form.hyperliquidNetwork}
                onChange={(value) => onFieldChange("hyperliquidNetwork", value)}
                options={[
                  { value: "testnet", label: "Testnet" },
                  { value: "mainnet", label: "Mainnet" },
                ]}
              />
              <SelectField
                label="Policy"
                value={form.paperLivePolicy}
                onChange={(value) => onFieldChange("paperLivePolicy", value)}
                options={[
                  { value: "paper_only", label: "Paper Only" },
                  { value: "paper_first", label: "Paper First" },
                  { value: "live_allowed", label: "Live Allowed" },
                ]}
              />
              <TextField
                label="Request Timeout (ms)"
                value={form.requestTimeoutMs}
                onChange={(value) => onFieldChange("requestTimeoutMs", value)}
              />
              <TextField
                label="Max Retries"
                value={form.maxRetries}
                onChange={(value) => onFieldChange("maxRetries", value)}
              />
              <TextField
                label="Retry Backoff (ms)"
                value={form.retryBackoffMs}
                onChange={(value) => onFieldChange("retryBackoffMs", value)}
              />
              <TextField
                label="Max Position USD"
                value={form.maxPositionUsd}
                onChange={(value) => onFieldChange("maxPositionUsd", value)}
              />
              <TextField
                label="Max Allocation USD"
                value={form.maxAllocationUsd}
                onChange={(value) => onFieldChange("maxAllocationUsd", value)}
              />
              <TextField
                label="Per Trade Cap USD"
                value={form.perTradeCapUsd}
                onChange={(value) => onFieldChange("perTradeCapUsd", value)}
              />
              <TextField
                label="Leverage Cap"
                value={form.leverageCap}
                onChange={(value) => onFieldChange("leverageCap", value)}
              />
              <TextField
                label="Copy Max Leverage"
                value={form.maxLeverage}
                onChange={(value) => onFieldChange("maxLeverage", value)}
              />
              <TextField
                label="Max Slippage (bps)"
                value={form.maxSlippageBps}
                onChange={(value) => onFieldChange("maxSlippageBps", value)}
              />
              <TextField
                label="Allowlist Symbols"
                value={form.symbolAllowlist}
                onChange={(value) => onFieldChange("symbolAllowlist", value)}
                placeholder="BTC,ETH,SOL"
              />
              <TextField
                label="Denylist Symbols"
                value={form.symbolDenylist}
                onChange={(value) => onFieldChange("symbolDenylist", value)}
                placeholder="Optional"
              />
              <SelectField
                label="Custody Mode"
                value={form.custodyMode}
                onChange={(value) => onFieldChange("custodyMode", value)}
                options={[
                  { value: "user_wallet", label: "User Wallet" },
                  { value: "operator_wallet", label: "Operator Wallet" },
                  { value: "dual_mode", label: "Dual Mode" },
                ]}
              />
              <TextField
                label="Operator Wallet"
                value={form.operatorWalletAddress}
                onChange={(value) => onFieldChange("operatorWalletAddress", value)}
                placeholder="Required for operator/dual"
              />
              <TextField
                label="User Wallet"
                value={form.userWalletAddress}
                onChange={(value) => onFieldChange("userWalletAddress", value)}
                disabled={form.custodyMode === "user_wallet" || form.custodyMode === "dual_mode"}
              />
              <TextField
                label="Vault Address"
                value={form.vaultAddress}
                onChange={(value) => onFieldChange("vaultAddress", value)}
                placeholder="Optional"
              />
              <SelectField
                label="Info Sharing"
                value={form.informationSharingScope}
                onChange={(value) => onFieldChange("informationSharingScope", value)}
                options={[
                  { value: "none", label: "None" },
                  { value: "signals_only", label: "Signals Only" },
                  { value: "signals_and_execution", label: "Signals + Execution" },
                  { value: "full_audit", label: "Full Audit" },
                ]}
              />
              <SelectField
                label="Kill Switch"
                value={form.killSwitchBehavior}
                onChange={(value) => onFieldChange("killSwitchBehavior", value)}
                options={[
                  { value: "pause_agent", label: "Pause Agent" },
                  { value: "cancel_open_orders", label: "Cancel Open Orders" },
                  { value: "cancel_and_flatten", label: "Cancel + Flatten" },
                ]}
              />
              <SelectField
                label="Verification Backend"
                value={form.verificationBackend}
                onChange={(value) => onFieldChange("verificationBackend", value)}
                options={[
                  { value: "eigencloud_primary", label: "EigenCloud Primary" },
                  { value: "fallback_only", label: "Fallback Only" },
                ]}
              />
              <SelectField
                label="Eigen Auth Scheme"
                value={form.verificationEigencloudAuthScheme}
                onChange={(value) => onFieldChange("verificationEigencloudAuthScheme", value)}
                options={[
                  { value: "bearer", label: "Bearer" },
                  { value: "api_key", label: "API Key" },
                ]}
              />
              <TextField
                label="Verification Timeout (ms)"
                value={form.verificationEigencloudTimeoutMs}
                onChange={(value) => onFieldChange("verificationEigencloudTimeoutMs", value)}
              />
              <TextField
                label="Eigen Endpoint"
                value={form.verificationEigencloudEndpoint}
                onChange={(value) => onFieldChange("verificationEigencloudEndpoint", value)}
                placeholder="Optional"
              />
              <TextField
                label="Eigen Auth Key"
                value={form.eigencloudAuthKey}
                onChange={(value) => onFieldChange("eigencloudAuthKey", value)}
                placeholder="Optional"
              />
              <TextField
                label="HL REST URL"
                value={form.hyperliquidApiBaseUrl}
                onChange={(value) => onFieldChange("hyperliquidApiBaseUrl", value)}
                placeholder="Optional"
              />
              <TextField
                label="HL WS URL"
                value={form.hyperliquidWsUrl}
                onChange={(value) => onFieldChange("hyperliquidWsUrl", value)}
                placeholder="Optional"
              />
              <TextField
                label="Fallback Signing Key"
                value={form.verificationFallbackSigningKeyId}
                onChange={(value) => onFieldChange("verificationFallbackSigningKeyId", value)}
                placeholder="Optional"
              />
              <TextField
                label="Fallback Chain Path"
                value={form.verificationFallbackChainPath}
                onChange={(value) => onFieldChange("verificationFallbackChainPath", value)}
                placeholder="Optional"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
              <CheckboxField
                label="Enable kill switch"
                checked={form.killSwitchEnabled}
                onChange={(checked) => onFieldChange("killSwitchEnabled", checked)}
              />
              <CheckboxField
                label="Enable memory"
                checked={form.enableMemory}
                onChange={(checked) => onFieldChange("enableMemory", checked)}
              />
              <CheckboxField
                label="Enable fallback verification"
                checked={form.verificationFallbackEnabled}
                onChange={(checked) => onFieldChange("verificationFallbackEnabled", checked)}
              />
              <CheckboxField
                label="Require signed fallback receipts"
                checked={form.verificationFallbackRequireSignedReceipts}
                onChange={(checked) =>
                  onFieldChange("verificationFallbackRequireSignedReceipts", checked)
                }
              />
            </div>

            <div className="mt-4 p-3 rounded-xl bg-background border border-card-border">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.acceptTerms}
                  onChange={(event) => onFieldChange("acceptTerms", event.target.checked)}
                />
                <span className="text-xs text-muted leading-relaxed">
                  I accept mandatory risk constraints and authorize enclave launch for this wallet session.
                </span>
              </label>
            </div>
          </div>
        </section>

        <section className="glass-card p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-accent mb-2">Step 3</p>
            <h3 className="text-lg font-semibold">Sign Launch Message And Provision Enclave</h3>
            <p className="text-sm text-muted">
              Launch signs one challenge message, provisions a new versioned enclave, then redirects to its live URL.
            </p>
          </div>
          <button
            type="button"
            disabled={!canLaunch}
            onClick={() => {
              void handleLaunch();
            }}
            className="btn-primary px-6 py-3 text-sm whitespace-nowrap"
          >
            Launch Personal Enclave
          </button>
        </section>
      </main>
    </div>
  );
}

function ProvisioningScreen({
  state,
  progress,
  message,
  session,
  error,
}: {
  state: ProvisionState;
  progress: number;
  message: string;
  session: FrontdoorSessionResponse | null;
  error: string | null;
}) {
  const pulses = ["Booting runtime", "Applying policy", "Sealing enclave", "Finalizing URL"];
  const pulse = pulses[Math.floor((Date.now() / 900) % pulses.length)] ?? "Provisioning";

  return (
    <div className="min-h-screen page-bg relative overflow-hidden flex items-center justify-center px-4">
      <div className="orb orb-green w-[520px] h-[520px] -top-[140px] -right-[180px] fixed" />
      <div className="orb orb-purple w-[460px] h-[460px] -bottom-[120px] -left-[160px] fixed" />

      <div className="w-full max-w-2xl glass-card p-8 rounded-3xl relative z-10">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-12 h-12 rounded-xl bg-accent/10 border border-accent/30 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-accent">Enclaved Interface</p>
            <h2 className="text-2xl font-bold gradient-title">{state === "ready" ? "Launch Ready" : "Provisioning"}</h2>
          </div>
        </div>

        <p className="text-sm text-muted mb-3">{message}</p>
        <p className="text-xs text-dim mb-6">{pulse}</p>

        <div className="w-full h-3 rounded-full bg-background border border-card-border overflow-hidden mb-6">
          <div
            className="h-full bg-gradient-to-r from-[#30e8a0] via-[#836ef9] to-[#4af0ff] transition-all duration-500"
            style={{ width: `${Math.max(6, Math.min(100, progress))}%` }}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs mb-4">
          <DetailRow label="Session" value={session?.session_id ?? "pending"} />
          <DetailRow label="Version" value={session?.version ? `v${session.version}` : "pending"} />
          <DetailRow label="Wallet" value={session?.wallet_address ?? "pending"} />
          <DetailRow label="Status" value={session?.status ?? state} />
        </div>

        {session?.launch_url && state === "ready" && (
          <a href={session.launch_url} className="btn-secondary px-4 py-2 text-xs inline-flex">
            Open Instance Now
          </a>
        )}

        {error && <p className="text-xs text-danger mt-4">{error}</p>}
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-dim mb-1 block">{label}</span>
      <input
        className="input w-full px-3 py-2 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-dim mb-1 block">{label}</span>
      <select
        className="input w-full px-3 py-2 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted cursor-pointer px-2 py-2 rounded-lg border border-card-border bg-background">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "success" | "danger" | "muted";
}) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-muted";

  return (
    <div className="flex items-center justify-between rounded-lg border border-card-border bg-background px-3 py-2">
      <span className="text-[11px] uppercase tracking-wider text-dim">{label}</span>
      <span className={`text-xs font-mono ${toneClass}`}>{value}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-card-border bg-background px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-dim mb-1">{label}</p>
      <p className="font-mono text-[11px] text-muted break-all">{value}</p>
    </div>
  );
}
