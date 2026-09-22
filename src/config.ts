import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DEFAULT_JEV, type JevConfig } from "./jev-client.ts";
import { DEFAULT_POLICY, type PolicyConfig } from "./policy.ts";

export interface RouterConfig extends JevConfig, PolicyConfig {
  /** Master switch for automatic routing (toggled via /jev-router on|off). */
  enabled: boolean;
  /** Write decision log entries (JSONL). */
  logEnabled: boolean;
  /** JSONL decision log path. */
  logFile: string;
}

export function defaultLogFile(): string {
  return join(homedir(), ".pi", "jev-router", "decisions.jsonl");
}

export const DEFAULT_CONFIG: RouterConfig = {
  enabled: true,
  logEnabled: true,
  logFile: defaultLogFile(),
  ...DEFAULT_JEV,
  ...DEFAULT_POLICY,
};

export const CONFIG_KEYS = [
  "enabled",
  "logEnabled",
  "logFile",
  "endpoint",
  "model",
  "apiKey",
  "providerId",
  "timeoutMs",
  "minCallIntervalMs",
  "maxEscalationsPerTask",
  "maxDowngradesPerTask",
  "downgradeStableTurns",
  "pinTurns",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

const NUMERIC_KEYS = new Set<ConfigKey>([
  "timeoutMs",
  "minCallIntervalMs",
  "maxEscalationsPerTask",
  "maxDowngradesPerTask",
  "downgradeStableTurns",
  "pinTurns",
]);

export function configPath(): string {
  return join(homedir(), ".pi", "jev-router.json");
}

export async function loadConfig(): Promise<RouterConfig> {
  const cfg: RouterConfig = { ...DEFAULT_CONFIG };
  let raw: string | null = null;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch {
    raw = null;
  }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<RouterConfig>;
      for (const key of CONFIG_KEYS) {
        const v = (parsed as Record<string, unknown>)[key];
        if (v !== undefined) {
          (cfg as unknown as Record<string, unknown>)[key] = v;
        }
      }
    } catch {
      // Corrupt config file: keep defaults.
    }
  }
  // Environment overrides (handy without touching the config file).
  if (process.env.JEV_ENDPOINT) cfg.endpoint = process.env.JEV_ENDPOINT;
  if (process.env.JEV_MODEL) cfg.model = process.env.JEV_MODEL;
  return cfg;
}

export async function saveConfig(cfg: RouterConfig): Promise<void> {
  const path = configPath();
  await mkdir(join(path, ".."), { recursive: true });
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) out[key] = cfg[key];
  await writeFile(path, JSON.stringify(out, null, 2) + "\n", "utf8");
}

/** Validate + coerce one config value. Returns an error message or null. */
export function coerceConfigValue(key: ConfigKey, value: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (NUMERIC_KEYS.has(key)) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
      return { ok: false, error: `${key} must be a positive number` };
    }
    return { ok: true, value: num };
  }
  if (key === "enabled" || key === "logEnabled") {
    const norm = value.trim().toLowerCase();
    if (norm === "true" || norm === "1" || norm === "on") return { ok: true, value: true };
    if (norm === "false" || norm === "0" || norm === "off") return { ok: true, value: false };
    return { ok: false, error: `${key} must be true or false` };
  }
  return { ok: true, value: value.trim() };
}
