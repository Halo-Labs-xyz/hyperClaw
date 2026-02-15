#!/usr/bin/env node

/**
 * HyperClaw CLI - Professional CLI for Railway dapp and IronClaw
 *
 * Usage:
 *   hc config --base-url https://your-app.up.railway.app --api-key <key>
 *   hc agents list
 *   hc agents create --name "My Agent" --markets BTC,ETH --risk moderate
 *   hc fund provision <agentId> --amount 100
 *   hc deposit info <agentId>
 *   hc arena
 *   hc ironclaw chat "Hello"
 */

import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { config as loadDotenv } from "dotenv";
import { readFileSync } from "fs";
import { join } from "path";

// Load .env before any config reads
loadDotenv({ path: join(process.cwd(), ".env") });
loadDotenv({ path: join(process.cwd(), ".env.local") });

import { getConfig, saveConfig, getConfigPath } from "./lib/config.mjs";
import {
  apiGet,
  apiPost,
  apiPostAgents,
  apiGetAgents,
  apiGetAgent,
  apiAgentTick,
  apiAgentApprove,
  apiAgentChatGet,
  apiAgentChatPost,
  apiOrchestratorAgents,
  apiGetMarkets,
  apiFund,
  apiGetDeposit,
  apiIronclaw,
  apiIronclawHealth,
  ApiError,
} from "./lib/api.mjs";

const program = new Command();

