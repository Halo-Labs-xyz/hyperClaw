import { getHclawEpochDurationDays } from "@/lib/env";
import {
  isSupabaseStoreEnabled,
  sbCreateHclawEpoch,
  sbGetHclawEpoch,
  sbGetLatestHclawEpoch,
  sbListHclawEpochBalances,
  sbListHclawEpochs,
  sbListHclawRewardsForUser,
  sbUpsertHclawPointsBalance,
  sbUpsertHclawReward,
} from "@/lib/supabase-store";
import type {
  HclawEpochInfo,
  HclawPointBreakdown,
} from "@/lib/types";

export interface HclawPointsActivityInput {
  userAddress: string;
  lockPower: number;
  lpVolumeUsd: number;
  referralVolumeUsd: number;
  questCount: number;
  heldMs: number;
  selfTradeVolumeUsd?: number;
  sybilScore?: number;
}

export interface HclawPointsResult {
  userAddress: string;
  breakdown: HclawPointBreakdown;
  eligible: boolean;
  exclusions: string[];
}

const MIN_ELIGIBLE_HOLD_MS = 24 * 60 * 60 * 1000;
const EPOCH_STATUS_OPEN = "open" as const;
const EPOCH_STATUS_CLOSED = "closed" as const;

const memoryEpochs = new Map<string, HclawEpochInfo>();
const memoryBalances = new Map<string, Map<string, HclawPointBreakdown>>();
const memoryRewards = new Map<string, Map<string, { rebateUsd: number; incentiveHclaw: number; claimed: boolean }>>();

