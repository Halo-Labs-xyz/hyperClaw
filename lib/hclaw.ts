import { createPublicClient, http, type Address, formatEther } from "viem";
import { HCLAW_TIERS, type HclawState, type HclawTier } from "@/lib/types";
import { getUserCapContext } from "@/lib/hclaw-policy";
import { getUserPointsSummary } from "@/lib/hclaw-points";
import { getClaimableSummary } from "@/lib/hclaw-rewards";

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

export function getTierForMcap(mcap: number): HclawTier {
  for (let i = HCLAW_TIERS.length - 1; i >= 0; i--) {
    if (mcap >= HCLAW_TIERS[i].minMcap) return HCLAW_TIERS[i];
  }
  return HCLAW_TIERS[0];
}

export function getNextTier(currentTier: HclawTier): HclawTier | null {
  const nextIdx = HCLAW_TIERS.findIndex((tier) => tier.tier === currentTier.tier) + 1;
  return nextIdx < HCLAW_TIERS.length ? HCLAW_TIERS[nextIdx] : null;
}

export function getProgressToNextTier(mcap: number, currentTier: HclawTier, nextTier: HclawTier | null): number {
  if (!nextTier) return 100;
  const range = nextTier.minMcap - currentTier.minMcap;
  const progress = mcap - currentTier.minMcap;
  if (range <= 0) return 100;
  return Math.min(100, Math.max(0, (progress / range) * 100));
}

function getNadfunConfig(network: "mainnet" | "testnet") {
  if (network === "mainnet") {
    return {
      chainId: 143,
      lens: "0x73363D4090Fd6A012Fb31514733235AF2De0CdA7" as Address,
      rpcUrl: "https://rpc.monad.xyz",
    };
  }

  return {
    chainId: 10143,
    lens: "0x73363D4090Fd6A012Fb31514733235AF2De0CdA7" as Address,
    rpcUrl: "https://testnet-rpc.monad.xyz",
  };
}

async function getMonPriceUsd(): Promise<number> {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd",
      { next: { revalidate: 300 } }
    );
    if (!response.ok) return 1;
    const body = await response.json();
    return Number(body?.monad?.usd ?? 1);
  } catch {
    return 1;
  }
}

export async function getHclawState(
  network: "mainnet" | "testnet" = "mainnet",
  opts?: { userAddress?: Address; agentId?: string }
): Promise<HclawState | null> {
  const tokenAddress = process.env.NEXT_PUBLIC_HCLAW_TOKEN_ADDRESS as Address | undefined;
  if (!tokenAddress || !tokenAddress.startsWith("0x") || tokenAddress.length !== 42) {
    return null;
  }

  const config = getNadfunConfig(network);
  const client = createPublicClient({
    chain: {
      id: config.chainId,
      name: network === "mainnet" ? "Monad" : "Monad Testnet",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    },
    transport: http(config.rpcUrl),
  });

  try {
    const [curveState, monPriceUsd] = await Promise.all([
      client.readContract({
        address: config.lens,
        abi: LENS_ABI,
        functionName: "getCurveState",
        args: [tokenAddress],
      }),
      getMonPriceUsd(),
    ]);

    const [virtualMon, virtualToken, , , totalSupply] = curveState;
    if (virtualToken === BigInt(0) || totalSupply === BigInt(0)) {
      return null;
    }

    const priceMon = Number(formatEther(virtualMon)) / Number(formatEther(virtualToken));
    const supply = Number(formatEther(totalSupply));
    const marketCapUsd = priceMon * supply * monPriceUsd;

    const currentTier = getTierForMcap(marketCapUsd);
    const nextTier = getNextTier(currentTier);

    const state: HclawState = {
      tokenAddress,
      price: priceMon * monPriceUsd,
      marketCap: marketCapUsd,
      currentTier,
      nextTier,
      maxDepositPerVault: currentTier.maxDepositUsd,
      progressToNextTier: getProgressToNextTier(marketCapUsd, currentTier, nextTier),
    };

    if (opts?.userAddress) {
      const [capContext, points, claimable] = await Promise.all([
        getUserCapContext(opts.userAddress, opts.agentId),
        getUserPointsSummary(opts.userAddress),
        getClaimableSummary(opts.userAddress),
      ]);

      state.lockTier = capContext.tier;
      state.hclawPower = capContext.power ?? 0;
      state.baseCapUsd = capContext.baseCapUsd;
      state.boostedCapUsd = capContext.boostedCapUsd;
      state.capRemainingUsd = capContext.capRemainingUsd;
      state.rebateBps = capContext.rebateBps;
      state.pointsThisEpoch = points.points.totalPoints;
      state.claimableRebateUsd = claimable.claimableRebateUsd;
      state.claimableIncentiveHclaw = claimable.claimableIncentiveHclaw;
    }

    return state;
  } catch (error) {
    console.error("Failed to fetch $HCLAW state:", error);
    return null;
  }
}
