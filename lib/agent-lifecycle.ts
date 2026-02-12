/**
 * Agent Lifecycle Manager
 * 
 * Unified orchestration layer that ties together:
 * - Agent Runner (autonomous trading loop)
 * - Unibase AIP (external A2A protocol access)
 * - Status management and monitoring
 * 
 * When an agent is activated, this manager:
 * 1. Starts the autonomous trading runner
 * 2. Registers the agent with Unibase AIP
 * 3. Monitors health and restarts if needed
 * 
 * This creates a seamless end-to-end trading experience.
 */

import { getAgent, getAllAgents, updateAgent } from "./store";
import { startAgent, stopAgent, getRunnerState, getAllRunnerStates } from "./agent-runner";
import { 
  registerAIPAgent, 
  getAIPAgentByHyperClawId, 
  getRegisteredAIPAgents,
  type DeploymentMode 
} from "./unibase-aip";
import type { Agent } from "./types";

// ============================================
// Configuration
// ============================================

const AIP_MODE: DeploymentMode = (process.env.AIP_MODE as DeploymentMode) || "POLLING";
const AIP_ENDPOINT =
  process.env.AGENT_PUBLIC_URL?.trim() ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/unibase` : undefined);
const AIP_REGISTRATION_REQUIRED = (() => {
  const raw = process.env.AIP_REGISTRATION_REQUIRED?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no") return false;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  return process.env.NODE_ENV === "production";
})();

// ============================================
// Lifecycle State
// ============================================

interface AgentLifecycleState {
  agentId: string;
  runnerActive: boolean;
  aipRegistered: boolean;
  aipAgentId?: string;
  startedAt?: number;
  lastHealthCheck?: number;
  healthStatus: "healthy" | "degraded" | "unhealthy" | "stopped";
}

type LifecycleGlobals = {
  lifecycleStates: Map<string, AgentLifecycleState>;
  initialized: boolean;
  healthCheckInterval: ReturnType<typeof setInterval> | null;
};

const lifecycleGlobals = (globalThis as typeof globalThis & {
  __hyperclawLifecycleGlobals?: LifecycleGlobals;
}).__hyperclawLifecycleGlobals ??= {
  lifecycleStates: new Map<string, AgentLifecycleState>(),
  initialized: false,
  healthCheckInterval: null,
};

const lifecycleStates = lifecycleGlobals.lifecycleStates;

export function getLifecycleState(agentId: string): AgentLifecycleState | null {
  return lifecycleStates.get(agentId) || null;
}

export function getAllLifecycleStates(): AgentLifecycleState[] {
  return Array.from(lifecycleStates.values());
}

// ============================================
// Agent Activation
// ============================================

/**
 * Activate an agent - starts runner and registers with AIP
 */
export async function activateAgent(
  agentId: string,
  options?: {
    tickIntervalMs?: number;
    skipAIP?: boolean;
  }
): Promise<AgentLifecycleState> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  console.log(`[Lifecycle] Activating agent: ${agent.name} (${agentId})`);

  const state: AgentLifecycleState = {
    agentId,
    runnerActive: false,
    aipRegistered: false,
    healthStatus: "stopped",
  };

  // 1. Start the autonomous trading runner
  try {
    const runnerState = await startAgent(agentId, options?.tickIntervalMs);
    state.runnerActive = true;
    state.startedAt = Date.now();
    console.log(`[Lifecycle] Runner started for ${agent.name} (interval: ${runnerState.intervalMs}ms)`);
  } catch (error) {
    console.error(`[Lifecycle] Failed to start runner for ${agentId}:`, error);
    state.healthStatus = "unhealthy";
  }

  // 2. Register with Unibase AIP (if not skipped)
  if (!options?.skipAIP) {
    try {
      const existingAIP = getAIPAgentByHyperClawId(agentId);
      if (existingAIP) {
        state.aipRegistered = true;
        state.aipAgentId = existingAIP.aipAgentId;
        console.log(`[Lifecycle] Agent already registered with AIP: ${existingAIP.aipAgentId}`);
      } else {
        const endpoint = AIP_MODE === "DIRECT" && AIP_ENDPOINT 
          ? `${AIP_ENDPOINT}/invoke/${agentId}`
          : undefined;
        
        const { aipAgentId } = await registerAIPAgent(agentId, AIP_MODE, endpoint);
        state.aipRegistered = true;
        state.aipAgentId = aipAgentId;
        console.log(`[Lifecycle] Registered with AIP: ${aipAgentId} (mode: ${AIP_MODE})`);
      }
    } catch (error) {
      console.error(`[Lifecycle] Failed to register ${agentId} with AIP:`, error);
      if (AIP_REGISTRATION_REQUIRED) {
        try {
          if (state.runnerActive) {
            await stopAgent(agentId);
            state.runnerActive = false;
          }
        } catch (stopError) {
          console.error(`[Lifecycle] Failed to stop runner after AIP registration error for ${agentId}:`, stopError);
        }
        state.healthStatus = "unhealthy";
        state.lastHealthCheck = Date.now();
        lifecycleStates.set(agentId, state);
        throw error instanceof Error ? error : new Error(`AIP registration failed for ${agentId}`);
      }
    }
  }

  // 3. Update health status
  state.healthStatus = state.runnerActive ? "healthy" : "unhealthy";
  state.lastHealthCheck = Date.now();

  lifecycleStates.set(agentId, state);

  // 4. Update agent status to active if not already
  if (agent.status !== "active") {
    await updateAgent(agentId, { status: "active" });
  }

  return state;
}

/**
 * Deactivate an agent - stops runner
 */
export async function deactivateAgent(agentId: string): Promise<void> {
  const agent = await getAgent(agentId);
  console.log(`[Lifecycle] Deactivating agent: ${agent?.name || agentId}`);

  // Stop the runner
  await stopAgent(agentId);

  // Update state
  const state = lifecycleStates.get(agentId);
  if (state) {
    state.runnerActive = false;
    state.healthStatus = "stopped";
    state.lastHealthCheck = Date.now();
  }

  // Update agent status
  if (agent && agent.status === "active") {
    await updateAgent(agentId, { status: "paused" });
  }
}

// ============================================
// Status Change Handler
// ============================================

/**
 * Handle agent status changes - auto-start/stop based on status
 * Call this when agent status is updated
 */
export async function handleStatusChange(
  agentId: string,
  newStatus: "active" | "paused" | "stopped"
): Promise<void> {
  const currentState = lifecycleStates.get(agentId);
  
  if (newStatus === "active") {
    // Activate if not already running
    if (!currentState?.runnerActive) {
      await activateAgent(agentId);
    }
  } else {
    // Deactivate if running
    if (currentState?.runnerActive) {
      await stopAgent(agentId);
      if (currentState) {
        currentState.runnerActive = false;
        currentState.healthStatus = newStatus === "paused" ? "stopped" : "stopped";
      }
    }
  }
}

// ============================================
// Bulk Operations
// ============================================

/**
 * Start all active agents on server startup
 */
export async function startAllActiveAgents(): Promise<{
  started: string[];
  failed: string[];
}> {
  const agents = await getAllAgents();
  const activeAgents = agents.filter(a => a.status === "active");

  console.log(`[Lifecycle] Starting ${activeAgents.length} active agents...`);

  const started: string[] = [];
  const failed: string[] = [];

  for (const agent of activeAgents) {
    try {
      await activateAgent(agent.id);
      started.push(agent.id);
    } catch (error) {
      console.error(`[Lifecycle] Failed to start ${agent.id}:`, error);
      failed.push(agent.id);
    }
  }

  console.log(`[Lifecycle] Started ${started.length}/${activeAgents.length} agents`);
  return { started, failed };
}

/**
 * Stop all running agents (for graceful shutdown)
 */
export async function stopAllAgents(): Promise<void> {
  const states = getAllRunnerStates();
  console.log(`[Lifecycle] Stopping ${states.length} agents...`);

  for (const state of states) {
    try {
      await stopAgent(state.agentId);
    } catch (error) {
      console.error(`[Lifecycle] Failed to stop ${state.agentId}:`, error);
    }
  }
}

// ============================================
// Health Monitoring
// ============================================

/**
 * Check health of all running agents
 */
export async function checkAllHealth(): Promise<Map<string, AgentLifecycleState>> {
  const agents = await getAllAgents();
  const results = new Map<string, AgentLifecycleState>();

  for (const agent of agents) {
    const lifecycle = lifecycleStates.get(agent.id);
    const runner = getRunnerState(agent.id);
    const aip = getAIPAgentByHyperClawId(agent.id);

    const state: AgentLifecycleState = {
      agentId: agent.id,
      runnerActive: runner?.isRunning ?? false,
      aipRegistered: !!aip,
      aipAgentId: aip?.aipAgentId,
      startedAt: lifecycle?.startedAt,
      lastHealthCheck: Date.now(),
      healthStatus: "stopped",
    };

    // Determine health status
    if (agent.status === "active") {
      if (state.runnerActive && state.aipRegistered) {
        state.healthStatus = "healthy";
      } else if (state.runnerActive || state.aipRegistered) {
        state.healthStatus = "degraded";
      } else {
        state.healthStatus = "unhealthy";
      }
    }

    // Check for stale runner (no tick for 2x configured interval, minimum 5 minutes)
    if (runner?.isRunning && runner.lastTickAt) {
      const staleThreshold = Math.max(5 * 60 * 1000, (runner.intervalMs || 0) * 2);
      if (Date.now() - runner.lastTickAt > staleThreshold) {
        state.healthStatus = "degraded";
      }
    }

    // Check for too many errors
    if (runner && runner.errors.length >= 10) {
      const recentErrors = runner.errors.filter(
        e => Date.now() - e.timestamp < 10 * 60 * 1000 // Last 10 minutes
      );
      if (recentErrors.length >= 5) {
        state.healthStatus = "degraded";
      }
    }

    lifecycleStates.set(agent.id, state);
    results.set(agent.id, state);
  }

  return results;
}

/**
 * Auto-heal unhealthy agents
 */
export async function autoHealAgents(): Promise<{
  healed: string[];
  failed: string[];
}> {
  const healthMap = await checkAllHealth();
  const healed: string[] = [];
  const failed: string[] = [];

  for (const agentId of Array.from(healthMap.keys())) {
    const state = healthMap.get(agentId)!;
    const agent = await getAgent(agentId);
    if (!agent || agent.status !== "active") continue;

    if (state.healthStatus === "unhealthy" || state.healthStatus === "degraded") {
      console.log(`[Lifecycle] Auto-healing agent ${agentId} (status: ${state.healthStatus})`);
      try {
        // Stop and restart
        await stopAgent(agentId);
        await activateAgent(agentId);
        healed.push(agentId);
      } catch (error) {
        console.error(`[Lifecycle] Failed to heal ${agentId}:`, error);
        failed.push(agentId);
      }
    }
  }

  return { healed, failed };
}

// ============================================
// Summary / Dashboard Data
// ============================================

export interface LifecycleSummary {
  totalAgents: number;
  activeAgents: number;
  runningRunners: number;
  registeredWithAIP: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  stopped: number;
  agents: Array<{
    id: string;
    name: string;
    status: Agent["status"];
    runnerActive: boolean;
    aipRegistered: boolean;
    healthStatus: AgentLifecycleState["healthStatus"];
    tickCount: number;
    lastTickAt: number | null;
    errorCount: number;
  }>;
}

export async function getLifecycleSummary(): Promise<LifecycleSummary> {
  const agents = await getAllAgents();
  const runnerStates = getAllRunnerStates();
  const aipAgents = getRegisteredAIPAgents();
  
  await checkAllHealth();

  const summary: LifecycleSummary = {
    totalAgents: agents.length,
    activeAgents: agents.filter(a => a.status === "active").length,
    runningRunners: runnerStates.filter(r => r.isRunning).length,
    registeredWithAIP: aipAgents.length,
    healthy: 0,
    degraded: 0,
    unhealthy: 0,
    stopped: 0,
    agents: [],
  };

  for (const agent of agents) {
    const runner = runnerStates.find(r => r.agentId === agent.id);
    const lifecycle = lifecycleStates.get(agent.id);
    const aip = aipAgents.find(a => a.hyperClawAgentId === agent.id);

    const healthStatus = lifecycle?.healthStatus ?? "stopped";
    
    switch (healthStatus) {
      case "healthy": summary.healthy++; break;
      case "degraded": summary.degraded++; break;
      case "unhealthy": summary.unhealthy++; break;
      case "stopped": summary.stopped++; break;
    }

    summary.agents.push({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      runnerActive: runner?.isRunning ?? false,
      aipRegistered: !!aip,
      healthStatus,
      tickCount: runner?.tickCount ?? 0,
      lastTickAt: runner?.lastTickAt ?? null,
      errorCount: runner?.errors.length ?? 0,
    });
  }

  return summary;
}

// ============================================
// Initialization (call on server start)
// ============================================

async function ensureActiveAgentsRunning(): Promise<{
  restarted: string[];
  failed: string[];
}> {
  const agents = await getAllAgents();
  const activeAgents = agents.filter(a => a.status === "active");
  const restarted: string[] = [];
  const failed: string[] = [];

  for (const agent of activeAgents) {
    const runner = getRunnerState(agent.id);
    if (runner?.isRunning) continue;

    try {
      await activateAgent(agent.id, { skipAIP: true });
      restarted.push(agent.id);
    } catch (error) {
      console.error(`[Lifecycle] Failed to recover runner for ${agent.id}:`, error);
      failed.push(agent.id);
    }
  }

  return { restarted, failed };
}

export async function initializeAgentLifecycle(): Promise<void> {
  if (lifecycleGlobals.initialized) {
    const { restarted, failed } = await ensureActiveAgentsRunning();
    if (restarted.length > 0 || failed.length > 0) {
      console.log(
        `[Lifecycle] Reconciliation complete: restarted ${restarted.length}, failed ${failed.length}`
      );
    } else {
      console.log("[Lifecycle] Already initialized, all active runners healthy.");
    }
    return;
  }

  console.log("[Lifecycle] Initializing agent lifecycle manager...");
  
  // Start all active agents
  const { started, failed } = await startAllActiveAgents();
  
  console.log(`[Lifecycle] Initialization complete:`);
  console.log(`  - Started: ${started.length} agents`);
  console.log(`  - Failed: ${failed.length} agents`);
  
  // Set up periodic health checks (every 5 minutes)
  if (!lifecycleGlobals.healthCheckInterval) {
    lifecycleGlobals.healthCheckInterval = setInterval(async () => {
      try {
        const { healed, failed } = await autoHealAgents();
        if (healed.length > 0 || failed.length > 0) {
          console.log(`[Lifecycle] Health check: healed ${healed.length}, failed ${failed.length}`);
        }
      } catch (error) {
        console.error("[Lifecycle] Health check failed:", error);
      }
    }, 5 * 60 * 1000);
  }

  lifecycleGlobals.initialized = true;
}