function normalizePoints(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function toEpochId(startTs: number): string {
  return `epoch-${Math.floor(startTs / 1000)}`;
}

function getEpochWindow(nowMs = Date.now()): { startTs: number; endTs: number; epochId: string } {
  const days = getHclawEpochDurationDays();
  const epochMs = days * 24 * 60 * 60 * 1000;
  const startTs = Math.floor(nowMs / epochMs) * epochMs;
  const endTs = startTs + epochMs;
  return { startTs, endTs, epochId: toEpochId(startTs) };
}

export function scorePointsActivity(input: HclawPointsActivityInput): HclawPointsResult {
  const exclusions: string[] = [];

  const holdMs = Math.max(0, input.heldMs || 0);
  if (holdMs < MIN_ELIGIBLE_HOLD_MS) {
    exclusions.push("min_hold_not_met");
    return {
      userAddress: input.userAddress.toLowerCase(),
      eligible: false,
      exclusions,
      breakdown: {
        lockPoints: 0,
        lpPoints: 0,
        refPoints: 0,
        questPoints: 0,
        totalPoints: 0,
      },
    };
  }

  const sybilScore = input.sybilScore ?? 0;
  if (sybilScore >= 0.85) {
    exclusions.push("sybil_flagged");
    return {
      userAddress: input.userAddress.toLowerCase(),
      eligible: false,
      exclusions,
      breakdown: {
        lockPoints: 0,
        lpPoints: 0,
        refPoints: 0,
        questPoints: 0,
        totalPoints: 0,
      },
    };
  }

  const lockScore = Math.max(0, input.lockPower || 0);
  const lpScoreRaw = Math.max(0, input.lpVolumeUsd || 0) / 100;
  const refScore = Math.max(0, input.referralVolumeUsd || 0) / 100;
  const questScore = Math.max(0, input.questCount || 0) * 10;

  let lpScore = lpScoreRaw;
  const selfTradeVolume = Math.max(0, input.selfTradeVolumeUsd || 0);
  if (selfTradeVolume > 0 && selfTradeVolume >= (input.lpVolumeUsd || 0) * 0.5) {
    exclusions.push("wash_trade_lp_excluded");
    lpScore = 0;
  }

  const lockPoints = normalizePoints(lockScore * 0.4);
  const lpPoints = normalizePoints(lpScore * 0.35);
  const refPoints = normalizePoints(refScore * 0.15);
  const questPoints = normalizePoints(questScore * 0.1);
  const totalPoints = normalizePoints(lockPoints + lpPoints + refPoints + questPoints);

  return {
    userAddress: input.userAddress.toLowerCase(),
    eligible: totalPoints > 0,
    exclusions,
    breakdown: {
      lockPoints,
      lpPoints,
      refPoints,
      questPoints,
      totalPoints,
    },
  };
}

export function scoreEpochActivities(inputs: HclawPointsActivityInput[]): HclawPointsResult[] {
  const sorted = [...inputs].sort((a, b) =>
    a.userAddress.toLowerCase().localeCompare(b.userAddress.toLowerCase())
  );
  return sorted.map((input) => scorePointsActivity(input));
}

export async function getCurrentEpochInfo(nowMs = Date.now()): Promise<HclawEpochInfo> {
  const { epochId, startTs, endTs } = getEpochWindow(nowMs);

  if (isSupabaseStoreEnabled()) {
    try {
      const existing = await sbGetHclawEpoch(epochId);
      if (existing) {
        return {
          epochId: existing.epoch_id,
          startTs: existing.start_ts,
          endTs: existing.end_ts,
          status: existing.status,
          rootHash: existing.root_hash,
        };
      }

      await sbCreateHclawEpoch({
        epoch_id: epochId,
        start_ts: startTs,
        end_ts: endTs,
        status: EPOCH_STATUS_OPEN,
        root_hash: null,
        settled_ts: null,
      });
    } catch (error) {
      console.warn("[HCLAW points] Supabase epoch fallback:", error);
    }
  }

  const memoryEpoch = memoryEpochs.get(epochId);
  if (memoryEpoch) return memoryEpoch;

  const created: HclawEpochInfo = {
    epochId,
    startTs,
    endTs,
    status: EPOCH_STATUS_OPEN,
    rootHash: null,
  };
  memoryEpochs.set(epochId, created);
  return created;
}

export async function getUserPointsSummary(userAddress: string) {
  const user = userAddress.toLowerCase();
  const currentEpoch = await getCurrentEpochInfo();

  if (isSupabaseStoreEnabled()) {
    try {
      const balances = await sbListHclawEpochBalances(currentEpoch.epochId, user);
      const latest = balances[0];
      const rewards = await sbListHclawRewardsForUser(user, currentEpoch.epochId);
      const reward = rewards[0];

      return {
        epoch: currentEpoch,
        points: {
          lockPoints: latest?.lock_points ?? 0,
          lpPoints: latest?.lp_points ?? 0,
          refPoints: latest?.ref_points ?? 0,
          questPoints: latest?.quest_points ?? 0,
          totalPoints: latest?.total_points ?? 0,
        },
        rewards: {
          rebateUsd: reward?.rebate_usd ?? 0,
          incentiveHclaw: reward?.incentive_hclaw ?? 0,
          claimed: reward?.claimed ?? false,
        },
      };
    } catch (error) {
      console.warn("[HCLAW points] Supabase user summary fallback:", error);
    }
  }

  const balance = memoryBalances.get(currentEpoch.epochId)?.get(user) ?? {
    lockPoints: 0,
    lpPoints: 0,
    refPoints: 0,
    questPoints: 0,
    totalPoints: 0,
  };
  const reward = memoryRewards.get(currentEpoch.epochId)?.get(user) ?? {
    rebateUsd: 0,
    incentiveHclaw: 0,
    claimed: false,
  };

  return {
    epoch: currentEpoch,
    points: balance,
    rewards: reward,
  };
}

export async function closeEpoch(params: {
  epochId?: string;
  activities: HclawPointsActivityInput[];
  rootHash?: string | null;
}) {
  const currentEpoch = await getCurrentEpochInfo();
  const targetEpochId = params.epochId ?? currentEpoch.epochId;
  const scored = scoreEpochActivities(params.activities);

  if (isSupabaseStoreEnabled()) {
    try {
      const epoch = (await sbGetHclawEpoch(targetEpochId)) ?? (await sbGetLatestHclawEpoch());
      if (!epoch) {
        throw new Error(`Epoch ${targetEpochId} not found`);
      }

      for (const row of scored) {
        await sbUpsertHclawPointsBalance({
          epoch_id: epoch.epoch_id,
          user_address: row.userAddress,
          lock_points: row.breakdown.lockPoints,
          lp_points: row.breakdown.lpPoints,
          ref_points: row.breakdown.refPoints,
          quest_points: row.breakdown.questPoints,
          total_points: row.breakdown.totalPoints,
        });

        const rebateUsd = normalizePoints(row.breakdown.lpPoints * 0.05);
        const incentiveHclaw = normalizePoints(row.breakdown.totalPoints * 0.2);

        await sbUpsertHclawReward({
          user_address: row.userAddress,
          epoch_id: epoch.epoch_id,
          rebate_usd: rebateUsd,
          incentive_hclaw: incentiveHclaw,
          claimed: false,
        });
      }

      await sbCreateHclawEpoch({
        epoch_id: epoch.epoch_id,
        start_ts: epoch.start_ts,
        end_ts: epoch.end_ts,
        status: EPOCH_STATUS_CLOSED,
        root_hash: params.rootHash ?? epoch.root_hash,
        settled_ts: Date.now(),
      });
    } catch (error) {
      console.warn("[HCLAW points] Supabase close fallback:", error);
      await closeEpochInMemory(targetEpochId, currentEpoch, scored, params.rootHash ?? null);
    }
  } else {
    await closeEpochInMemory(targetEpochId, currentEpoch, scored, params.rootHash ?? null);
  }

  return {
    epochId: targetEpochId,
    settledUsers: scored.length,
    pointsDistributed: normalizePoints(
      scored.reduce((acc, item) => acc + item.breakdown.totalPoints, 0)
    ),
    excludedUsers: scored.filter((item) => !item.eligible).length,
  };
}

async function closeEpochInMemory(
  targetEpochId: string,
  currentEpoch: HclawEpochInfo,
  scored: HclawPointsResult[],
  rootHash: string | null
) {
    const epoch = memoryEpochs.get(targetEpochId) ?? {
      epochId: targetEpochId,
      startTs: currentEpoch.startTs,
      endTs: currentEpoch.endTs,
      status: EPOCH_STATUS_OPEN,
      rootHash: null,
    };

    const balanceMap = memoryBalances.get(targetEpochId) ?? new Map<string, HclawPointBreakdown>();
    const rewardMap = memoryRewards.get(targetEpochId) ?? new Map<string, { rebateUsd: number; incentiveHclaw: number; claimed: boolean }>();

    for (const row of scored) {
      balanceMap.set(row.userAddress, row.breakdown);
      rewardMap.set(row.userAddress, {
        rebateUsd: normalizePoints(row.breakdown.lpPoints * 0.05),
        incentiveHclaw: normalizePoints(row.breakdown.totalPoints * 0.2),
        claimed: false,
      });
    }

    memoryBalances.set(targetEpochId, balanceMap);
    memoryRewards.set(targetEpochId, rewardMap);
    memoryEpochs.set(targetEpochId, {
      ...epoch,
      status: EPOCH_STATUS_CLOSED,
      rootHash: rootHash ?? epoch.rootHash ?? null,
    });
}

export async function getRecentEpochs(limit = 8): Promise<HclawEpochInfo[]> {
  if (isSupabaseStoreEnabled()) {
    try {
      const rows = await sbListHclawEpochs(limit);
      return rows.map((row) => ({
        epochId: row.epoch_id,
        startTs: row.start_ts,
        endTs: row.end_ts,
        status: row.status,
        rootHash: row.root_hash,
      }));
    } catch (error) {
      console.warn("[HCLAW points] Supabase recent epochs fallback:", error);
    }
  }

  return Array.from(memoryEpochs.values())
    .sort((a, b) => b.startTs - a.startTs)
    .slice(0, limit);
}