let VERSION = "1.0.0";
try {
  const pkgPath = new URL("./package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg?.version) VERSION = String(pkg.version);
} catch {
  // Keep fallback version.
}

program
  .name("hc")
  .description("HyperClaw CLI - Interact with Railway dapp and IronClaw")
  .version(VERSION);

// ========== TUI ==========
program
  .command("tui")
  .description("Launch interactive TUI (dashboard, agents, arena, fund, IronClaw)")
  .action(async () => {
    await import("./tui/index.mjs");
  });

// ========== Config ==========
program
  .command("config")
  .description("Configure CLI (base URL, API key, Privy identity)")
  .option("-u, --base-url <url>", "Railway app base URL")
  .option("-k, --api-key <key>", "API key for authenticated routes")
  .option("--privy-id <id>", "Privy user ID (from web app)")
  .option("--wallet <address>", "Wallet address (from web app)")
  .option("--network <mainnet|testnet>", "Network")
  .option("--show", "Show current config")
  .action(async (opts) => {
    if (opts.show) {
      const cfg = getConfig();
      console.log(chalk.cyan("\nCurrent config:"));
      console.log("  Base URL:", cfg.baseUrl || chalk.dim("(not set)"));
      console.log("  API Key:", cfg.apiKey ? chalk.green("***") : chalk.dim("(not set)"));
      console.log("  Privy ID:", cfg.privyId || chalk.dim("(not set)"));
      console.log("  Wallet:", cfg.walletAddress || chalk.dim("(not set)"));
      console.log("  Network:", cfg.network);
      console.log("\nConfig file:", getConfigPath());
      return;
    }
    const updates = {};
    if (opts.baseUrl) updates.baseUrl = opts.baseUrl;
    if (opts.apiKey) updates.apiKey = opts.apiKey;
    if (opts.privyId) updates.privyId = opts.privyId;
    if (opts.wallet) updates.walletAddress = opts.wallet;
    if (opts.network) updates.network = opts.network;
    if (Object.keys(updates).length === 0) {
      console.log(chalk.yellow("No options provided. Use --show to view config."));
      const answers = await inquirer.prompt([
        { type: "input", name: "baseUrl", message: "Base URL (e.g. https://your-app.up.railway.app):", default: getConfig().baseUrl },
        { type: "password", name: "apiKey", message: "API key (HYPERCLAW_API_KEY):", default: getConfig().apiKey },
      ]);
      if (answers.baseUrl) updates.baseUrl = answers.baseUrl;
      if (answers.apiKey) updates.apiKey = answers.apiKey;
    }
    if (Object.keys(updates).length > 0) {
      saveConfig(updates);
      console.log(chalk.green("Config saved."));
    }
  });

// ========== Login (Privy instructions) ==========
program
  .command("login")
  .description("Get Privy connection instructions")
  .action(() => {
    const { baseUrl } = getConfig();
    const url = baseUrl ? `${baseUrl}/` : "https://your-app.up.railway.app";
    console.log(chalk.cyan("\nConnect your Privy wallet:\n"));
    console.log("  1. Open the web app:", chalk.underline(url));
    console.log("  2. Click 'Connect Wallet' and sign in with Privy");
    console.log("  3. Copy your Privy ID from the dashboard");
    console.log("  4. Copy your wallet address");
    console.log("\nThen run:");
    console.log(chalk.gray("  hc config --privy-id <your-privy-id> --wallet 0x..."));
    console.log("\nThis links your agents to your identity for ownership.\n");
  });

async function resolveAgentIdPrefix(id) {
  if (!id) return id;
  if (id.length >= 32) return id;
  const list = await apiGetAgents().catch(() => ({ agents: [] }));
  const match = (list?.agents ?? []).find((a) =>
    a.id?.toLowerCase().startsWith(id.toLowerCase())
  );
  return match?.id ?? id;
}

// ========== Agents ==========
const agents = program.command("agents").description("Manage trading agents");

agents
  .command("list")
  .description("List all agents")
  .option("-n, --network <mainnet|testnet>", "Filter by network")
  .option("--explore", "Explore view (active agents)")
  .option("-v, --verbose", "Show full agent IDs")
  .action(async (opts) => {
    const spinner = ora("Fetching agents...").start();
    try {
      const params = new URLSearchParams();
      if (opts.network) params.set("network", opts.network);
      if (opts.explore) params.set("view", "explore");
      const data = await apiGetAgents(params.toString());
      spinner.succeed("Agents loaded");
      const list = data?.agents ?? [];
      if (list.length === 0) {
        console.log(chalk.dim("\nNo agents found. Create one with: hc agents create\n"));
        return;
      }
      console.log(chalk.cyan("\nAgents:\n"));
      for (const a of list) {
        const status =
          a.status === "active"
            ? chalk.green("active")
            : a.status === "paused"
              ? chalk.yellow("paused")
              : chalk.gray(a.status ?? "unknown");
        const markets = (a.markets ?? []).slice(0, 5).join(", ");
        const tvl = a.vaultTvlUsd != null ? `$${Number(a.vaultTvlUsd).toLocaleString()}` : "";
        const idDisplay = opts.verbose ? (a.id ?? "?") : (a.id?.length > 8 ? a.id.slice(0, 8) + "..." : a.id ?? "?");
        console.log(`  ${chalk.bold(a.name ?? "?")} ${chalk.dim(idDisplay)}`);
        console.log(`    Status: ${status} | Markets: ${markets} | TVL: ${tvl}`);
        console.log();
      }
    } catch (e) {
      spinner.fail(e.message);
      if (e instanceof ApiError && e.status === 401) {
        console.log(chalk.dim("  Set API key: hc config --api-key <key>"));
      }
      process.exit(1);
    }
  });

agents
  .command("create")
  .description("Create a new agent (interactive or with flags)")
  .option("-n, --name <name>", "Agent name")
  .option("-d, --description <desc>", "Agent description")
  .option("-m, --markets <list>", "Comma-separated markets (e.g. BTC,ETH,SOL)")
  .option("-l, --leverage <n>", "Max leverage (1-50)", "5")
  .option("-r, --risk <level>", "Risk: conservative|moderate|aggressive", "moderate")
  .option("--stop-loss <pct>", "Stop loss %", "5")
  .option("--autonomy <mode>", "full|semi|manual", "semi")
  .option("--aggressiveness <0-100>", "Trading aggressiveness", "50")
  .option("--max-trades <n>", "Max trades per day", "10")
  .option("--network <mainnet|testnet>", "Deployment network")
  .option("-y, --yes", "Skip confirmation")
  .action(async (opts) => {
    let name = opts.name;
    let description = opts.description ?? "";
    let markets = opts.markets ? opts.markets.split(",").map((s) => s.trim()).filter(Boolean) : [];
    let riskLevel = opts.risk;
    let maxLeverage = parseInt(opts.leverage, 10) || 5;
    let stopLoss = parseFloat(opts.stopLoss) || 5;
    let autonomyMode = opts.autonomy ?? "semi";
    let aggressiveness = parseInt(opts.aggressiveness, 10) || 50;
    let maxTradesPerDay = parseInt(opts.maxTrades, 10) || 10;

    if (!opts.yes && (!name || markets.length === 0)) {
      const allMarkets = await apiGetMarkets().catch(() => ({ perps: [] }));
      const perpNames = (allMarkets.perps ?? []).filter((p) => !p.isDelisted).map((p) => p.name);
      const questions = [
        { type: "input", name: "name", message: "Agent name:", default: name, validate: (v) => (v?.trim() ? true : "Required") },
        { type: "input", name: "description", message: "Description:", default: description },
        {
          type: "checkbox",
          name: "markets",
          message: "Select markets:",
          choices: perpNames.slice(0, 30).map((m) => ({ name: m, value: m })),
          default: ["BTC", "ETH"],
        },
        { type: "list", name: "riskLevel", message: "Risk level:", choices: ["conservative", "moderate", "aggressive"], default: riskLevel },
        { type: "number", name: "maxLeverage", message: "Max leverage:", default: maxLeverage },
        { type: "list", name: "autonomyMode", message: "Autonomy:", choices: ["manual", "semi", "full"], default: autonomyMode },
      ];
      const answers = await inquirer.prompt(questions);
      name = answers.name;
      description = answers.description ?? "";
      markets = answers.markets?.length ? answers.markets : ["BTC", "ETH"];
      riskLevel = answers.riskLevel;
      maxLeverage = answers.maxLeverage ?? 5;
      autonomyMode = answers.autonomyMode ?? "semi";
    }

    if (!name?.trim()) {
      console.error(chalk.red("Agent name is required."));
      process.exit(1);
    }
    if (markets.length === 0) {
      console.error(chalk.red("Select at least one market."));
      process.exit(1);
    }

    const cfg = getConfig();
    const network = opts.network ?? cfg.network ?? "mainnet";

    const body = {
      name: name.trim(),
      description: description.trim(),
      markets,
      maxLeverage,
      riskLevel,
      stopLossPercent: stopLoss,
      autonomy: {
        mode: autonomyMode,
        aggressiveness,
        maxTradesPerDay,
        approvalTimeoutMs: 5 * 60 * 1000,
      },
      network,
    };
    if (cfg.privyId) body.ownerPrivyId = cfg.privyId;
    if (cfg.walletAddress) body.ownerWalletAddress = cfg.walletAddress;

    const spinner = ora("Creating agent...").start();
    try {
      const data = await apiPostAgents(body);
      spinner.succeed("Agent created");
      const agent = data?.agent ?? data;
      const id = agent?.id;
      console.log(chalk.green("\nAgent created successfully!\n"));
      console.log("  ID:", chalk.bold(id));
      console.log("  Name:", agent?.name);
      console.log("  Markets:", (agent?.markets ?? []).join(", "));
      console.log("  Status:", agent?.status ?? "paused");
      if (data?.attestation?.txHash) {
        console.log("  Attestation:", chalk.dim(data.attestation.txHash.slice(0, 18) + "..."));
      }
      console.log(chalk.cyan("\nNext steps:"));
      console.log("  1. Fund the agent:  hc fund provision", id, "--amount 100");
      console.log("  2. Or deposit via vault: hc deposit info", id);
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

agents
  .command("get <id>")
  .description("Get agent details, state, and memory")
  .option("--state", "Include HL trading state")
  .option("--trades", "Include trade history")
  .action(async (id, opts) => {
    if (!id) {
      console.error(chalk.red("Agent ID required."));
      process.exit(1);
    }
    const agentId = await resolveAgentIdPrefix(id);
    const spinner = ora("Fetching agent...").start();
    try {
      const [agentData, fundStatus] = await Promise.all([
        apiGetAgent(agentId),
        apiFund({ action: "agent-balance", agentId, includePnl: true }).catch(() => null),
      ]);
      spinner.succeed("Agent loaded");
      const agent = agentData?.agent ?? agentData;
      if (!agent) {
        console.error(chalk.red("Agent not found."));
        process.exit(1);
      }

      console.log(chalk.cyan("\n" + (agent.name ?? "Agent") + "\n"));
      console.log("  ID:", agent.id);
      console.log("  Status:", agent.status);
      console.log("  Markets:", (agent.markets ?? []).join(", "));
      console.log("  Risk:", agent.riskLevel);
      console.log("  Max Leverage:", agent.maxLeverage);
      console.log("  Autonomy:", agent.autonomy?.mode ?? "semi");
      console.log("  HL Address:", agent.hlAddress ?? chalk.dim("(not provisioned)"));

      if (fundStatus?.hasWallet) {
        console.log(chalk.cyan("\nBalance:"));
        console.log("  Account Value:", fundStatus.accountValue ?? "$0");
        console.log("  Available:", fundStatus.availableBalance ?? "$0");
        console.log("  Total PnL:", fundStatus.totalPnl != null ? `$${Number(fundStatus.totalPnl).toFixed(2)}` : "N/A");
        console.log("  Open Positions:", fundStatus.openPositions ?? 0);
      }

      if (opts.state) {
        const stateRes = await apiFund({ action: "agent-state", agentId }).catch(() => null);
        if (stateRes?.positions?.length) {
          console.log(chalk.cyan("\nPositions:"));
          for (const p of stateRes.positions) {
            console.log(`  ${p.coin} ${p.side} size=${p.szi} entry=$${p.entryPx ?? "?"}`);
          }
        }
      }

      const trades = agentData?.trades ?? [];
      if (opts.trades && trades.length > 0) {
        console.log(chalk.cyan("\nRecent trades:"));
        for (const t of trades.slice(-5)) {
          const d = t.decision;
          console.log(`  ${d?.action} ${d?.asset} @ ${(d?.confidence ?? 0) * 100}% - ${d?.reasoning?.slice(0, 50)}...`);
        }
      }

      const lifecycle = agentData?.lifecycle;
      if (lifecycle) {
        console.log(chalk.cyan("\nLifecycle:"));
        console.log("  Running:", lifecycle.isRunning ? chalk.green("yes") : chalk.gray("no"));
        console.log("  Last tick:", lifecycle.lastTickAt ? new Date(lifecycle.lastTickAt).toISOString() : "N/A");
      }

      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

agents
  .command("tick <id>")
  .description("Trigger a single trading tick for an agent")
  .option("--json", "Output raw JSON")
  .action(async (id, opts) => {
    const agentId = await resolveAgentIdPrefix(id);
    const spinner = ora("Running tick...").start();
    try {
      const data = await apiAgentTick(agentId, { action: "tick" });
      spinner.succeed("Tick complete");
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      const d = data?.decision ?? data?.tradeLog?.decision;
      console.log(chalk.cyan("\nTick result:\n"));
      if (d) {
        console.log("  Decision:", `${d.action} ${d.asset} size=${d.size} lev=${d.leverage}`);
        console.log("  Confidence:", `${Math.round((d.confidence ?? 0) * 100)}%`);
        if (d.reasoning) console.log("  Reasoning:", d.reasoning);
      }
      console.log("  Executed:", data?.executed ? chalk.green("yes") : chalk.yellow("no"));
      if (data?.executionResult?.status) {
        console.log("  Execution:", `${data.executionResult.status} price=${data.executionResult.fillPrice} size=${data.executionResult.fillSize}`);
      }
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

const runner = agents.command("runner").description("Manage agent autonomous runner");

runner
  .command("status <id>")
  .description("Get runner status")
  .option("--json", "Output raw JSON")
  .action(async (id, opts) => {
    const agentId = await resolveAgentIdPrefix(id);
    const spinner = ora("Fetching runner status...").start();
    try {
      const data = await apiAgentTick(agentId, { action: "status" });
      spinner.succeed("Runner status");
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(chalk.cyan("\nRunner:\n"));
      console.log("  Running:", data?.running ? chalk.green("yes") : chalk.gray("no"));
      if (data?.state?.intervalMs) console.log("  Interval:", `${data.state.intervalMs}ms`);
      if (data?.state?.lastTickAt) console.log("  Last tick:", new Date(data.state.lastTickAt).toISOString());
      if (data?.state?.nextTickAt) console.log("  Next tick:", new Date(data.state.nextTickAt).toISOString());
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

runner
  .command("start <id>")
  .description("Start autonomous runner")
  .option("--interval-ms <ms>", "Tick interval in ms (clamped server-side)")
  .option("--json", "Output raw JSON")
  .action(async (id, opts) => {
    const agentId = await resolveAgentIdPrefix(id);
    const intervalMs = opts.intervalMs != null ? Number.parseInt(String(opts.intervalMs), 10) : undefined;
    const spinner = ora("Starting runner...").start();
    try {
      const data = await apiAgentTick(agentId, { action: "start", ...(Number.isFinite(intervalMs) ? { intervalMs } : {}) });
      spinner.succeed("Runner started");
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(chalk.green("\nRunner started.\n"));
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

runner
  .command("stop <id>")
  .description("Stop autonomous runner")
  .option("--json", "Output raw JSON")
  .action(async (id, opts) => {
    const agentId = await resolveAgentIdPrefix(id);
    const spinner = ora("Stopping runner...").start();
    try {
      const data = await apiAgentTick(agentId, { action: "stop" });
      spinner.succeed("Runner stopped");
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(chalk.green("\nRunner stopped.\n"));
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

agents
  .command("approve <id> <approvalId>")
  .description("Approve or reject a pending trade (semi-autonomous mode)")
  .option("--reject", "Reject instead of approve")
  .option("--json", "Output raw JSON")
  .action(async (id, approvalId, opts) => {
    const agentId = await resolveAgentIdPrefix(id);
    const action = opts.reject ? "reject" : "approve";
    const spinner = ora(`${action === "approve" ? "Approving" : "Rejecting"} trade...`).start();
    try {
      const data = await apiAgentApprove(agentId, { approvalId, action });
      spinner.succeed(`Trade ${action}d`);
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(chalk.cyan(`\n${data?.message ?? `Trade ${action}d`}\n`));
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

const agentChat = agents.command("chat").description("Vault chat for an agent");

agentChat
  .command("list <id>")
  .description("List recent vault chat messages")
  .option("--limit <n>", "Max messages", "25")
  .option("--json", "Output raw JSON")
  .action(async (id, opts) => {
    const agentId = await resolveAgentIdPrefix(id);
    const limit = Math.max(1, Math.min(200, Number.parseInt(String(opts.limit), 10) || 25));
    const spinner = ora("Fetching messages...").start();
    try {
      const data = await apiAgentChatGet(agentId, `limit=${limit}`);
      spinner.succeed("Messages loaded");
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      const msgs = data?.messages ?? [];
      console.log(chalk.cyan(`\nMessages (${msgs.length}):\n`));
      for (const m of msgs) {
        const ts = m.timestamp ? new Date(m.timestamp).toISOString() : "";
        const who = m.senderName ? `${m.senderName}` : `${m.sender ?? "?"}`;
        console.log(`${chalk.dim(ts)} ${chalk.bold(who)}: ${m.content ?? ""}`);
      }
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

agentChat
  .command("send <id> <message>")
  .description("Send a vault chat message")
  .option("--name <name>", "Sender name", "CLI")
  .option("--type <discussion|question>", "Message type", "discussion")
  .option("--json", "Output raw JSON")
  .action(async (id, message, opts) => {
    const agentId = await resolveAgentIdPrefix(id);
    const spinner = ora("Sending message...").start();
    try {
      const data = await apiAgentChatPost(agentId, {
        content: message,
        senderName: opts.name,
        type: opts.type,
      });
      spinner.succeed("Message sent");
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (data?.aiResponse) {
        console.log(chalk.cyan("\nAgent:\n"));
        console.log(data.aiResponse);
        console.log();
      }
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

// ========== Fund ==========
const fund = program.command("fund").description("Fund agents and manage vault");

fund
  .command("status")
  .description("System funding status")
  .action(async () => {
    const spinner = ora("Checking status...").start();
    try {
      const data = await apiFund({ action: "status" });
      spinner.succeed("Status");
      console.log(chalk.cyan("\nFunding status:"));
      console.log("  Network:", data.network ?? "mainnet");
      console.log("  Configured:", data.configured ? chalk.green("yes") : chalk.red("no"));
      console.log("  Vault:", data.vaultAddress ?? chalk.dim("(not set)"));
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      if (e instanceof ApiError && e.status === 401) {
        console.log(chalk.dim("  Set API key: hc config --api-key <key>"));
      }
      process.exit(1);
    }
  });

fund
  .command("provision <agentId>")
  .description("Provision agent wallet and fund with USDC")
  .option("-a, --amount <n>", "Amount in USD to fund", "100")
  .option("--no-activate", "Do not auto-activate agent")
  .action(async (agentId, opts) => {
    if (!agentId) {
      console.error(chalk.red("Agent ID required."));
      process.exit(1);
    }
    const amount = parseFloat(opts.amount) || 100;
    const spinner = ora(`Provisioning and funding $${amount}...`).start();
    try {
      const data = await apiFund({
        action: "provision",
        agentId,
        amount,
        autoActivate: opts.activate !== false,
      });
      spinner.succeed("Provisioned and funded");
      console.log(chalk.green("\nAgent funded and activated!\n"));
      console.log("  HL Address:", data.hlAddress);
      console.log("  Amount:", `$${data.fundedAmount ?? amount}`);
      console.log("  Network:", data.network);
      if (data.lifecycle) {
        console.log("  Lifecycle:", data.lifecycle.isRunning ? chalk.green("running") : chalk.gray("paused"));
      }
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

fund
  .command("balance <agentId>")
  .description("Get agent balance")
  .action(async (agentId) => {
    if (!agentId) {
      console.error(chalk.red("Agent ID required."));
      process.exit(1);
    }
    const spinner = ora("Fetching balance...").start();
    try {
      const data = await apiFund({ action: "agent-balance", agentId, includePnl: true });
      spinner.succeed("Balance");
      if (!data.hasWallet) {
        console.log(chalk.yellow("\nAgent has no wallet. Run: hc fund provision", agentId, "\n"));
        return;
      }
      console.log(chalk.cyan("\nBalance:"));
      console.log("  Account Value:", data.accountValue ?? "$0");
      console.log("  Available:", data.availableBalance ?? "$0");
      console.log("  Margin Used:", data.marginUsed ?? "$0");
      console.log("  Total PnL:", data.totalPnl != null ? `$${Number(data.totalPnl).toFixed(2)}` : "N/A");
      console.log("  Open Positions:", data.openPositions ?? 0);
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

fund
  .command("operator-balance")
  .description("Get operator wallet balance (perp + spot)")
  .action(async () => {
    const spinner = ora("Fetching operator balance...").start();
    try {
      const data = await apiFund({ action: "operator-balance" });
      spinner.succeed("Operator balance");
      console.log(chalk.cyan("\nOperator:"));
      console.log("  Address:", data.operatorAddress ?? "N/A");
      console.log("  Network:", data.network ?? "mainnet");
      console.log(chalk.cyan("\nPerp:"));
      console.log("  Account Value:", data.perp?.accountValue ?? "$0");
      console.log("  Available:", data.perp?.availableBalance ?? "$0");
      console.log("  Margin Used:", data.perp?.marginUsed ?? "$0");
      console.log(chalk.cyan("\nSpot:"));
      console.log("  USDC:", data.spot?.usdc ?? "N/A");
      if (data.stale) console.log(chalk.yellow("\nStale:"), data.error ?? "unknown error");
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

fund
  .command("disable-unified")
  .description("Disable unified account mode on the operator wallet (required for usdSend)")
  .action(async () => {
    const spinner = ora("Disabling unified account mode...").start();
    try {
      const data = await apiFund({ action: "disable-unified" });
      spinner.succeed("Unified account disabled");
      console.log(chalk.cyan("\nOperator:"));
      console.log("  Address:", data.operatorAddress ?? "N/A");
      console.log("  Abstraction:", data.abstraction ?? "disabled");
      console.log("  Network:", data.network ?? "mainnet");
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

fund
  .command("activate <agentId>")
  .description("Activate agent (start trading)")
  .action(async (agentId) => {
    if (!agentId) {
      console.error(chalk.red("Agent ID required."));
      process.exit(1);
    }
    const spinner = ora("Activating...").start();
    try {
      const data = await apiFund({ action: "activate", agentId });
      spinner.succeed("Activated");
      console.log(chalk.green("\nAgent is now active and trading.\n"));
      if (data.lifecycle) {
        console.log("  Lifecycle:", data.lifecycle.isRunning ? chalk.green("running") : chalk.gray("paused"));
      }
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

// ========== Deposit ==========
const deposit = program.command("deposit").description("Vault deposit info");

deposit
  .command("info <agentId>")
  .description("Get deposit info and instructions for an agent")
  .action(async (agentId) => {
    if (!agentId) {
      console.error(chalk.red("Agent ID required."));
      process.exit(1);
    }
    const spinner = ora("Fetching deposit info...").start();
    try {
      const [depositData, fundStatus] = await Promise.all([
        apiGetDeposit(agentId),
        apiFund({ action: "status" }).catch(() => null),
      ]);
      spinner.succeed("Deposit info");
      const vaultAddress = fundStatus?.vaultAddress;
      console.log(chalk.cyan("\nDeposit for agent:"), agentId.slice(0, 8) + "...");
      console.log("  TVL:", `$${Number(depositData?.tvlUsd ?? 0).toLocaleString()}`);
      console.log("  Deposits:", (depositData?.deposits ?? []).length);
      if (vaultAddress) {
        console.log(chalk.cyan("\nVault address:"));
        console.log(" ", vaultAddress);
        console.log(chalk.dim("\nTo deposit:"));
        console.log("  1. Open the web app and connect your wallet");
        console.log("  2. Go to your agent page");
        console.log("  3. Use the Deposit section to send MON or USDT to the vault");
        console.log("  4. After tx confirms, run: hc deposit confirm <txHash>");
      } else {
        console.log(chalk.yellow("\nVault address not available from API."));
      }
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

deposit
  .command("confirm <txHash>")
  .description("Confirm a vault deposit transaction")
  .option("-n, --network <mainnet|testnet>", "Network")
  .action(async (txHash, opts) => {
    if (!txHash || !txHash.startsWith("0x")) {
      console.error(chalk.red("Valid tx hash (0x...) required."));
      process.exit(1);
    }
    const spinner = ora("Confirming deposit...").start();
    try {
      const data = await apiPost("/api/deposit", { txHash, network: opts.network });
      spinner.succeed("Deposit confirmed");
      if (data.eventType === "deposit") {
        const d = data.deposit;
        console.log(chalk.green("\nDeposit recorded:"));
        console.log("  Agent:", d.agentId?.slice(0, 8) + "...");
        console.log("  Amount:", d.amount, d.token ?? "MON");
        console.log("  USD Value:", `$${Number(d.usdValue ?? 0).toFixed(2)}`);
        console.log("  HL Funded:", d.hlFunded ? chalk.green("yes") : chalk.yellow("pending"));
      }
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

// ========== Arena ==========
program
  .command("arena")
  .description("View arena - active agents and leaderboard")
  .option("-n, --network <mainnet|testnet>", "Network")
  .action(async (opts) => {
    const spinner = ora("Loading arena...").start();
    try {
      const params = new URLSearchParams({ view: "explore", scope: "all" });
      if (opts.network) params.set("network", opts.network);
      const data = await apiGetAgents(params.toString());
      spinner.succeed("Arena loaded");
      const list = (data?.agents ?? []).filter((a) => a.status === "active");
      if (list.length === 0) {
        console.log(chalk.dim("\nNo active agents in arena.\n"));
        return;
      }
      console.log(chalk.cyan("\nArena - Active Agents\n"));
      const withPnl = await Promise.all(
        list.map(async (a) => {
          try {
            const bal = await apiFund({ action: "agent-balance", agentId: a.id, includePnl: true });
            return { ...a, totalPnl: bal?.totalPnl ?? 0 };
          } catch {
            return { ...a, totalPnl: 0 };
          }
        })
      );
      withPnl.sort((a, b) => (b.totalPnl ?? 0) - (a.totalPnl ?? 0));
      withPnl.forEach((a, i) => {
        const pnl = a.totalPnl ?? 0;
        const pnlStr = pnl >= 0 ? chalk.green(`+$${pnl.toFixed(2)}`) : chalk.red(`-$${Math.abs(pnl).toFixed(2)}`);
        const rank = String(i + 1).padStart(2, " ");
        console.log(`  #${rank} ${chalk.bold(a.name)} ${chalk.dim(a.id?.slice(0, 8))} PnL: ${pnlStr}`);
        console.log(`     Markets: ${(a.markets ?? []).join(", ")} | Risk: ${a.riskLevel}`);
      });
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

// ========== IronClaw ==========
const ironclaw = program.command("ironclaw").description("IronClaw assistant (AWS instance)");

ironclaw
  .command("health")
  .description("Check IronClaw health")
  .action(async () => {
    const spinner = ora("Checking IronClaw...").start();
    try {
      const data = await apiIronclawHealth();
      spinner.succeed("IronClaw healthy");
      console.log(chalk.cyan("\nIronClaw:"));
      console.log("  Configured:", data.configured ? chalk.green("yes") : chalk.red("no"));
      console.log("  Status:", data.ironclaw ?? "unknown");
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      if (e instanceof ApiError && e.status === 401) {
        console.log(chalk.dim("  Set API key: hc config --api-key <key>"));
      } else if (e instanceof ApiError && e.status === 503) {
        console.log(chalk.dim("  IronClaw webhook not configured or unreachable."));
      }
      process.exit(1);
    }
  });

ironclaw
  .command("chat <message>")
  .description("Send a message to IronClaw assistant")
  .option("-t, --thread <id>", "Thread ID for conversation")
  .option("--no-wait", "Don't wait for response")
  .action(async (message, opts) => {
    if (!message) {
      console.error(chalk.red("Message required."));
      process.exit(1);
    }
    const spinner = ora("Sending to IronClaw...").start();
    try {
      const body = { content: message, wait_for_response: opts.wait !== false };
      if (opts.thread) body.thread_id = opts.thread;
      const data = await apiIronclaw(body);
      spinner.succeed("Response received");
      if (data?.response) {
        console.log(chalk.cyan("\nIronClaw:\n"));
        console.log(data.response);
        console.log();
      } else {
        console.log(chalk.dim("\nMessage sent. Message ID:", data?.message_id ?? "N/A"));
        console.log();
      }
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

// ========== Orchestrator ==========
program
  .command("orchestrator")
  .description("List active agents and schedule bounds for the external orchestrator")
  .option("--json", "Output raw JSON")
  .action(async (opts) => {
    const spinner = ora("Loading orchestrator view...").start();
    try {
      const data = await apiOrchestratorAgents();
      spinner.succeed("Orchestrator view loaded");
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(chalk.cyan("\nSchedule:\n"));
      console.log("  Min interval:", `${data?.schedule?.tickIntervalMinMs ?? "?"}ms`);
      console.log("  Max interval:", `${data?.schedule?.tickIntervalMaxMs ?? "?"}ms`);
      const list = data?.agents ?? [];
      console.log(chalk.cyan(`\nActive agents (${list.length}):\n`));
      for (const a of list) {
        console.log(`  ${chalk.bold(a.name ?? "?")} ${chalk.dim(a.id?.slice(0, 8) ?? "")}`);
      }
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

// ========== Doctor ==========
program
  .command("doctor")
  .description("Validate config and connectivity")
  .option("--json", "Output raw JSON")
  .action(async (opts) => {
    const cfg = getConfig();
    const report = {
      configPath: getConfigPath(),
      baseUrl: cfg.baseUrl || null,
      apiKeyConfigured: Boolean(cfg.apiKey),
      network: cfg.network,
      health: null,
      ironclaw: null,
    };

    if (!cfg.baseUrl) {
      if (opts.json) console.log(JSON.stringify({ ...report, error: "baseUrl_not_configured" }, null, 2));
      console.error(chalk.red("Base URL not configured. Run: hc config --base-url <URL>"));
      process.exit(1);
    }

    const spinner = ora("Checking API health...").start();
    try {
      report.health = await apiGet("/api/health");
      spinner.succeed("API reachable");
    } catch (e) {
      spinner.fail("API unreachable");
      if (opts.json) console.log(JSON.stringify({ ...report, error: e.message }, null, 2));
      process.exit(1);
    }

    try {
      report.ironclaw = await apiIronclawHealth();
    } catch (e) {
      // Optional; ignore
    }

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(chalk.cyan("\nDoctor:\n"));
    console.log("  Config:", report.configPath);
    console.log("  Base URL:", report.baseUrl);
    console.log("  API key:", report.apiKeyConfigured ? chalk.green("set") : chalk.yellow("missing"));
    console.log("  Network:", report.network);
    console.log("  API health:", report.health?.healthy ? chalk.green("healthy") : chalk.red("unhealthy"));
    if (report.ironclaw?.configured != null) {
      console.log("  IronClaw:", report.ironclaw.configured ? chalk.green("configured") : chalk.yellow("not configured"));
    }
    console.log();
  });

// ========== Init (guided setup) ==========
program
  .command("init")
  .description("Guided setup - configure and create your first agent")
  .action(async () => {
    console.log(chalk.cyan("\nHyperClaw CLI - Guided Setup\n"));
    const cfg = getConfig();
    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "baseUrl",
        message: "Railway app URL:",
        default: cfg.baseUrl || "https://your-app.up.railway.app",
      },
      {
        type: "password",
        name: "apiKey",
        message: "API key (optional for read-only):",
        default: cfg.apiKey,
      },
      {
        type: "confirm",
        name: "createAgent",
        message: "Create an agent now?",
        default: true,
      },
    ]);
    saveConfig({
      baseUrl: answers.baseUrl,
      ...(answers.apiKey ? { apiKey: answers.apiKey } : {}),
    });
    console.log(chalk.green("\nConfig saved.\n"));
    if (answers.createAgent) {
      console.log(chalk.dim("Run: hc agents create\n"));
    } else {
      console.log(chalk.dim("Run: hc agents list | hc arena | hc health\n"));
    }
  });

// ========== Health ==========
program
  .command("health")
  .description("Check API health")
  .action(async () => {
    const spinner = ora("Checking API...").start();
    try {
      const data = await apiGet("/api/health");
      spinner.succeed("API healthy");
      console.log(chalk.cyan("\nHealth:"));
      console.log("  Healthy:", data.healthy ? chalk.green("yes") : chalk.red("no"));
      console.log("  Timestamp:", new Date(data.timestamp).toISOString());
      if (data.bootstrap) {
        console.log("  Bootstrap:", Object.keys(data.bootstrap).join(", "));
      }
      console.log();
    } catch (e) {
      spinner.fail(e.message);
      process.exit(1);
    }
  });

program.parse();
