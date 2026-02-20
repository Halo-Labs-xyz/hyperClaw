const DEFAULT_MAINNET_EXPLORER = "https://monadvision.com";
const DEFAULT_TESTNET_EXPLORER = "https://testnet.monadexplorer.com";

function trimUrl(value: string | undefined, fallback: string): string {
  return value?.trim().replace(/\/+$/, "") || fallback;
}

function getExplorerBase(network: "mainnet" | "testnet" = "mainnet"): string {
  if (network === "testnet") {
    return trimUrl(
      process.env.NEXT_PUBLIC_EVM_TESTNET_EXPLORER_URL,
      trimUrl(process.env.NEXT_PUBLIC_MONAD_TESTNET_EXPLORER_URL, DEFAULT_TESTNET_EXPLORER)
    );
  }
  return trimUrl(
    process.env.NEXT_PUBLIC_EVM_MAINNET_EXPLORER_URL,
    trimUrl(process.env.NEXT_PUBLIC_MONAD_MAINNET_EXPLORER_URL, DEFAULT_MAINNET_EXPLORER)
  );
}

export function buildEvmExplorerTxUrl(
  txHash: string,
  network: "mainnet" | "testnet" = "mainnet"
): string {
  return `${getExplorerBase(network)}/tx/${txHash}`;
}

export const buildMonadVisionTxUrl = buildEvmExplorerTxUrl;
