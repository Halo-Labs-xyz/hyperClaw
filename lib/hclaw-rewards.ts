import { type Address } from "viem";
import {
  isSupabaseStoreEnabled,
  sbListHclawRewardsForUser,
  sbMarkHclawRewardClaimed,
} from "@/lib/supabase-store";
import { getUserPointsSummary } from "@/lib/hclaw-points";
import type { HclawRewardState } from "@/lib/types";

const memoryClaims = new Map<string, Set<string>>();

function userKey(userAddress: string): string {
  return userAddress.toLowerCase();
}

export async function getRewardStates(userAddress: Address, epochId?: string): Promise<HclawRewardState[]> {
  const normalized = userKey(userAddress);

  if (isSupabaseStoreEnabled()) {
    try {
      const rows = await sbListHclawRewardsForUser(normalized, epochId);
      return rows.map((row) => ({
        user: row.user_address as Address,
        epochId: row.epoch_id,
        rebateUsd: row.rebate_usd,
        incentiveHclaw: row.incentive_hclaw,
        claimed: row.claimed,
      }));
    } catch (error) {
      console.warn("[HCLAW rewards] Supabase reward fallback:", error);
    }
  }

  const summary = await getUserPointsSummary(normalized);
  const claimedSet = memoryClaims.get(normalized) ?? new Set<string>();
  const targetEpoch = epochId ?? summary.epoch.epochId;

  if (targetEpoch !== summary.epoch.epochId) {
    return [];
  }

  return [
    {
      user: normalized as Address,
      epochId: targetEpoch,
      rebateUsd: summary.rewards.rebateUsd,
      incentiveHclaw: summary.rewards.incentiveHclaw,
      claimed: claimedSet.has(targetEpoch) || summary.rewards.claimed,
    },
  ];
}

export async function getClaimableSummary(userAddress: Address, epochId?: string) {
  const rewards = await getRewardStates(userAddress, epochId);
  const claimable = rewards.filter((reward) => !reward.claimed);

  return {
    rewards,
    claimableRebateUsd: claimable.reduce((acc, reward) => acc + reward.rebateUsd, 0),
    claimableIncentiveHclaw: claimable.reduce((acc, reward) => acc + reward.incentiveHclaw, 0),
  };
}

export async function claimRewards(userAddress: Address, epochId: string) {
  const normalized = userKey(userAddress);

  if (isSupabaseStoreEnabled()) {
    try {
      const row = await sbMarkHclawRewardClaimed(normalized, epochId);
      if (!row) {
        throw new Error(`No reward found for epoch ${epochId}`);
      }

      return {
        epochId,
        rebateUsd: row.rebate_usd,
        incentiveHclaw: row.incentive_hclaw,
        claimed: row.claimed,
      };
    } catch (error) {
      console.warn("[HCLAW rewards] Supabase claim fallback:", error);
    }
  }

  const claimSet = memoryClaims.get(normalized) ?? new Set<string>();
  if (claimSet.has(epochId)) {
    throw new Error(`Epoch ${epochId} already claimed`);
  }

  claimSet.add(epochId);
  memoryClaims.set(normalized, claimSet);

  const summary = await getUserPointsSummary(normalized);
  if (summary.epoch.epochId !== epochId) {
    return {
      epochId,
      rebateUsd: 0,
      incentiveHclaw: 0,
      claimed: true,
    };
  }

  return {
    epochId,
    rebateUsd: summary.rewards.rebateUsd,
    incentiveHclaw: summary.rewards.incentiveHclaw,
    claimed: true,
  };
}
