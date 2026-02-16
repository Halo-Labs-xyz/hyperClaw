#!/usr/bin/env node

import process from "node:process";

const BASE_URL = (process.env.HCLAW_APP_URL || process.env.APP_URL || "http://127.0.0.1:3014").replace(/\/$/, "");
const CLOSE_KEY = process.env.HCLAW_POINTS_CLOSE_KEY || "";

async function requestJson(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

async function run() {
  const status = await requestJson("/api/hclaw/epochs/close");
  if (!status.ok) {
    console.error(`[epoch-keeper] failed to read epoch status (${status.status})`, status.body);
    process.exit(1);
  }

  const epoch = status.body?.epoch;
  if (!epoch?.epochId || !epoch?.endTs) {
    console.error("[epoch-keeper] invalid epoch payload", status.body);
    process.exit(1);
  }

  const now = Date.now();
  const isExpired = Number(epoch.endTs) <= now;
  const isClosed = String(epoch.status || "").toLowerCase() === "closed";

  if (!isExpired || isClosed) {
    console.log(
      `[epoch-keeper] no-op epoch=${epoch.epochId} status=${epoch.status} endTs=${epoch.endTs} now=${now}`
    );
    return;
  }

  const close = await requestJson("/api/hclaw/epochs/close", {
    method: "POST",
    headers: CLOSE_KEY ? { "x-hclaw-close-key": CLOSE_KEY } : {},
    body: JSON.stringify({
      epochId: epoch.epochId,
      activities: [],
    }),
  });

  if (!close.ok) {
    console.error(`[epoch-keeper] epoch close failed (${close.status})`, close.body);
    process.exit(1);
  }

  console.log(`[epoch-keeper] closed epoch ${epoch.epochId}`, close.body);
}

run().catch((error) => {
  console.error("[epoch-keeper] failed:", error);
  process.exit(1);
});

