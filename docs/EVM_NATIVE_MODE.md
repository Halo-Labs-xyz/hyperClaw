# EVM Native Mode

HyperClaw now supports EVM-native configuration without Monad-only requirements.

## What Changed

- Network state now supports `evmTestnet` as the canonical flag.
- `monadTestnet` remains supported as a backward-compatible alias.
- x402 validation now supports `X402_CHAIN_ID` as the canonical chain selector.
- Agent attestation now supports:
  - `EVM_AGENT_ATTESTATION_ENABLED`
  - `EVM_AGENT_ATTESTATION_REQUIRED`
  - `RELAY_EVM_PRIVATE_KEY`
  - `EVM_PRIVATE_KEY`
- Existing Monad variables continue to work as fallback aliases.

## API Compatibility

- `POST /api/network` accepts:
  - `evmTestnet`
  - `monadTestnet` (alias)
  - `hlTestnet`
  - `testnet` (sets both EVM and HL flags)
- `GET /api/network` returns both `evmTestnet` and `monadTestnet` for compatibility.

## Recommended Env Variables

- `NEXT_PUBLIC_EVM_TESTNET`
- `NEXT_PUBLIC_EVM_MAINNET_CHAIN_ID`
- `NEXT_PUBLIC_EVM_TESTNET_CHAIN_ID`
- `NEXT_PUBLIC_EVM_MAINNET_RPC_URL`
- `NEXT_PUBLIC_EVM_TESTNET_RPC_URL`
- `NEXT_PUBLIC_EVM_MAINNET_EXPLORER_URL`
- `NEXT_PUBLIC_EVM_TESTNET_EXPLORER_URL`
- `EVM_PRIVATE_KEY`
- `RELAY_EVM_PRIVATE_KEY`
- `X402_CHAIN_ID`
- `EVM_AGENT_ATTESTATION_ENABLED`
- `EVM_AGENT_ATTESTATION_REQUIRED`

## Migration Notes

- No immediate rename is required for existing deployments.
- Existing `MONAD_*` and `X402_MONAD_CHAIN_ID` values continue to resolve correctly.
