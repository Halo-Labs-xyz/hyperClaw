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

const memoryTreasuryFlows: HclawTreasuryFlow[] = [];

function getMonadRpcUrl(): string {
  return isMonadTestnet() ? "https://testnet-rpc.monad.xyz" : "https://rpc.monad.xyz";
}

function getMonadChain() {
  return {
    id: isMonadTestnet() ? 10143 : 143,
    name: isMonadTestnet() ? "Monad Testnet" : "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [getMonadRpcUrl()] } },
  } as const;
}

function getPublicClient() {
  const chain = getMonadChain();
  return createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
}

export async function getAgenticVaultStatus(): Promise<AgenticVaultStatus> {
  const vaultAddress = getAgenticLpVaultAddressIfSet();

  if (!vaultAddress) {
    return {
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
  }

  const client = getPublicClient();

  try {
    const [statusRaw, maxInventory, maxTurnover, maxDrawdown] = await Promise.all([
      client.readContract({
        address: vaultAddress,
        abi: AGENTIC_LP_VAULT_ABI,
        functionName: "getStatus",
      }) as Promise<[boolean, boolean, number, number, number, bigint, bigint]>,
      client.readContract({
        address: vaultAddress,
        abi: AGENTIC_LP_VAULT_ABI,
        functionName: "maxInventorySkewBps",
      }) as Promise<number>,
      client.readContract({
        address: vaultAddress,
        abi: AGENTIC_LP_VAULT_ABI,
        functionName: "maxDailyTurnoverBps",
      }) as Promise<number>,
      client.readContract({
        address: vaultAddress,
        abi: AGENTIC_LP_VAULT_ABI,
        functionName: "maxDrawdownBps",
      }) as Promise<number>,
    ]);

    const [paused, killSwitch, inventorySkewBps, dailyTurnoverBps, drawdownBps, cumulativePnl, lastExecTs] =
      statusRaw;

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
    console.warn("[HCLAW] agentic vault status fallback:", error);
    return {
      configured: true,
      paused: true,
      killSwitch: true,
      inventorySkewBps: 0,
      dailyTurnoverBps: 0,
      drawdownBps: 0,
      maxInventorySkewBps: 0,
      maxDailyTurnoverBps: 0,
      maxDrawdownBps: 0,
      cumulativeRealizedPnlUsd: 0,
      lastExecutionTs: 0,
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
