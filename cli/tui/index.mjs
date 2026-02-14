#!/usr/bin/env node

/**
 * HyperClaw TUI - Interactive terminal UI for end-to-end workflows.
 * Run: hc tui  (requires an interactive terminal)
 */

import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput } from "ink";
import { config as loadDotenv } from "dotenv";
import { join } from "path";

loadDotenv({ path: join(process.cwd(), ".env") });
loadDotenv({ path: join(process.cwd(), ".env.local") });

import { getConfig, saveConfig } from "../lib/config.mjs";
import * as api from "../lib/api.mjs";

let blockNav = false;
export function setBlockNav(v) {
  blockNav = v;
}

function isRawModeSupported() {
  const stdin = process.stdin;
  return Boolean(stdin && stdin.isTTY && typeof stdin.setRawMode === "function");
}

const MENU = [
  { id: "dashboard", label: "Dashboard", key: "1" },
  { id: "agents", label: "Agents", key: "2" },
  { id: "arena", label: "Arena", key: "3" },
  { id: "fund", label: "Fund", key: "4" },
  { id: "deposit", label: "Deposit", key: "5" },
  { id: "ironclaw", label: "IronClaw Chat", key: "6" },
  { id: "config", label: "Config", key: "7" },
];

function Sidebar({ active, onSelect }) {
  useInput((input, key) => {
    if (blockNav) return;
    const item = MENU.find((m) => m.key === input);
    if (item) onSelect(item.id);
    if (input === "q" && !key.ctrl) process.exit(0);
  });

  return React.createElement(
    Box,
    {
      flexDirection: "column",
      width: 22,
      borderStyle: "round",
      borderColor: "cyan",
      paddingX: 1,
      paddingY: 1,
    },
    React.createElement(
      Text,
      { bold: true, color: "cyan" },
      " HYPERCLAW "
    ),
    React.createElement(Box, { height: 1 }),
    ...MENU.map((m) =>
      React.createElement(
        Box,
        { key: m.id },
        React.createElement(
          Text,
          {
            color: active === m.id ? "green" : "gray",
            bold: active === m.id,
            inverse: active === m.id,
          },
          ` [${m.key}] ${m.label} `
        )
      )
    ),
    React.createElement(Box, { flexGrow: 1 }),
    React.createElement(Text, { dimColor: true }, " q: quit  Esc: back ")
  );
}

function Spinner() {
  const [frame, setFrame] = useState(0);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % frames.length), 80);
    return () => clearInterval(t);
  }, []);
  return React.createElement(Text, { color: "cyan" }, frames[frame] + " Loading...");
}

function DashboardView() {
  const [health, setHealth] = useState(null);
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      api.apiGet("/api/health").catch((e) => ({ healthy: false, error: e.message })),
      api.apiGetAgents().catch(() => ({ agents: [] })),
    ]).then(([h, a]) => {
      setHealth(h);
      setAgents(a);
    }).catch(setError);
  }, []);

  if (error) {
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, { color: "red" }, "Error: " + error)
    );
  }
  if (!health && !agents) {
    return React.createElement(Spinner);
  }
  const list = agents?.agents ?? [];
  const activeCount = list.filter((a) => a.status === "active").length;
  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    React.createElement(Text, { bold: true, color: "cyan" }, " Dashboard "),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { color: health?.healthy ? "green" : "red" },
      " API: " + (health?.healthy ? "✓ Healthy" : "✗ Unhealthy")
    ),
    React.createElement(Text, { dimColor: true },
      " Agents: " + list.length + " total, " + activeCount + " active"
    ),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { dimColor: true },
      " Press 1-7 to switch view. [2] Agents  [3] Arena  [4] Fund "
    )
  );
}

