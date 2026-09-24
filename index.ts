/**
 * pi-thinking-router-jev — adaptive thinking-level router for pi.
 *
 * Consults the jev decision model (same choice protocol as pi-decision-prior)
 * at task start and on execution-feedback triggers (test failures, errors,
 * stability windows) to dynamically pick low/medium/high/xhigh thinking
 * effort. Falls back to a local rule engine when Jev is unconfigured or
 * unreachable, and clamps every decision with an anti-flap policy.
 *
 * The router never touches code, tools, or the agent loop: it only reads
 * state and calls pi.setThinkingLevel().
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_KEYS,
  coerceConfigValue,
  configPath,
  loadConfig,
  saveConfig,
  type ConfigKey,
  type RouterConfig,
} from "./src/config.ts";
import { JevRouterEngine } from "./src/engine.ts";
import { jevConfigured, consultJev } from "./src/jev-client.ts";
import { JsonlLogger } from "./src/logger.ts";
import type { RawToolResult } from "./src/errors.ts";
import type { RoutedLevel } from "./src/levels.ts";

const COMMAND = "jev-router";

interface PendingInput {
  command?: string;
  path?: string;
}

export default function jevRouter(pi: ExtensionAPI) {
  let cfg: RouterConfig | null = null;
  let logger: JsonlLogger | null = null;
  let engine: JevRouterEngine | null = null;
  let currentCtx: ExtensionContext | null = null;
  const toolInputs = new Map<string, PendingInput>();
  /** True when the pending input is a steer/follow-up (same task continues). */
  let pendingSteer = false;

  // ------------------------------------------------------------------ helpers

  function buildEngine(config: RouterConfig, log: JsonlLogger): JevRouterEngine {
    return new JevRouterEngine({
      config,
      logger: log,
      now: () => Date.now(),
      randomId: () => crypto.randomUUID().slice(0, 8),
      getContextTokens: () => {
        try {
          return currentCtx?.getContextUsage()?.tokens ?? 0;
        } catch {
          return 0;
        }
      },
      getThinkingLevel: () => pi.getThinkingLevel(),
      setThinkingLevel: (level) => pi.setThinkingLevel(level),
      notify: (message, level) => {
        try {
          currentCtx?.ui.notify(message, level ?? "info");
        } catch {
          // UI unavailable (print mode) — ignore.
        }
      },
      isReasoningModel: () => {
        const m = currentCtx?.model;
        return m ? m.reasoning !== false : false;
      },
    });
  }

  function statusText(): string {
    if (!cfg || !engine) return "";
    if (!cfg.enabled) return "";
    const s = engine.status();
    if (!s.reasoningModel) return "jev:n/a";
    const lvl = s.currentLevel ?? (pi.getThinkingLevel() as RoutedLevel);
    if (s.manualOverride) return `jev:${lvl}(manual)`;
    if (!s.jevConfigured) return `jev:${lvl}(rules)`;
    if (s.lastSource === "fallback") return `jev:${lvl}(fallback)`;
    if (s.lastSource === "rules") return `jev:${lvl}(rules)`;
    return `jev:${lvl}`;
  }

  function updateStatus(ctx: ExtensionContext): void {
    try {
      ctx.ui.setStatus(COMMAND, statusText());
    } catch {
      // Status bar not ready yet.
    }
  }

  /**
   * Hard cap for awaited engine work. pi awaits extension handlers on the
   * agent-loop path (before_agent_start / turn_end), so an unresolved promise
   * here freezes the whole session — typed input is queued and never runs.
   * Jev calls are bounded by config.timeoutMs inside the client; this guard
   * is the last-resort net for anything else. If it fires, the engine work
   * may still complete later and apply its level change — clamps keep that
   * benign, and it is logged like any other decision.
   */
  function runGuarded(label: string, work: () => Promise<void>): Promise<void> {
    const ms = Math.max(30_000, (cfg?.timeoutMs ?? 20_000) * 2 + 10_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        const msg = `jev-router: ${label} exceeded ${Math.round(ms / 1000)}s — skipped wait so the session can continue`;
        try {
          currentCtx?.ui.notify(msg, "warning");
        } catch {
          // UI unavailable (print mode).
        }
        console.error(`[jev-router] ${msg}`);
        resolve();
      }, ms);
    });
    const workPromise = work().finally(() => clearTimeout(timer));
    // If the cap already won the race, a late rejection must not surface as
    // an unhandled rejection.
    workPromise.catch(() => {});
    return Promise.race([workPromise, cap]);
  }

  // ---------------------------------------------------------------- lifecycle

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    cfg = await loadConfig();
    logger = new JsonlLogger(cfg.logFile);
    engine = buildEngine(cfg, logger);
    engine.resetSessionState();
    if (cfg.enabled && !jevConfigured(cfg)) {
      // Spec request: warn once when Jev is not configured, then keep going
      // with the local rule engine.
      engine.warnUnconfigured();
    }
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    toolInputs.clear();
    pendingSteer = false;
  });

  // ------------------------------------------------------------- task routing

  pi.on("input", async (event) => {
    pendingSteer = event.streamingBehavior !== undefined;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentCtx = ctx;
    if (!engine || !cfg?.enabled) return;
    const wasSteer = pendingSteer;
    pendingSteer = false;
    // Steer/follow-up messages continue the current task; do not re-decide.
    if (wasSteer) return;
    await runGuarded("task-start routing", () => engine.onTaskStart(event.prompt));
    updateStatus(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    currentCtx = ctx;
    if (!engine) return;
    const raws: RawToolResult[] = (event.toolResults ?? []).map((m) => {
      const input = toolInputs.get(m.toolCallId) ?? {};
      return {
        toolName: m.toolName,
        isError: Boolean(m.isError),
        text: extractText(m.content),
        command: input.command,
        path: input.path,
      };
    });
    toolInputs.clear();
    await runGuarded("turn-end routing", () => engine.onTurnEnd(raws, event.turnIndex));
    updateStatus(ctx);
  });

  pi.on("tool_execution_start", async (event) => {
    const args = (event.args ?? {}) as Record<string, unknown>;
    const entry: PendingInput = {};
    if (typeof args.command === "string") entry.command = args.command;
    if (typeof args.path === "string") entry.path = args.path;
    if (entry.command || entry.path) toolInputs.set(event.toolCallId, entry);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    engine?.onTaskSettled();
    updateStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (!engine || engine.suppressLevelEvent) return;
    // A change we did not make: the user took over for this task.
    engine.onExternalLevelChange(event.level);
    updateStatus(ctx);
  });

  // ----------------------------------------------------------------- command

  const SUBS = ["on", "off", "status", "test", "set", "log", "help"];

  pi.registerCommand(COMMAND, {
    description:
      "Toggle adaptive thinking-level routing (/jev-router on|off|status|test|set|log)",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        ...SUBS.map((s) => ({ value: s, label: s })),
        ...CONFIG_KEYS.map((k) => ({ value: `set ${k}`, label: `set ${k}` })),
      ].filter((i) => i.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      currentCtx = ctx;
      if (!cfg || !engine) {
        ctx.ui.notify("jev-router is still initializing; try again in a moment", "warning");
        return;
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "";

      if (sub === "" || sub === "on" || sub === "off") {
        cfg.enabled = sub === "" ? !cfg.enabled : sub === "on";
        await saveConfig(cfg);
        updateStatus(ctx);
        ctx.ui.notify(
          cfg.enabled
            ? `jev-router ENABLED (jev: ${jevConfigured(cfg) ? `${cfg.model}` : "not configured, local rules"})`
            : "jev-router DISABLED (thinking level stays under your control)",
          "info",
        );
        return;
      }

      if (sub === "status") {
        const s = engine.status();
        ctx.ui.notify(
          [
            `jev-router status`,
            `  enabled: ${s.enabled} | active: ${s.active} | manual override: ${s.manualOverride}`,
            `  model supports reasoning: ${s.reasoningModel} | jev configured: ${s.jevConfigured}`,
            `  endpoint: ${cfg.endpoint || "(not set)"} | model: ${cfg.model || "(not set)"}`,
            `  key source: ${cfg.apiKey ? "config" : process.env.JEV_API_KEY ? "JEV_API_KEY" : `cc-switch:${cfg.providerId}`}`,
            `  current level: ${s.currentLevel ?? pi.getThinkingLevel()} | last source: ${s.lastSource ?? "-"}`,
            `  task: ${s.taskType ?? "-"} (${s.taskId ?? "-"}) | escalations: ${s.escalations} | downgrades: ${s.downgrades} | decisions: ${s.decisions}`,
            `  log: ${cfg.logEnabled ? cfg.logFile : "(disabled)"}`,
            `  config file: ${configPath()}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "test") {
        if (!jevConfigured(cfg)) {
          ctx.ui.notify(
            `Jev is not configured. Set endpoint/model via /jev-router set endpoint <url>, /jev-router set model <id>, or JEV_ENDPOINT/JEV_MODEL env vars.`,
            "warning",
          );
          return;
        }
        ctx.ui.notify("Consulting jev with a test question...", "info");
        try {
          const result = await consultJev(cfg, testSnapshot(), "connectivity test");
          const probs = Object.entries(result.probabilities)
            .sort((a, b) => b[1] - a[1])
            .map(([k, p]) => `  ${k}: ${p.toFixed(2)}`)
            .join("\n");
          ctx.ui.notify(
            `jev OK (${result.model}, ${result.latencyMs}ms)\n${probs}\n-> ${result.level} (confidence ${result.confidence.toFixed(2)})`,
            "info",
          );
        } catch (err) {
          ctx.ui.notify(`jev test failed: ${(err as Error).message}`, "error");
        }
        return;
      }

      if (sub === "set") {
        const key = parts[1] as ConfigKey | undefined;
        const value = parts.slice(2).join(" ");
        if (!key || !CONFIG_KEYS.includes(key) || value === "") {
          ctx.ui.notify(
            `Usage: /${COMMAND} set <key> <value>\nKeys: ${CONFIG_KEYS.join(", ")}`,
            "warning",
          );
          return;
        }
        const coerced = coerceConfigValue(key, value);
        if (!coerced.ok) {
          ctx.ui.notify(coerced.error, "error");
          return;
        }
        (cfg as unknown as Record<string, unknown>)[key] = coerced.value;
        await saveConfig(cfg);
        if (key === "logFile" || key === "logEnabled") {
          logger = new JsonlLogger(cfg.logFile);
          engine = buildEngine(cfg, logger);
        }
        updateStatus(ctx);
        ctx.ui.notify(`jev-router ${key} = ${String(coerced.value)}`, "info");
        return;
      }

      if (sub === "log") {
        try {
          const { readFile } = await import("node:fs/promises");
          const raw = await readFile(cfg.logFile, "utf8").catch(() => "");
          const lines = raw.trim().split("\n").filter(Boolean);
          if (lines.length === 0) {
            ctx.ui.notify("No routing decisions logged yet", "info");
            return;
          }
          const recent = lines.slice(-5).reverse().map((l) => {
            try {
              const e = JSON.parse(l) as Record<string, unknown>;
              if (e.kind === "task-summary") {
                return `summary: ${String(e.task_id)} final=${String(e.final_level)} esc=${String(e.escalations)} down=${String(e.downgrades)} tests ${String(e.tests_failed)}/${String(e.tests_run)} failed`;
              }
              return `${String(e.timestamp).slice(11, 19)} ${String(e.trigger)} ${String(e.thinking_level_before)}->${String(e.thinking_level_after)} (${String(e.source)}) ${String(e.reason).slice(0, 70)}`;
            } catch {
              return l.slice(0, 100);
            }
          });
          await ctx.ui.select(
            `Recent decisions (${lines.length} total, ${cfg.logFile})`,
            recent,
          );
        } catch (err) {
          ctx.ui.notify(`Cannot read log: ${(err as Error).message}`, "error");
        }
        return;
      }

      // help
      ctx.ui.notify(
        [
          "jev-router commands:",
          `  /${COMMAND}              toggle automatic routing`,
          `  /${COMMAND} on|off       explicit toggle`,
          `  /${COMMAND} status       configuration + live routing state`,
          `  /${COMMAND} test         verify Jev connectivity`,
          `  /${COMMAND} set <k> <v>  set ${CONFIG_KEYS.join("|")}`,
          `  /${COMMAND} log          show recent routing decisions`,
          "Levels: low < medium < high < xhigh. Falls back to local rules when Jev is unconfigured/unreachable.",
        ].join("\n"),
        "info",
      );
    },
  });
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && b.text) parts.push(b.text);
  }
  return parts.join("\n").slice(0, 8000);
}

function testSnapshot() {
  return {
    task: "connectivity test",
    task_type: "implementation" as const,
    current_thinking_level: "medium" as RoutedLevel,
    base_thinking_level: "medium" as RoutedLevel,
    context: { relevant_files: 0, changed_files: 0, context_tokens: 0 },
    execution: {
      tool_calls: 0,
      previous_failures: 0,
      env_failures: 0,
      tests_run: 0,
      tests_failed: 0,
      consecutive_clean_turns: 0,
      escalations: 0,
      downgrades: 0,
    },
    recent_error: "",
    recent_error_kind: null,
    recent_actions: [],
  };
}
