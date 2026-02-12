import { createPublicClient, formatEther, http } from "viem";
import { getAgenticLpVaultAddressIfSet } from "@/lib/env";
import { isMonadTestnet } from "@/lib/network";
import type { AgenticVaultStatus, HclawTreasuryFlow } from "@/lib/types";
import { AGENTIC_LP_VAULT_ABI } from "@/lib/vault";
import {
  isSupabaseStoreEnabled,
  sbInsertHclawTreasuryFlow,
  sbListHclawTreasuryFlows,
} from "@/lib/supabase-store";
import type { MonadNetwork } from "@/lib/hclaw-lock";

const memoryTreasuryFlows: HclawTreasuryFlow[] = [];

function getMonadRpcUrl(network?: MonadNetwork): string {
  const mainnetRpc =
    process.env.MONAD_MAINNET_RPC_URL ||
    process.env.NEXT_PUBLIC_MONAD_MAINNET_RPC_URL ||
    "https://rpc.monad.xyz";
  const testnetRpc =
    process.env.MONAD_TESTNET_RPC_URL ||
    process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL ||
    "https://testnet-rpc.monad.xyz";

  if (network) {
    return network === "testnet" ? testnetRpc : mainnetRpc;
  }
  return isMonadTestnet() ? testnetRpc : mainnetRpc;
}

function getMonadChain(network?: MonadNetwork) {
  const testnet = network ? network === "testnet" : isMonadTestnet();
  return {
    id: testnet ? 10143 : 143,
    name: testnet ? "Monad Testnet" : "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [getMonadRpcUrl(network)] } },
  } as const;
}

function getPublicClient(network?: MonadNetwork) {
  const chain = getMonadChain(network);
  return createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
}

const EMPTY_VAULT_STATUS: AgenticVaultStatus = {
  configured: false,
  paused: false,
  killSwitch: false,
  inventorySkewBps: 0,
  dailyTurnoverBps: 0,
  drawdownBps: 0,
  maxInventorySkewBps: 0,
  maxDailyTurnoverBps: 0,
  maxDrawdownBps: 0,
  cumulativeRealizedPnlUsd: 0,
  lastExecutionTs: 0,
};

function formatOneLineError(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0];
  return String(error);
}

export async function getAgenticVaultStatus(network?: MonadNetwork): Promise<AgenticVaultStatus> {
  const vaultAddress = getAgenticLpVaultAddressIfSet(network);

  if (!vaultAddress) {
    return EMPTY_VAULT_STATUS;
  }

  const client = getPublicClient(network);

  try {
    const code = await client.getCode({ address: vaultAddress });
    if (!code || code === "0x" || code.length <= 2) return EMPTY_VAULT_STATUS;

    const statusRaw = (await client.readContract({
      address: vaultAddress,
      abi: AGENTIC_LP_VAULT_ABI,
      functionName: "getStatus",
    })) as [boolean, boolean, number, number, number, bigint, bigint];

    const [paused, killSwitch, inventorySkewBps, dailyTurnoverBps, drawdownBps, cumulativePnl, lastExecTs] =
      statusRaw;

    const safeReadLimit = async (
      functionName: "maxInventorySkewBps" | "maxDailyTurnoverBps" | "maxDrawdownBps",
      fallbackValue: number
    ): Promise<number> => {
      try {
        const result = (await client.readContract({
          address: vaultAddress,
          abi: AGENTIC_LP_VAULT_ABI,
          functionName,
        })) as number;
        return Number(result);
      } catch {
        return fallbackValue;
      }
    };

    const [maxInventory, maxTurnover, maxDrawdown] = await Promise.all([
      safeReadLimit("maxInventorySkewBps", Number(inventorySkewBps)),
      safeReadLimit("maxDailyTurnoverBps", Number(dailyTurnoverBps)),
      safeReadLimit("maxDrawdownBps", Number(drawdownBps)),
    ]);

    return {
      configured: true,
      paused,
      killSwitch,
      inventorySkewBps: Number(inventorySkewBps),
      dailyTurnoverBps: Number(dailyTurnoverBps),
      drawdownBps: Number(drawdownBps),
      maxInventorySkewBps: Number(maxInventory),
      maxDailyTurnoverBps: Number(maxTurnover),
      maxDrawdownBps: Number(maxDrawdown),
      cumulativeRealizedPnlUsd: Number(formatEther(cumulativePnl)),
      lastExecutionTs: Number(lastExecTs),
    };
  } catch (error) {
    console.warn("[HCLAW] agentic vault status fallback:", formatOneLineError(error));
    return {
      ...EMPTY_VAULT_STATUS,
      configured: true,
      paused: true,
      killSwitch: true,
    };
  }
}

export async function recordTreasuryFlow(flow: HclawTreasuryFlow): Promise<void> {
  if (isSupabaseStoreEnabled()) {
    try {
      await sbInsertHclawTreasuryFlow({
        ts: flow.ts,
        source: flow.source,
        amount_usd: flow.amountUsd,
        buyback_usd: flow.buybackUsd,
        incentive_usd: flow.incentiveUsd,
        reserve_usd: flow.reserveUsd,
        tx_hash: flow.txHash ?? null,
      });
      return;
    } catch (error) {
      console.warn("[HCLAW treasury] Supabase flow fallback:", error);
    }
  }

  memoryTreasuryFlows.push(flow);
}

export async function getTreasuryFlows(limit = 50): Promise<HclawTreasuryFlow[]> {
  if (isSupabaseStoreEnabled()) {
    try {
      const rows = await sbListHclawTreasuryFlows(limit);
      return rows.map((row) => ({
        ts: row.ts,
        source: row.source,
        amountUsd: row.amount_usd,
        buybackUsd: row.buyback_usd,
        incentiveUsd: row.incentive_usd,
        reserveUsd: row.reserve_usd,
        txHash: row.tx_hash,
      }));
    } catch (error) {
      console.warn("[HCLAW treasury] Supabase list fallback:", error);
    }
  }

  return [...memoryTreasuryFlows]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

export async function getTreasurySummary(limit = 200) {
  const flows = await getTreasuryFlows(limit);

  return {
    flows,
    totals: {
      amountUsd: flows.reduce((sum, flow) => sum + flow.amountUsd, 0),
      buybackUsd: flows.reduce((sum, flow) => sum + flow.buybackUsd, 0),
      incentiveUsd: flows.reduce((sum, flow) => sum + flow.incentiveUsd, 0),
      reserveUsd: flows.reduce((sum, flow) => sum + flow.reserveUsd, 0),
    },
  };
}