function AgentsView() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.apiGetAgents()
      .then((d) => {
        setAgents(d?.agents ?? []);
        setDetail(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, []);

  useEffect(() => {
    if (detail && !detail._create) {
      setBlockNav(true);
      return () => setBlockNav(false);
    }
  }, [detail]);

  useInput((input, key) => {
    if (detail) {
      if (key.escape || input === "b") setDetail(null);
      return;
    }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(agents.length - 1, s + 1));
    if (key.return && agents[selected]) {
      api.apiGetAgent(agents[selected].id).then(setDetail).catch(setError);
    }
    if (input === "n") {
      setDetail({ _create: true });
    }
  });

  if (loading) return React.createElement(Spinner);
  if (error) return React.createElement(Text, { color: "red" }, "Error: " + error);
  if (detail?._create) {
    return React.createElement(CreateAgentView, { onBack: () => setDetail(null), onCreated: load });
  }
  if (detail) {
    return React.createElement(
      Box,
      { flexDirection: "column", paddingX: 1 },
      React.createElement(Text, { bold: true }, " ← [Esc] Back"),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { bold: true }, detail.agent?.name ?? "Agent"),
      React.createElement(Text, { dimColor: true }, " ID: " + (detail.agent?.id ?? "?")),
      React.createElement(Text, {}, " Status: " + (detail.agent?.status ?? "?")),
      React.createElement(Text, {}, " Markets: " + (detail.agent?.markets ?? []).join(", ")),
      React.createElement(Text, {}, " HL: " + (detail.agent?.hlAddress ?? "—"))
    );
  }
  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    React.createElement(Text, { bold: true }, " Agents  [n] New agent "),
    React.createElement(Box, { height: 1 }),
    agents.length === 0
      ? React.createElement(Text, { dimColor: true }, "No agents. Press [n] to create.")
      : agents.map((a, i) =>
          React.createElement(
            Box,
            { key: a.id },
            React.createElement(Text, {
              color: i === selected ? "green" : undefined,
              inverse: i === selected,
            }, (a.status === "active" ? "● " : "○ ") + (a.name ?? "?") + " " + (a.id?.slice(0, 8) ?? "")),
            React.createElement(Text, { dimColor: true }, " TVL $" + (Number(a.vaultTvlUsd ?? 0).toLocaleString()))
          )
        ),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { dimColor: true }, " ↑↓ Select  Enter: details  n: new ")
  );
}

function CreateAgentView({ onBack, onCreated }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [markets, setMarkets] = useState(["BTC", "ETH"]);
  const [risk, setRisk] = useState("moderate");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setBlockNav(true);
    return () => setBlockNav(false);
  }, []);

  const cfg = getConfig();
  const body = {
    name: name.trim(),
    description: desc.trim(),
    markets,
    maxLeverage: 5,
    riskLevel: risk,
    stopLossPercent: 5,
    autonomy: { mode: "semi", aggressiveness: 50, maxTradesPerDay: 10, approvalTimeoutMs: 300000 },
    network: cfg.network ?? "mainnet",
  };
  if (cfg.privyId) body.ownerPrivyId = cfg.privyId;
  if (cfg.walletAddress) body.ownerWalletAddress = cfg.walletAddress;

  useInput((input, key) => {
    if (key.escape) return onBack();
    if (submitting) return;
    if (step === 0) {
      if (key.return && name.trim()) setStep(1);
      else if (input && input.length === 1 && !key.ctrl && !key.meta) setName((n) => n + input);
      else if (key.backspace) setName((n) => n.slice(0, -1));
    } else if (step === 1) {
      if (key.return) setStep(2);
      else if (input && input.length === 1 && !key.ctrl) setDesc((d) => d + input);
      else if (key.backspace) setDesc((d) => d.slice(0, -1));
    } else if (step === 2) {
      if (key.return && name.trim()) {
        setSubmitting(true);
        setError(null);
        api.apiPostAgents(body)
          .then(() => {
            onCreated?.();
            onBack();
          })
          .catch((e) => {
            setError(e.message);
            setSubmitting(false);
          });
      }
      if (input === "b") setStep(1);
    }
  });

  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    React.createElement(Text, { dimColor: true }, " [Esc] Back"),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { bold: true }, " Create Agent"),
    React.createElement(Box, { height: 1 }),
    step === 0 && React.createElement(Text, {}, "Name: " + name + "_"),
    step === 1 && React.createElement(Text, {}, "Description: " + desc + "_"),
    step === 2 && React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, {}, "Name: " + name),
      React.createElement(Text, {}, "Markets: " + markets.join(", ")),
      React.createElement(Text, {}, "Risk: " + risk),
      React.createElement(Box, { height: 1 }),
      submitting ? React.createElement(Spinner) : React.createElement(Text, { color: "green" }, " [Enter] Create agent ")
    ),
    error && React.createElement(Text, { color: "red" }, error)
  );
}

function ArenaView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams({ view: "explore", scope: "all" });
    api.apiGetAgents(params.toString())
      .then((d) => {
        const list = (d?.agents ?? []).filter((a) => a.status === "active");
        return Promise.all(
          list.map(async (a) => {
            try {
              const bal = await api.apiFund({ action: "agent-balance", agentId: a.id, includePnl: true });
              return { ...a, totalPnl: bal?.totalPnl ?? 0 };
            } catch {
              return { ...a, totalPnl: 0 };
            }
          })
        );
      })
      .then((list) => list.sort((a, b) => (b.totalPnl ?? 0) - (a.totalPnl ?? 0)))
      .then(setData)
      .catch(setError);
  }, []);

  if (error) return React.createElement(Text, { color: "red" }, "Error: " + error);
  if (!data) return React.createElement(Spinner);

  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    React.createElement(Text, { bold: true, color: "cyan" }, " Arena - Leaderboard "),
    React.createElement(Box, { height: 1 }),
    ...data.slice(0, 10).map((a, i) => {
      const pnl = a.totalPnl ?? 0;
      const pnlStr = pnl >= 0 ? "+$" + pnl.toFixed(2) : "-$" + Math.abs(pnl).toFixed(2);
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : " #" + (i + 1);
      return React.createElement(
        Box,
        { key: a.id },
        React.createElement(Text, {}, medal + " "),
        React.createElement(Text, { bold: true }, a.name ?? "?"),
        React.createElement(Text, { dimColor: true }, " " + (a.id?.slice(0, 8) ?? "")),
        React.createElement(Text, { color: pnl >= 0 ? "green" : "red" }, " PnL " + pnlStr)
      );
    })
  );
}

