import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runCli(args, env) {
  const res = spawnSync(process.execPath, ["cli/index.mjs", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    code: res.status ?? 0,
    out: `${res.stdout || ""}${res.stderr || ""}`,
  };
}

function extractJson(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error(`No JSON in output:\n${output}`);
  return JSON.parse(output.slice(start, end + 1));
}

test("hc CLI end-to-end against stub API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-cli-e2e-"));
  const configPath = join(dir, "config.json");
  const mockStatePath = join(dir, "mock-state.json");
  const baseUrl = "http://mock.local";

  const env = {
    HC_CONFIG_PATH: configPath,
    HC_MOCK_STATE_PATH: mockStatePath,
    NODE_OPTIONS: `--import ${join(process.cwd(), "cli/test/fetch-mock.mjs")}`,
  };

  try {
    {
      const r = runCli(["config", "--base-url", baseUrl, "--api-key", "testkey"], env);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Config saved/i);
    }

    {
      const r = runCli(["doctor", "--json"], env);
      assert.equal(r.code, 0, r.out);
      const obj = extractJson(r.out);
      assert.equal(obj.baseUrl, baseUrl);
      assert.equal(obj.health.healthy, true);
    }

    {
      const r = runCli(["agents", "list"], env);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /\bAlpha\b/);
    }

    {
      const r = runCli(["agents", "tick", "a1b2c3d4"], env);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Tick result/i);
    }

    {
      const r = runCli(["agents", "runner", "status", "a1b2c3d4"], env);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Runner:/i);
    }

    {
      const r = runCli(["agents", "chat", "send", "a1b2c3d4", "hi?"], env);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /mock answer/i);
    }

    {
      const r = runCli(["orchestrator"], env);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Active agents/i);
    }

    {
      const r = runCli(["tui"], env);
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, /interactive terminal/i);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
