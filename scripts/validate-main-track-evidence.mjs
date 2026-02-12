#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const EVIDENCE_PATH = path.join(process.cwd(), "docs", "submission", "main-track-evidence.json");
const MIN_ACTIVE_DATE = "2026-02-18";

for (const envFile of [".env.local", ".env"]) {
  const full = path.join(process.cwd(), envFile);
  if (fs.existsSync(full)) dotenv.config({ path: full, override: false });
}

function fail(errors) {
  console.error("Main track evidence validation FAILED:");
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAddress(v) {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);
}

function isTxHash(v) {
  return typeof v === "string" && /^0x[a-fA-F0-9]{64}$/.test(v);
}

function isZeroHex(v) {
  return typeof v === "string" && /^0x0+$/i.test(v);
}

function isIsoDate(v) {
  if (typeof v !== "string") return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}

function must(cond, message, errors) {
  if (!cond) errors.push(message);
}

if (!fs.existsSync(EVIDENCE_PATH)) {
  fail([
    `Missing ${EVIDENCE_PATH}`,
    "Create it from docs/submission/main-track-evidence.template.json",
  ]);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(EVIDENCE_PATH, "utf8"));
} catch (error) {
  fail([`Invalid JSON in ${EVIDENCE_PATH}: ${error instanceof Error ? error.message : String(error)}`]);
}

const errors = [];

must(data.track === "main-agent-plus-token", "track must be \"main-agent-plus-token\"", errors);
must(isIsoDate(data.submissionDate), "submissionDate must be a valid date", errors);

const autonomous = data.autonomousAgent;
must(isObject(autonomous), "autonomousAgent must exist", errors);
if (isObject(autonomous)) {
  must(
    ["full_auto", "semi_auto", "manual"].includes(String(autonomous.productionMode)),
    "autonomousAgent.productionMode must be one of full_auto|semi_auto|manual",
    errors
  );
  must(autonomous.reasoningVisible === true, "autonomousAgent.reasoningVisible must be true", errors);
  must(
    autonomous.learningOrMemoryEnabled === true,
    "autonomousAgent.learningOrMemoryEnabled must be true",
    errors
  );
  must(
    Array.isArray(autonomous.demoClipReferences) && autonomous.demoClipReferences.length > 0,
    "autonomousAgent.demoClipReferences must include at least one clip",
    errors
  );
}

const monad = data.monadIntegration;
must(isObject(monad), "monadIntegration must exist", errors);
if (isObject(monad)) {
  must(monad.network === "mainnet", "monadIntegration.network must be mainnet", errors);
  must(Number(monad.chainId) === 143, "monadIntegration.chainId must be 143", errors);

  must(isObject(monad.contracts), "monadIntegration.contracts must exist", errors);
  if (isObject(monad.contracts)) {
    for (const key of [
      "vault",
      "hclawLock",
      "hclawPolicy",
      "hclawRewards",
      "agenticLpVault",
      "treasuryRouter",
    ]) {
      must(isAddress(monad.contracts[key]), `monadIntegration.contracts.${key} must be a valid 0x address`, errors);
      if (isAddress(monad.contracts[key])) {
        must(!isZeroHex(monad.contracts[key]), `monadIntegration.contracts.${key} cannot be zero address`, errors);
      }
    }
  }

  must(
    Array.isArray(monad.transactions) && monad.transactions.length > 0,
    "monadIntegration.transactions must include at least one tx",
    errors
  );
  if (Array.isArray(monad.transactions)) {
    for (const [idx, tx] of monad.transactions.entries()) {
      must(isObject(tx), `monadIntegration.transactions[${idx}] must be an object`, errors);
      if (isObject(tx)) {
        must(typeof tx.label === "string" && tx.label.length > 0, `transactions[${idx}].label is required`, errors);
        must(isTxHash(tx.hash), `transactions[${idx}].hash must be a valid tx hash`, errors);
        if (isTxHash(tx.hash)) {
          must(!isZeroHex(tx.hash), `transactions[${idx}].hash cannot be all zeros`, errors);
        }
      }
    }
  }

  must(
    typeof monad.integrationPurpose === "string" && monad.integrationPurpose.length >= 16,
    "monadIntegration.integrationPurpose must be a non-trivial description",
    errors
  );
}

const token = data.token;
must(isObject(token), "token must exist for main track", errors);
if (isObject(token)) {
  must(
    typeof token.nadFunTokenUrl === "string" &&
      /^https?:\/\//.test(token.nadFunTokenUrl) &&
      !token.nadFunTokenUrl.includes("<"),
    "token.nadFunTokenUrl must be a public URL",
    errors
  );
  must(isObject(token.launch), "token.launch must exist", errors);
  if (isObject(token.launch)) {
    must(token.launch.launchedDuringHackathon === true, "token.launch.launchedDuringHackathon must be true", errors);
    must(isIsoDate(token.launch.launchDate), "token.launch.launchDate must be a valid date", errors);
  }

  must(isObject(token.tradability), "token.tradability must exist", errors);
  if (isObject(token.tradability)) {
    must(token.tradability.isActive === true, "token.tradability.isActive must be true", errors);
    must(token.tradability.isTradable === true, "token.tradability.isTradable must be true", errors);
    must(isIsoDate(token.tradability.activeThroughDate), "token.tradability.activeThroughDate must be a valid date", errors);
    if (isIsoDate(token.tradability.activeThroughDate)) {
      const actual = new Date(token.tradability.activeThroughDate).getTime();
      const min = new Date(MIN_ACTIVE_DATE).getTime();
      must(
        actual >= min,
        `token.tradability.activeThroughDate must be >= ${MIN_ACTIVE_DATE}`,
        errors
      );
    }
  }

  must(isObject(token.compliance), "token.compliance must exist", errors);
  if (isObject(token.compliance)) {
    must(token.compliance.nadFunTermsAccepted === true, "token.compliance.nadFunTermsAccepted must be true", errors);
    must(token.compliance.policyViolations === false, "token.compliance.policyViolations must be false", errors);
  }
}

const demo = data.demoVideo;
must(isObject(demo), "demoVideo must exist", errors);
if (isObject(demo)) {
  const envDemoUrl = process.env.HACKATHON_DEMO_VIDEO_URL?.trim();
  if (envDemoUrl && (typeof demo.url !== "string" || demo.url.includes("<"))) {
    demo.url = envDemoUrl;
  }
  must(
    typeof demo.url === "string" && /^https?:\/\//.test(demo.url) && !demo.url.includes("<"),
    "demoVideo.url must be public URL",
    errors
  );
  must(Number.isFinite(demo.durationSeconds), "demoVideo.durationSeconds must be numeric", errors);
  must(Number(demo.durationSeconds) > 0, "demoVideo.durationSeconds must be > 0", errors);
  must(Number(demo.durationSeconds) <= 120, "demoVideo.durationSeconds must be <= 120", errors);
  must(demo.showsLiveOperation === true, "demoVideo.showsLiveOperation must be true", errors);
  must(demo.showsAutonomousDecisions === true, "demoVideo.showsAutonomousDecisions must be true", errors);
  must(demo.showsMonadInteractions === true, "demoVideo.showsMonadInteractions must be true", errors);
  must(demo.showsTokenIntegration === true, "demoVideo.showsTokenIntegration must be true", errors);
}

if (errors.length > 0) fail(errors);

console.log("PASS: main track evidence satisfies required fields and hard constraints.");
