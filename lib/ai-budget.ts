/**
 * AI decision spend ledger (uncapped).
 *
 * The enforcement cap has been removed. These helpers remain as an optional
 * accounting layer for cost visibility if callers choose to use them.
 */

import { readJSON, writeJSON } from "./store-backend";

const BUDGET_FILE = "ai_budget.json";
const DAILY_BUDGET_USD = Number.POSITIVE_INFINITY;
const COST_PER_DECISION_USD = parseFloat(process.env.AGENT_AI_COST_PER_DECISION_USD || "0.02");

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
 * Check if agent can make a decision.
 * Cap enforcement is disabled, so this always allows execution.
 * Returns { allowed, remainingUsd, reason }.
 */
export async function checkAgentBudget(
  _agentId: string,
  _options?: { ownerWallet?: string }
): Promise<{ allowed: boolean; remainingUsd: number; reason?: string }> {
  return { allowed: true, remainingUsd: DAILY_BUDGET_USD };
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
