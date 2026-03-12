# LiquidClaw Frontdoor Onboarding (HyperClaw Main App)

This flow makes `hyperClaw/app/page.tsx` a strict launch gateway for user-specific LiquidClaw enclaves.

## Goal

Users only do three things in the main app:

1. Connect wallet with Privy.
2. Sign one launch challenge message.
3. Wait on provisioning, then auto-redirect into their personal enclave URL.

The live trading/settings interface is the spawned enclave instance, not the HyperClaw front page.

## Required Environment

Set these in HyperClaw runtime:

```bash
LIQUIDCLAW_FRONTDOOR_GATEWAY_BASE_URL=https://<liquidclaw-gateway-domain>
LIQUIDCLAW_FRONTDOOR_REDIRECT_ALLOWLIST=*.eigencloud.xyz,verify-sepolia.eigencloud.xyz
```

Notes:

- `LIQUIDCLAW_FRONTDOOR_GATEWAY_BASE_URL` points at the shared LiquidClaw gateway that exposes `/api/frontdoor/*`.
- `LIQUIDCLAW_FRONTDOOR_REDIRECT_ALLOWLIST` controls which hosts are allowed for final redirect destinations returned by frontdoor session polling.
- Wildcard suffixes are supported (`*.domain.tld`).

## API Bridge Added In HyperClaw

HyperClaw now proxies frontdoor requests through server routes:

- `GET /api/liquidclaw/frontdoor/bootstrap`
- `POST /api/liquidclaw/frontdoor/challenge`
- `POST /api/liquidclaw/frontdoor/verify`
- `GET /api/liquidclaw/frontdoor/session/[sessionId]`

Behavior:

- Proxies are `nodejs` runtime, `force-dynamic`, and `no-store`.
- Session polling route sanitizes `instance_url` and `verify_url` against `LIQUIDCLAW_FRONTDOOR_REDIRECT_ALLOWLIST`.
- Response includes `launch_url` and `launch_blocked` to enforce safe redirects client-side.

## Onboarding State Machine

`hyperClaw/app/page.tsx` now follows this sequence:

1. Fetch bootstrap from HyperClaw proxy.
2. Require wallet connection.
3. Require mandatory config fields and risk acknowledgement.
4. `POST /challenge` -> receive `session_id`, `message`, `version`.
5. Wallet signs `message`.
6. `POST /verify` with signature, Privy tokens, and config.
7. Poll `/session/{session_id}` until `ready`.
8. Show full-screen provisioning loader with live status.
9. Auto-redirect to `launch_url` when ready.

Session metadata is cached in browser local storage keyed by `privyUserId + wallet`, including latest version and launch URL.

## Local Verification

Run from `hyperClaw/`:

```bash
npm run lint
npm run dev
```

Manual checks:

1. Connect wallet.
2. Fill required config and accept terms.
3. Launch enclave and sign challenge.
4. Confirm loader progresses while polling.
5. Confirm redirect happens only for allowlisted hosts.
6. Confirm `Resume Last Enclave` appears after first successful launch.
