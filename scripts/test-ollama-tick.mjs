#!/usr/bin/env node
/**
 * Test agentic trade tick using Ollama (glm-4.7-flash) as primary model.
 * Requires: .env with OPENAI_API_BASE_URL, ORCHESTRATOR_SECRET or HYPERCLAW_API_KEY, dev server on :3000
 * Usage: node scripts/test-ollama-tick.mjs [agentId]
 */

import "dotenv/config";

const AGENT_ID = process.argv[2] || "b749ff158122fdec";
const BASE = process.env.BASE_URL || "http://localhost:3000";
const AUTH = process.env.ORCHESTRATOR_SECRET || process.env.HYPERCLAW_API_KEY;

async function main() {
  console.log("\n🧪 Testing Ollama (glm-4.7-flash) agentic trade tick\n");
  console.log(`Agent: ${AGENT_ID}`);
  console.log(`API:   ${BASE}/api/agents/${AGENT_ID}/tick`);
  console.log(`Auth:  ${AUTH ? "✓" : "✗ (dev mode if no HYPERCLAW_API_KEY set)"}\n`);

  const headers = {
    "Content-Type": "application/json",
    ...(process.env.ORCHESTRATOR_SECRET && { "X-Orchestrator-Key": process.env.ORCHESTRATOR_SECRET }),
    ...(process.env.HYPERCLAW_API_KEY && !process.env.ORCHESTRATOR_SECRET && { "x-api-key": process.env.HYPERCLAW_API_KEY }),
  };

  try {
    const res = await fetch(`${BASE}/api/agents/${AGENT_ID}/tick`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "tick" }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("❌ Error:", data.error || res.statusText);
      process.exit(1);
    }

    console.log("✅ Tick completed");
    console.log("Decision:", JSON.stringify(data.decision, null, 2));
    console.log("Executed:", data.executed);
    if (data.executionResult) console.log("Execution:", data.executionResult);
    if (data.tradeLog?.reasoning) console.log("Reasoning:", data.tradeLog.reasoning);
  } catch (err) {
    console.error("❌ Request failed:", err.message);
    process.exit(1);
  }
}

main();