function FundView() {
  const [agents, setAgents] = useState([]);
  const [selected, setSelected] = useState(0);
  const [amount, setAmount] = useState("100");
  const [mode, setMode] = useState("provision");
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.apiGetAgents().then((d) => {
      setAgents(d?.agents ?? []);
      setLoading(false);
    }).catch((e) => {
      setError(e.message);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (result || mode === "amount") {
      setBlockNav(true);
      return () => setBlockNav(false);
    }
  }, [result, mode]);

  useInput((input, key) => {
    if (result) {
      if (key.escape || input === "b") setResult(null);
      return;
    }
    if (mode === "list") {
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) setSelected((s) => Math.min(agents.length - 1, s + 1));
      if (key.return && agents[selected]) {
        setMode("amount");
        setSelected(0);
      }
      if (key.escape) setMode("list");
    } else if (mode === "amount") {
      if (/\d|\./.test(input)) setAmount((a) => a + input);
      if (key.backspace) setAmount((a) => a.slice(0, -1));
      if (key.return) {
        const agentId = agents[selected]?.id;
        if (!agentId) return;
        setLoading(true);
        api.apiFund({
          action: "provision",
          agentId,
          amount: parseFloat(amount) || 100,
          autoActivate: true,
        })
          .then(setResult)
          .catch((e) => setError(e.message))
          .finally(() => setLoading(false));
      }
      if (key.escape) setMode("list");
    }
  });

  if (loading && !result) return React.createElement(Spinner);
  if (error) return React.createElement(Text, { color: "red" }, "Error: " + error);
  if (result) {
    return React.createElement(
      Box,
      { flexDirection: "column", paddingX: 1 },
      React.createElement(Text, { color: "green", bold: true }, " ✓ Funded successfully "),
      React.createElement(Text, {}, "Agent: " + result.agentId),
      React.createElement(Text, {}, "HL Address: " + (result.hlAddress ?? "—")),
      React.createElement(Text, {}, "Amount: $" + (result.fundedAmount ?? amount)),
      React.createElement(Text, { dimColor: true }, " [Esc] Back")
    );
  }
  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    React.createElement(Text, { bold: true }, " Fund Agent "),
    React.createElement(Box, { height: 1 }),
    mode === "list" && agents.map((a, i) =>
      React.createElement(
        Box,
        { key: a.id },
        React.createElement(Text, {
          color: i === selected ? "green" : undefined,
          inverse: i === selected,
        }, (a.name ?? "?") + " " + (a.id?.slice(0, 8) ?? ""))
      )
    ),
    mode === "amount" && React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, {}, "Agent: " + (agents[selected]?.name ?? "?")),
      React.createElement(Text, {}, "Amount (USD): " + amount + "_"),
      React.createElement(Text, { dimColor: true }, " [Enter] Provision + Activate ")
    ),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { dimColor: true }, " ↑↓ Select  Enter: confirm  Esc: back ")
  );
}

function DepositView() {
  const [agents, setAgents] = useState([]);
  const [selected, setSelected] = useState(0);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.apiGetAgents().then((d) => {
      setAgents(d?.agents ?? []);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (info) {
      setBlockNav(true);
      return () => setBlockNav(false);
    }
  }, [info]);

  useInput((inputKey, key) => {
    if (info) {
      if (key.escape) setInfo(null);
      return;
    }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(agents.length - 1, s + 1));
    if (key.return && agents[selected]) {
      const id = agents[selected].id;
      Promise.all([
        api.apiGetDeposit(id),
        api.apiFund({ action: "status" }),
      ]).then(([dep, status]) => setInfo({ ...dep, vaultAddress: status?.vaultAddress }));
    }
  });

  if (loading) return React.createElement(Spinner);
  if (info) {
    return React.createElement(
      Box,
      { flexDirection: "column", paddingX: 1 },
      React.createElement(Text, { bold: true }, " Deposit Info "),
      React.createElement(Text, {}, "Agent: " + (info.agentId ?? "?")),
      React.createElement(Text, {}, "TVL: $" + (Number(info.tvlUsd ?? 0).toLocaleString())),
      React.createElement(Text, {}, "Vault: " + (info.vaultAddress ?? "—")),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { dimColor: true }, " Deposit via web app. [Esc] Back ")
    );
  }
  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    React.createElement(Text, { bold: true }, " Deposit - Select Agent "),
    React.createElement(Box, { height: 1 }),
    agents.map((a, i) =>
      React.createElement(
        Box,
        { key: a.id },
        React.createElement(Text, {
          color: i === selected ? "green" : undefined,
          inverse: i === selected,
        }, (a.name ?? "?") + " " + (a.id?.slice(0, 8) ?? ""))
      )
    ),
    React.createElement(Text, { dimColor: true }, " ↑↓ Select  Enter: details ")
  );
}

