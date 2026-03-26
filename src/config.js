/**
 * src/config.js
 * Validate all environment variables at startup.
 * Export a frozen config object.
 * Call process.exit(1) with descriptive error if any required var is missing.
 */

import { hostname } from "os";
import { randomBytes } from "crypto";

// ─── Helpers ────────────────────────────────────────────────────────────────

function requireEnv(name) {
  const val = process.env[name];
  if (!val || val.trim() === "") {
    return { missing: true, name };
  }
  return { missing: false, value: val.trim() };
}

function optionalEnv(name, defaultValue) {
  const val = process.env[name];
  if (!val || val.trim() === "") return defaultValue;
  return val.trim();
}

function optionalFloat(name, defaultValue) {
  const val = process.env[name];
  if (!val || val.trim() === "") return defaultValue;
  const n = parseFloat(val.trim());
  if (isNaN(n)) {
    process.stderr.write(`[config] WARNING: ${name}="${val}" is not a valid float, using default ${defaultValue}\n`);
    return defaultValue;
  }
  return n;
}

function optionalInt(name, defaultValue) {
  const val = process.env[name];
  if (!val || val.trim() === "") return defaultValue;
  const n = parseInt(val.trim(), 10);
  if (isNaN(n)) {
    process.stderr.write(`[config] WARNING: ${name}="${val}" is not a valid integer, using default ${defaultValue}\n`);
    return defaultValue;
  }
  return n;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const REQUIRED_VARS = ["PROXY_API_KEY", "FIREBASE_RTDB_URL", "FIREBASE_DB_SECRET"];

const missing = [];

for (const name of REQUIRED_VARS) {
  const result = requireEnv(name);
  if (result.missing) {
    missing.push(name);
  }
}

if (missing.length > 0) {
  process.stderr.write(
    `[config] FATAL: Missing required environment variable(s):\n` +
      missing.map((v) => `  - ${v}`).join("\n") +
      `\n\nPlease set these variables before starting the server.\n` +
      `See .env.example for reference.\n`,
  );
  process.exit(1);
}

// ─── Auto-generate INSTANCE_ID if not set ───────────────────────────────────

const instanceId = optionalEnv("INSTANCE_ID", null) || `${hostname()}-${process.pid}-${randomBytes(2).toString("hex")}`;

// ─── Build config object ─────────────────────────────────────────────────────

const config = Object.freeze({
  // Required
  PROXY_API_KEY: process.env.PROXY_API_KEY.trim(),
  FIREBASE_RTDB_URL: process.env.FIREBASE_RTDB_URL.trim().replace(/\/$/, ""),
  FIREBASE_DB_SECRET: process.env.FIREBASE_DB_SECRET.trim(),

  // Optional with defaults
  PORT: optionalInt("PORT", 3000),
  QUOTA_THRESHOLD: optionalFloat("QUOTA_THRESHOLD", 0.9),
  QUOTA_POLL_INTERVAL_MS: optionalInt("QUOTA_POLL_INTERVAL_MS", 300_000),
  RTDB_SYNC_BATCH_SIZE: optionalInt("RTDB_SYNC_BATCH_SIZE", 400),
  DRAIN_TIMEOUT_MS: optionalInt("DRAIN_TIMEOUT_MS", 30_000),
  LOG_LEVEL: optionalEnv("LOG_LEVEL", "info"),
  WEBHOOK_ALERT_URL: optionalEnv("WEBHOOK_ALERT_URL", ""),
  INSTANCE_ID: instanceId,
  SQLITE_PATH: optionalEnv("SQLITE_PATH", "./data/routes.db"),
  LRU_MAX: optionalInt("LRU_MAX", 10_000),
  LRU_TTL_MS: optionalInt("LRU_TTL_MS", 300_000),
});

export default config;
