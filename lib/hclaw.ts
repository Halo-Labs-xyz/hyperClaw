import { createPublicClient, http, type Address, formatEther } from "viem";
import { HCLAW_TIERS, NADFUN_CONFIG, type HclawState, type HclawTier } from "./types";

// ============================================
// nad.fun Lens ABI (getCurveState)
// ============================================

const LENS_ABI = [
  {
    inputs: [{ name: "token", type: "address" }],
    name: "getCurveState",
    outputs: [
      { name: "virtualMon", type: "uint256" },
      { name: "virtualToken", type: "uint256" },
      { name: "realMon", type: "uint256" },
      { name: "realToken", type: "uint256" },
      { name: "totalSupply", type: "uint256" },
      { name: "isGraduated", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ============================================
// Tier Logic
// ============================================

export function getTierForMcap(mcap: number): HclawTier {
  for (let i = HCLAW_TIERS.length - 1; i >= 0; i--) {
    if (mcap >= HCLAW_TIERS[i].minMcap) {
      return HCLAW_TIERS[i];
    }
  }
  return HCLAW_TIERS[0];
}

export function getNextTier(currentTier: HclawTier): HclawTier | null {
  const nextIdx = HCLAW_TIERS.findIndex((t) => t.tier === currentTier.tier) + 1;
  return nextIdx < HCLAW_TIERS.length ? HCLAW_TIERS[nextIdx] : null;
}

export function getProgressToNextTier(
  mcap: number,
  currentTier: HclawTier,
  nextTier: HclawTier | null
): number {
  if (!nextTier) return 100;
  const range = nextTier.minMcap - currentTier.minMcap;
  const progress = mcap - currentTier.minMcap;
  return Math.min(100, Math.max(0, (progress / range) * 100));
}

// ============================================
// On-chain Market Cap Query
// ============================================

export async function getHclawState(
  network: "mainnet" | "testnet" = "mainnet"
): Promise<HclawState | null> {
  const tokenAddress = process.env.NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS as Address | undefined;
  if (!tokenAddress) return null;

  const config = NADFUN_CONFIG[network];

  const client = createPublicClient({
    chain: {
      id: config.chainId,
      name: network === "mainnet" ? "Monad" : "Monad Testnet",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: {
        default: {
          http: [
            network === "mainnet"
              ? "https://rpc.monad.xyz"
              : "https://testnet-rpc.monad.xyz",
          ],
        },
      },
    },
    transport: http(),
  });

  try {
    const curveState = await client.readContract({
      address: config.lens,
      abi: LENS_ABI,
      functionName: "getCurveState",
      args: [tokenAddress],
    });

    const [virtualMon, virtualToken, , , totalSupply] = curveState;

    // Calculate price: virtualMon / virtualToken gives MON per token
    // Market cap = price * totalSupply
    const price =
      Number(formatEther(virtualMon)) / Number(formatEther(virtualToken));
    const supply = Number(formatEther(totalSupply));
    const marketCap = price * supply;

    // MON->USD: fetch live price from CoinGecko, fallback to 1.0
    let monPriceUsd = 1;
    try {
      const priceRes = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd",
        { next: { revalidate: 300 } } // cache 5 min
      );
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        monPriceUsd = priceData?.monad?.usd ?? 1;
      }
    } catch {
      // Fallback to 1.0 if CoinGecko is unreachable
    }
    const mcapUsd = marketCap * monPriceUsd;

    const currentTier = getTierForMcap(mcapUsd);
    const nextTier = getNextTier(currentTier);

    return {
      tokenAddress,
      price: price * monPriceUsd,
      marketCap: mcapUsd,
      currentTier,
      nextTier,
      maxDepositPerVault: currentTier.maxDepositUsd,
      progressToNextTier: getProgressToNextTier(mcapUsd, currentTier, nextTier),
    };
  } catch (error) {
    console.error("Failed to fetch $HCLAW state:", error);
    return null;
  }
}