function IronClawView() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  useInput((keyInput, key) => {
    if (key.return && input.trim()) {
      const msg = input.trim();
      setInput("");
      setMessages((m) => [...m, { role: "user", text: msg }]);
      setLoading(true);
      api.apiIronclaw({ content: msg, wait_for_response: true })
        .then((r) => {
          setMessages((m) => [...m, { role: "assistant", text: r?.response ?? "No response." }]);
        })
        .catch((e) => setMessages((m) => [...m, { role: "error", text: e.message }]))
        .finally(() => setLoading(false));
    } else if (keyInput && keyInput.length === 1 && !key.ctrl && !key.meta) {
      setInput((i) => i + keyInput);
    } else if (key.backspace) {
      setInput((i) => i.slice(0, -1));
    }
  });

  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1, flexGrow: 1 },
    React.createElement(Text, { bold: true, color: "cyan" }, " IronClaw Chat "),
    React.createElement(Box, { height: 1 }),
    React.createElement(Box, { flexDirection: "column", flexGrow: 1, overflow: "hidden" },
      ...messages.slice(-8).map((m, i) =>
        React.createElement(
          Box,
          { key: i },
          React.createElement(Text, {
            color: m.role === "user" ? "green" : m.role === "error" ? "red" : "gray",
          }, (m.role === "user" ? "You: " : "IronClaw: ") + m.text.slice(0, 80))
        )
      )
    ),
    loading && React.createElement(Spinner),
    React.createElement(Text, {}, "> " + input + "_"),
    React.createElement(Text, { dimColor: true }, " Type message, Enter to send ")
  );
}

function ConfigView() {
  const cfg = getConfig();
  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    React.createElement(Text, { bold: true }, " Config "),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, {}, "Base URL: " + (cfg.baseUrl || "—")),
    React.createElement(Text, {}, "API Key: " + (cfg.apiKey ? "***" : "—")),
    React.createElement(Text, {}, "Privy ID: " + (cfg.privyId || "—")),
    React.createElement(Text, {}, "Wallet: " + (cfg.walletAddress || "—")),
    React.createElement(Text, {}, "Network: " + (cfg.network ?? "mainnet")),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { dimColor: true }, " Run 'hc config' to change ")
  );
}

function Content({ view }) {
  switch (view) {
    case "dashboard": return React.createElement(DashboardView);
    case "agents": return React.createElement(AgentsView);
    case "arena": return React.createElement(ArenaView);
    case "fund": return React.createElement(FundView);
    case "deposit": return React.createElement(DepositView);
    case "ironclaw": return React.createElement(IronClawView);
    case "config": return React.createElement(ConfigView);
    default: return React.createElement(DashboardView);
  }
}

function App() {
  const [view, setView] = useState("dashboard");
  const cfg = getConfig();

  return React.createElement(
    Box,
    { flexDirection: "row", minHeight: 24, borderStyle: "round", borderColor: "gray" },
    React.createElement(Sidebar, {
      active: view,
      onSelect: setView,
    }),
    React.createElement(
      Box,
      {
        flexDirection: "column",
        flexGrow: 1,
        borderLeft: true,
        borderColor: "gray",
        paddingX: 1,
        paddingY: 1,
      },
      !cfg.baseUrl
        ? React.createElement(
            Box,
            { flexDirection: "column" },
            React.createElement(Text, { color: "yellow" }, " Config required "),
            React.createElement(Text, {}, "Run: hc config --base-url <URL> --api-key <key>"),
            React.createElement(Text, { dimColor: true }, "Then restart the TUI.")
          )
        : React.createElement(Content, { view })
    )
  );
}

if (!isRawModeSupported()) {
  console.error("\nTUI requires an interactive terminal. Run: hc tui");
  console.error("(Do not pipe stdin or run in background.)\n");
  process.exit(1);
}
render(React.createElement(App));
