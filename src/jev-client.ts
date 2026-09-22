/**
 * Jev client — talks to the same probabilistic decision service as
 * pi-decision-prior (proprietary choice protocol), asking a single
 * question: which thinking level should the agent use next?
 *
 * Key resolution order (same as pi-decision-prior):
 *   1. explicit config.apiKey
 *   2. JEV_API_KEY environment variable
 *   3. apiKey field inside the cc-switch provider settings (SQLite db)
 *
 * Failures of any kind (missing config, HTTP errors, timeouts, malformed
 * answers) throw; the engine catches and falls back. This module never
 * invents a level itself.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { parseLevel, ROUTED_LEVELS, type RoutedLevel } from "./levels.ts";
import type { TaskSnapshot } from "./state.ts";
import { snapshotToStateText } from "./state.ts";

export interface JevConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  providerId: string;
  timeoutMs: number;
}

export const DEFAULT_JEV: JevConfig = {
  // Intentionally empty: configure via ~/.pi/jev-router.json, the /jev-router
  // set command, or JEV_ENDPOINT / JEV_MODEL env vars. Unconfigured -> local
  // rule engine with a one-time warning.
  endpoint: "",
  model: "",
  // cc-switch provider id used for API key lookup. Point this at whatever
  // provider entry in your local credential store holds the jev key
  // (set via config file or /jev-router set providerId <id>).
  providerId: "",
  timeoutMs: 20_000,
};

export interface JevResult {
  level: RoutedLevel;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export function jevConfigured(cfg: JevConfig): boolean {
  // endpoint + model are the configuration gate; the API key is resolved at
  // call time (config -> env -> cc-switch) and its absence is a runtime
  // fallback, not a configuration error.
  return Boolean(cfg.endpoint && cfg.model);
}

export async function resolveApiKey(cfg: JevConfig): Promise<string | null> {
  if (cfg.apiKey) return cfg.apiKey;
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  return keyFromCcSwitch(cfg.providerId);
}

async function keyFromCcSwitch(providerId: string): Promise<string | null> {
  if (!providerId) return null;
  const dbPath = join(homedir(), ".cc-switch", "cc-switch.db");
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT settings_config FROM providers WHERE id = ?")
        .get(providerId) as { settings_config?: string } | undefined;
      if (row?.settings_config) {
        const parsed = JSON.parse(row.settings_config) as { apiKey?: string };
        if (parsed.apiKey) return parsed.apiKey;
      }
    } finally {
      db.close();
    }
  } catch {
    // Fall through to raw scan.
  }
  try {
    const raw = await readFile(dbPath, "utf8");
    const marker = JSON.stringify(providerId).slice(1, -1);
    const idx = raw.indexOf(marker);
    if (idx >= 0) {
      const slice = raw.slice(idx, idx + 2000);
      const m = slice.match(/"apiKey":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse(`"${m[1]}"`) as string;
    }
  } catch {
    // Ignore: no key found.
  }
  return null;
}

const LEVEL_CRITERIA: Record<RoutedLevel, string> = {
  low: "Choose 'low' only if the task is simple and unambiguous (trivial edit, config tweak, formatting, docs touch, single-file mechanical change) and needs no complex reasoning.",
  medium: "Choose 'medium' for ordinary coding work (normal features, average bug fixes, multi-file changes, regular tests) or whenever the task is not clearly low or high. It is the safe default.",
  high: "Choose 'high' for complex debugging, deep multi-file changes, concurrency/async/state issues, performance work, entangled components, or when a medium attempt has already failed with a reasoning-type error.",
  xhigh: "Choose 'xhigh' only as a last resort: large architecture design, system-level refactors, deep distributed/concurrency problems, extremely elusive runtime bugs, or repeated failures even at high.",
};

export function buildLevelQuestion(snap: TaskSnapshot, trigger: string): {
  question: string;
  state: string;
} {
  const question =
    `A coding agent is working on a task and must pick its next thinking level ` +
    `(reasoning effort). Which level — low, medium, high, or xhigh — gives the ` +
    `best chance of success without wasting reasoning cost? Trigger for this ` +
    `re-evaluation: ${trigger}.`;
  const state = snapshotToStateText(snap);
  return { question, state };
}

export async function consultJev(
  cfg: JevConfig,
  snap: TaskSnapshot,
  trigger: string,
  signal?: AbortSignal,
): Promise<JevResult> {
  if (!cfg.endpoint || !cfg.model) {
    throw new Error("Jev is not configured (endpoint/model missing)");
  }
  const apiKey = await resolveApiKey(cfg);
  if (!apiKey) {
    throw new Error("No Jev API key found (config.apiKey / JEV_API_KEY / cc-switch store)");
  }

  const { question, state } = buildLevelQuestion(snap, trigger);
  const criteria: Record<string, string> = {};
  for (const opt of ROUTED_LEVELS) criteria[opt] = LEVEL_CRITERIA[opt];

  const payload = {
    model: cfg.model,
    state,
    questions: {
      q: {
        type: "choice",
        question,
        options: [...ROUTED_LEVELS],
        criteria,
      },
    },
  };

  const started = Date.now();
  const response = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`jev request failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    model?: string;
    answers?: Record<string, { choice?: unknown; confidence?: number; probabilities?: Record<string, number> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const answer = data.answers?.q;
  const level = parseLevel(answer?.choice);
  if (!level) {
    throw new Error(
      `jev returned an invalid choice: ${JSON.stringify(answer?.choice ?? data).slice(0, 200)}`,
    );
  }

  return {
    level,
    confidence: answer?.confidence ?? 0,
    probabilities: answer?.probabilities ?? {},
    model: data.model ?? cfg.model,
    latencyMs: Date.now() - started,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}
