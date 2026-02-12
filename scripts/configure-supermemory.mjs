#!/usr/bin/env node
/**
 * Configure Supermemory settings (filterPrompt, etc.)
 * Run once after getting API key: SUPERMEMORY_API_KEY=sm_... node scripts/configure-supermemory.mjs
 */

import "dotenv/config";

const API_KEY = process.env.SUPERMEMORY_API_KEY?.trim();
if (!API_KEY) {
  console.error("Set SUPERMEMORY_API_KEY environment variable");
  process.exit(1);
}

const filterPrompt = `This is HyperClaw, an autonomous trading agent platform. containerTag is agentId (each agent has its own memory). We store: past trading decisions, outcomes (executed/skipped), market snapshots, reasoning, risk preferences, preferred markets, and patterns that worked or failed. Extract facts about risk tolerance, market preferences, successful patterns, and lessons from losing trades.`;

const body = {
  shouldLLMFilter: true,
  filterPrompt,
};

const res = await fetch("https://api.supermemory.ai/v3/settings", {
  method: "PATCH",
  headers: {
    "Content-Type": "application/json",
    "x-supermemory-api-key": API_KEY,
  },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error("Failed:", res.status, await res.text());
  process.exit(1);
}

console.log("Supermemory settings configured.");
console.log("filterPrompt:", filterPrompt.slice(0, 80) + "...");
