/**
 * AI decision budget: $1/day free per agent.
 * Agents with their own API key get unlimited decisions.
 * Testing wallet bypasses cap (no limit).
 */

import { readJSON, writeJSON } from "./store-backend";

const BUDGET_FILE = "ai_budget.json";
const DAILY_BUDGET_USD = parseFloat(process.env.AGENT_AI_DAILY_BUDGET_USD || "1");
const COST_PER_DECISION_USD = parseFloat(process.env.AGENT_AI_COST_PER_DECISION_USD || "0.02");

/** Testing wallet: no AI budget cap, used for our internal testing */
const TESTING_WALLET = (process.env.AGENT_TESTING_WALLET_ADDRESS || "0xF3dCE9f6a8dC77d30847Ece744d68b652a730185").toLowerCase();

type BudgetEntry = { date: string; spendUsd: number };

async function readBudget(): Promise<Record<string, BudgetEntry>> {
  return readJSON<Record<string, BudgetEntry>>(BUDGET_FILE, {});
}

async function writeBudget(budget: Record<string, BudgetEntry>): Promise<void> {
  await writeJSON(BUDGET_FILE, budget);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Check if agent can make a decision (under daily budget).
 * Returns { allowed, remainingUsd, reason }.
 * Testing wallet bypasses cap (allowed: true, no limit).
 */
export async function checkAgentBudget(
  agentId: string,
  options?: { ownerWallet?: string }
): Promise<{ allowed: boolean; remainingUsd: number; reason?: string }> {
  const wallet = options?.ownerWallet?.toLowerCase();
  if (wallet && wallet === TESTING_WALLET) {
    return { allowed: true, remainingUsd: Number.POSITIVE_INFINITY };
  }

  const budget = await readBudget();
  const entry = budget[agentId];
  const todayStr = today();

  if (!entry || entry.date !== todayStr) {
    return { allowed: true, remainingUsd: DAILY_BUDGET_USD };
  }

  const remaining = DAILY_BUDGET_USD - entry.spendUsd;
  if (remaining < COST_PER_DECISION_USD) {
    return {
      allowed: false,
      remainingUsd: Math.max(0, remaining),
      reason: `AI budget exceeded ($1/day free). Add your Anthropic or OpenAI API key in Settings for unlimited decisions.`,
    };
  }

  return { allowed: true, remainingUsd: remaining };
}

/**
 * Record cost for an agent decision. Call after successful getTradeDecision when using platform key.
 */
export async function recordAgentDecisionCost(agentId: string): Promise<void> {
  const budget = await readBudget();
  const todayStr = today();
  const entry = budget[agentId];

  if (!entry || entry.date !== todayStr) {
    budget[agentId] = { date: todayStr, spendUsd: COST_PER_DECISION_USD };
  } else {
    entry.spendUsd += COST_PER_DECISION_USD;
  }

  await writeBudget(budget);
}

/** Daily budget in USD for free agents. */
export function getDailyBudgetUsd(): number {
  return DAILY_BUDGET_USD;
}

/** Estimated cost per decision in USD. */
export function getCostPerDecisionUsd(): number {
  return COST_PER_DECISION_USD;
}
