import { createPublicClient, http, type Address, formatEther, formatUnits, getAddress, zeroAddress } from "viem";
import { HCLAW_TIERS, NADFUN_CONFIG, type HclawState, type HclawTier } from "@/lib/types";
import { getUserCapContext } from "@/lib/hclaw-policy";
import { getUserPointsSummary } from "@/lib/hclaw-points";
import { getClaimableSummary } from "@/lib/hclaw-rewards";
import { getAddressIfSet, getHclawAddressIfSet } from "@/lib/env";

/**
 * Official nad.fun v3 Lens ABI – sourced from
 * https://github.com/Naddotfun/contract-v3-abi/blob/main/ILens.json
 *
 * The Lens is the single read interface that auto-detects bonding-curve
 * vs graduated-DEX tokens.  There is NO `getCurveState` in v3.
 */
const LENS_ABI = [
  {
    inputs: [
      { name: "_token", type: "address" },
      { name: "_amountIn", type: "uint256" },
      { name: "_isBuy", type: "bool" },
    ],
    name: "getAmountOut",
    outputs: [
      { name: "router", type: "address" },
      { name: "amountOut", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "_token", type: "address" }],
    name: "isGraduated",
    outputs: [{ name: "isGraduated", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "_token", type: "address" }],
    name: "getProgress",
    outputs: [{ name: "progress", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * BondingCurve `curves(token)` – direct reserve read from
 * https://github.com/Naddotfun/contract-v3-abi/blob/main/IBondingCurve.json
 */
const BONDING_CURVE_ABI = [
  {
    inputs: [{ name: "token", type: "address" }],
    name: "curves",
    outputs: [
      { name: "realMonReserve", type: "uint256" },
      { name: "realTokenReserve", type: "uint256" },
      { name: "virtualMonReserve", type: "uint256" },
      { name: "virtualTokenReserve", type: "uint256" },
      { name: "k", type: "uint256" },
      { name: "targetTokenAmount", type: "uint256" },
      { name: "initVirtualMonReserve", type: "uint256" },
      { name: "initVirtualTokenReserve", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ERC20_METADATA_ABI = [
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const DEX_FACTORY_ABI = [
  {
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
    ],
    name: "getPair",
    outputs: [{ name: "pair", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const DEX_PAIR_ABI = [
  {
    inputs: [],
    name: "token0",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token1",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getReserves",
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
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

async function getDexDerivedMarketState(params: {
  client: ReturnType<typeof createPublicClient>;
  tokenAddress: Address;
  network: "mainnet" | "testnet";
  monPriceUsd: number;
}): Promise<{ priceUsd: number; marketCapUsd: number } | null> {
  const { client, tokenAddress, network, monPriceUsd } = params;
  const cfg = NADFUN_CONFIG[network] as {
    dexFactory?: Address;
    wmon?: Address;
  };
  if (!cfg.dexFactory || !cfg.wmon) return null;

  const pair = (await client.readContract({
    address: cfg.dexFactory,
    abi: DEX_FACTORY_ABI,
    functionName: "getPair",
    args: [cfg.wmon, tokenAddress],
  })) as Address;

  if (!pair || pair.toLowerCase() === zeroAddress) return null;

  const [token0, token1, reserves, supplyRaw, tokenDecimals] = await Promise.all([
    client.readContract({
      address: pair,
      abi: DEX_PAIR_ABI,
      functionName: "token0",
    }) as Promise<Address>,
    client.readContract({
      address: pair,
      abi: DEX_PAIR_ABI,
      functionName: "token1",
    }) as Promise<Address>,
    client.readContract({
      address: pair,
      abi: DEX_PAIR_ABI,
      functionName: "getReserves",
    }) as Promise<[bigint, bigint, number]>,
    client.readContract({
      address: tokenAddress,
      abi: ERC20_METADATA_ABI,
      functionName: "totalSupply",
    }) as Promise<bigint>,
    client.readContract({
      address: tokenAddress,
      abi: ERC20_METADATA_ABI,
      functionName: "decimals",
    }) as Promise<number>,
  ]);

  const reserve0 = reserves[0];
  const reserve1 = reserves[1];
  const wmonLc = cfg.wmon.toLowerCase();
  const tokenLc = tokenAddress.toLowerCase();
  const token0Lc = token0.toLowerCase();
  const token1Lc = token1.toLowerCase();

  let reserveWmon: bigint | null = null;
  let reserveToken: bigint | null = null;
  if (token0Lc === wmonLc && token1Lc === tokenLc) {
    reserveWmon = reserve0;
    reserveToken = reserve1;
  } else if (token1Lc === wmonLc && token0Lc === tokenLc) {
    reserveWmon = reserve1;
    reserveToken = reserve0;
  } else {
    return null;
  }

  if (!reserveWmon || !reserveToken || reserveToken === BigInt(0)) return null;

  const wmonQty = Number(formatEther(reserveWmon));
  const tokenQty = Number(formatUnits(reserveToken, tokenDecimals));
  if (tokenQty <= 0) return null;

  const priceMon = wmonQty / tokenQty;
  const priceUsd = priceMon * monPriceUsd;
  const supply = Number(formatUnits(supplyRaw, tokenDecimals));
  const marketCapUsd = supply * priceUsd;

  return { priceUsd, marketCapUsd };
}

function getNadfunConfig(network: "mainnet" | "testnet") {
  const networkLensEnv =
    network === "mainnet" ? "NADFUN_MAINNET_LENS_ADDRESS" : "NADFUN_TESTNET_LENS_ADDRESS";
  const lens =
    getAddressIfSet(networkLensEnv) ??
    getAddressIfSet("NADFUN_LENS_ADDRESS") ??
    getAddress(NADFUN_CONFIG[network].lens);
  const rpcUrl =
    network === "mainnet"
      ? process.env.MONAD_MAINNET_RPC_URL ||
        process.env.NEXT_PUBLIC_MONAD_MAINNET_RPC_URL ||
        "https://rpc.monad.xyz"
      : process.env.MONAD_TESTNET_RPC_URL ||
        process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL ||
        "https://testnet-rpc.monad.xyz";

  if (network === "mainnet") {
    return {
      chainId: 143,
      lens,
      rpcUrl,
    };
  }

  return {
    chainId: 10143,
    lens,
    rpcUrl,
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
  const tokenAddress = getHclawAddressIfSet() as Address | null;
  if (!tokenAddress) {
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
    const monPriceUsd = await getMonPriceUsd();
    let priceUsd = 0;
    let marketCapUsd = 0;

    // Strategy: use the v3 Lens getAmountOut (works for both bonding curve
    // and graduated DEX tokens).  Fall back to direct BondingCurve.curves()
    // read, then DEX-pair reserve read.
    const ONE_MON = BigInt("1000000000000000000"); // 1e18

    try {
      // Step 1: Try Lens getAmountOut – "If I buy with 1 MON, how many tokens?"
      const [, amountOut] = await client.readContract({
        address: config.lens,
        abi: LENS_ABI,
        functionName: "getAmountOut",
        args: [tokenAddress, ONE_MON, true],
      });

      if (amountOut > BigInt(0)) {
        // price per token in MON = 1 / (amountOut / 1e18) = 1e18 / amountOut
        const tokenQtyPerMon = Number(formatEther(amountOut));
        const pricePerTokenMon = 1 / tokenQtyPerMon;
        priceUsd = pricePerTokenMon * monPriceUsd;

        // Read total supply for market cap
        const supplyRaw = await client.readContract({
          address: tokenAddress,
          abi: ERC20_METADATA_ABI,
          functionName: "totalSupply",
        });
        const supply = Number(formatEther(supplyRaw as bigint));
        marketCapUsd = supply * priceUsd;
      }
    } catch {
      // Step 2: Lens failed – try reading BondingCurve.curves() directly
      try {
        const curveAddress = NADFUN_CONFIG[network]?.curve;
        if (curveAddress) {
          const curveData = await client.readContract({
            address: curveAddress as Address,
            abi: BONDING_CURVE_ABI,
            functionName: "curves",
            args: [tokenAddress],
          });
          const virtualMonReserve = curveData[2];
          const virtualTokenReserve = curveData[3];
          if (virtualTokenReserve > BigInt(0)) {
            const priceMon = Number(formatEther(virtualMonReserve)) / Number(formatEther(virtualTokenReserve));
            priceUsd = priceMon * monPriceUsd;

            const supplyRaw = await client.readContract({
              address: tokenAddress,
              abi: ERC20_METADATA_ABI,
              functionName: "totalSupply",
            });
            const supply = Number(formatEther(supplyRaw as bigint));
            marketCapUsd = supply * priceUsd;
          }
        }
      } catch {
        // Step 3: BondingCurve read failed – try DEX pair reserves
        try {
          const dex = await getDexDerivedMarketState({ client, tokenAddress, network, monPriceUsd });
          if (dex) {
            priceUsd = dex.priceUsd;
            marketCapUsd = dex.marketCapUsd;
          } else {
            console.warn("[HCLAW] All price sources unavailable; using tier/rebate fallback state");
          }
        } catch {
          console.warn("[HCLAW] All price sources unavailable; using tier/rebate fallback state");
        }
      }
    }

    const currentTier = getTierForMcap(marketCapUsd);
    const nextTier = getNextTier(currentTier);

    const state: HclawState = {
      tokenAddress,
      price: priceUsd,
      marketCap: marketCapUsd,
      currentTier,
      nextTier,
      maxDepositPerVault: currentTier.maxDepositUsd,
      progressToNextTier: getProgressToNextTier(marketCapUsd, currentTier, nextTier),
    };

    if (opts?.userAddress) {
      const [capContext, points, claimable] = await Promise.all([
        getUserCapContext(opts.userAddress, opts.agentId, network),
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
