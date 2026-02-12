# Unit Protocol — Mainnet Key Information

Reference for Unit protocol treasury addresses, fee payers, and guardian keys. Used by Hyperunit for Monad ↔ Hyperliquid bridge flows.

## Unit Treasury Addresses

User deposit/withdrawal transfers are fulfilled from Unit's respective treasury addresses.

| Native Chain | Native Chain Treasury Address | HyperCore Treasury Address |
|--------------|-------------------------------|----------------------------|
| Bitcoin | `bc1pdwu79dady576y3fupmm82m3g7p2p9f6hgyeqy0tdg7ztxg7xrayqlkl8j9` | `0x574bAFCe69d9411f662a433896e74e4F153096FA` |
| Ethereum | `0xBEa9f7FD27f4EE20066F18DEF0bc586eC221055A` | `0x8DAfBe89302656a7Df43c470e9EbCB4c540835c0` |
| Solana | `9SLPTL41SPsYkgdsMzdfJsxymEANKr5bYoBsQzJyKpKS` | `0xA822a9cEB6D6CB5b565bD10098AbCFA9Cf18D748` |
| Plasma | `0x8e88826F42A0f5f199a9c91C3798c626326730b4` | `0xE6111266AfdcdF0b1fE8505028cC1f7419d798a7` |
| Monad | `0x4213de5c3C01eB3D757e271D4BEBc999F996E3D5` | `0x24DE6B77e8bc31c40Aa452926daa6BBaB7a71B0f` |

## Unit Fee Payer Addresses

For ERC20 L0 deposits and withdrawals fulfilled by Unit fee payers.

| Chain | Fee Payer Address |
|-------|-------------------|
| Ethereum | `0xa8249e9B92FA94F8de8B016937E0b321C9a62874` |
| Hyperliquid | `0x1f6093D33DB935b2Ebd81D23312dA5F11759973E` |

## Guardian Public Keys

Address generation is attested by guardian signatures. Use these public keys to verify generated addresses.

| Guardian Name | Public Key |
|---------------|------------|
| unit-node | `04dc6f89f921dc816aa69b687be1fcc3cc1d48912629abc2c9964e807422e1047e0435cb5ba0fa53cb9a57a9c610b4e872a0a2caedda78c4f85ebafcca93524061` |
| hl-node | `048633ea6ab7e40cdacf37d1340057e84bb9810de0687af78d031e9b07b65ad4ab379180ab55075f5c2ebb96dab30d2c2fab49d5635845327b6a3c27d20ba4755b` |
| field-node | `04ae2ab20787f816ea5d13f36c4c4f7e196e29e867086f3ce818abb73077a237f841b33ada5be71b83f4af29f333dedc5411ca4016bd52ab657db2896ef374ce99` |

## Relation to HyperClaw

- **Hyperunit** (`HYPERUNIT_API_URL`) uses Unit protocol for Monad → Hyperliquid relay.
- Relay sends MON to Unit's **Monad native treasury** (`0x4213de5c3C01eB3D757e271D4BEBc999F996E3D5`); Unit fulfills to HyperCore.
- The `getHyperunitDestinationAddress` flow returns a protocol address derived from these treasuries.
- See `lib/mainnet-bridge.ts` for the bridge implementation.
