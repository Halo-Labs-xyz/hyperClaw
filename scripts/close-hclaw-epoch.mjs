#!/usr/bin/env node

import process from "node:process";

const baseUrl = process.env.HCLAW_APP_URL || "http://127.0.0.1:3014";
const closeKey = process.env.HCLAW_POINTS_CLOSE_KEY;
const epochId = process.argv[2];

async function run() {
  const response = await fetch(`${baseUrl}/api/hclaw/epochs/close`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(closeKey ? { "x-hclaw-close-key": closeKey } : {}),
    },
    body: JSON.stringify({
      epochId: epochId || undefined,
      activities: [],
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    console.error("Epoch close failed:", body);
    process.exit(1);
  }

  console.log("Epoch close success:");
  console.log(JSON.stringify(body, null, 2));
}

run().catch((error) => {
  console.error("Epoch close script failed:", error);
  process.exit(1);
});
