/**
 * Decision engine — the testable core of the router.
 *
 * Orchestrates: state tracking -> trigger evaluation -> Jev (or local rules)
 * -> policy clamps -> level application -> JSONL logging.
 *
 * All pi/IO side effects come in through EngineDeps so tests can drive the
 * full loop with mock deps and a mock Jev server.
 */

import type { RawToolResult } from "./errors.ts";
import { parseLevel } from "./levels.ts";
import { foldLevel, type RoutedLevel, type ThinkingLevel } from "./levels.ts";
import type { DecisionLogEntry, DecisionSource, JsonlLogger } from "./logger.ts";
import {
  callGateOpen,
  clampDecision,
  rulesDecideInitial,
  rulesDecideReeval,
  type PolicyConfig,
  type PolicyState,
} from "./policy.ts";
import { AgentState, classifyTaskType, type TaskSnapshot, type TaskType } from "./state.ts";
import { consultJev, type JevResult } from "./jev-client.ts";
import type { RouterConfig } from "./config.ts";

export type Trigger = DecisionLogEntry["trigger"];

export interface EngineDeps {
  config: RouterConfig & PolicyConfig;
  logger: JsonlLogger;
  now(): number;
  randomId(): string;
  getContextTokens(): number;
  /** Current pi thinking level (may be off/minimal/max). */
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  /** Whether the active model supports reasoning at all. */
  isReasoningModel(): boolean;
  /** Injectable for tests; default calls the real client. */
  consultJev?(trigger: Trigger, snap: TaskSnapshot): Promise<JevResult>;
}

export interface StatusInfo {
  enabled: boolean;
  active: boolean;
  manualOverride: boolean;
  reasoningModel: boolean;
  jevConfigured: boolean;
  currentLevel: RoutedLevel | null;
  lastSource: DecisionSource | null;
  taskId: string | null;
  taskType: string | null;
  escalations: number;
  downgrades: number;
  decisions: number;
}

export class JevRouterEngine {
  private state: AgentState | null = null;
  private ps: PolicyState = freshPolicyState();
  private taskStartedAt = 0;
  private decisions = 0;
  private manualOverride = false;
  private lastSource: DecisionSource | null = null;
  private warnedUnconfigured = false;
  private warnedNonReasoning = false;
  private warnedEnvOnly = false;
  /** Guards thinking_level_select feedback loop. */
  suppressLevelEvent = false;
  private readonly deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  // --------------------------------------------------------------------------
  // Event entry points
  // --------------------------------------------------------------------------

  /** New user prompt that starts a fresh task (not a steer/follow-up). */
  async onTaskStart(prompt: string): Promise<void> {
    const { config } = this.deps;
    if (!config.enabled) return;

    if (!this.deps.isReasoningModel()) {
      if (!this.warnedNonReasoning) {
        this.warnedNonReasoning = true;
        this.deps.notify(
          "jev-router: active model does not support reasoning; router inactive",
          "warning",
        );
      }
      return;
    }

    const fallbackBase = rulesDecideInitial(classifyTaskType(prompt));
    this.state = new AgentState(this.deps.randomId());
    this.ps = freshPolicyState();
    this.manualOverride = false;
    this.taskStartedAt = this.deps.now();
    this.state.startTask(prompt, fallbackBase, foldLevel(this.deps.getThinkingLevel()));

    const snap = this.state.snapshot(this.deps.getContextTokens());
    const started = this.deps.now();
    const outcome = await this.decide("task-start", snap, fallbackBase);
    this.applyOutcome(outcome, snap, "task-start", this.deps.now() - started);
  }

  /** One turn finished (LLM response + tool results). */
  async onTurnEnd(rawResults: RawToolResult[], turnIndex: number): Promise<void> {
    const { config } = this.deps;
    if (!config.enabled || !this.state || this.manualOverride) return;

    let hadFailure = false;
    let sawFailure = false;
    let sawEnvOnlyFailure = false;
    for (const raw of rawResults) {
      const f = this.state.ingestToolResult(raw);
      if (f) {
        sawFailure = true;
        hadFailure = true;
        if (f.kind === "environment") sawEnvOnlyFailure = true;
      }
    }
    this.state.endTurn(hadFailure);

    if (!sawFailure) {
      await this.maybeDowngrade(turnIndex);
      return;
    }

    // Environment-only failures: thinking harder will not help (spec §8).
    if (sawEnvOnlyFailure && this.state.reasoningFailures === 0) {
      if (!this.warnedEnvOnly) {
        this.warnedEnvOnly = true;
        this.deps.notify(
          "jev-router: environment-type error detected (network/daemon/etc.); not escalating thinking level",
          "warning",
        );
      }
      return;
    }

    await this.maybeEscalate(turnIndex);
  }

  /** Agent run fully settled (no retries/queue left). */
  onTaskSettled(): void {
    if (!this.state) return;
    const s = this.state;
    this.deps.logger.append({
      kind: "task-summary",
      timestamp: new Date(this.deps.now()).toISOString(),
      task_id: s.taskId,
      task: s.taskText,
      task_type: s.taskType,
      final_level: s.currentLevel,
      base_level: s.baseLevel,
      escalations: s.escalations,
      downgrades: s.downgrades,
      tool_calls: s.toolCalls,
      tests_run: s.testsRun,
      tests_failed: s.testsFailed,
      reasoning_failures: s.reasoningFailures,
      env_failures: s.envFailures,
      execution_time_ms: this.deps.now() - this.taskStartedAt,
      decisions: this.decisions,
    });
  }

  /** thinking_level_select fired for a change we did not make. */
  onExternalLevelChange(level: ThinkingLevel): void {
    if (!this.state) return;
    const before = this.state.currentLevel;
    const after = foldLevel(level);
    this.manualOverride = true;
    this.state.currentLevel = after;
    this.deps.logger.append({
      kind: "decision",
      timestamp: new Date(this.deps.now()).toISOString(),
      task_id: this.state.taskId,
      trigger: "manual-override",
      source: "fallback",
      task_type: this.state.taskType,
      thinking_level_before: before,
      thinking_level_after: after,
      changed: before !== after,
      clamped: false,
      reason: `user manually set thinking level to ${level}; router suspended for this task`,
      previous_failures: this.state.reasoningFailures,
      env_failures: this.state.envFailures,
      tool_calls: this.state.toolCalls,
      tests_run: this.state.testsRun,
      tests_failed: this.state.testsFailed,
      context_tokens: this.deps.getContextTokens(),
      turn_index: null,
      jev_latency_ms: null,
      jev_confidence: null,
      jev_probabilities: null,
      execution_time_ms: 0,
    });
  }

  status(): StatusInfo {
    const cfg = this.deps.config;
    return {
      enabled: cfg.enabled,
      active: cfg.enabled && !this.manualOverride && this.deps.isReasoningModel(),
      manualOverride: this.manualOverride,
      reasoningModel: this.deps.isReasoningModel(),
      jevConfigured: Boolean(cfg.endpoint && cfg.model),
      currentLevel: this.state?.currentLevel ?? null,
      lastSource: this.lastSource,
      taskId: this.state?.taskId ?? null,
      taskType: this.state?.taskType ?? null,
      escalations: this.state?.escalations ?? 0,
      downgrades: this.state?.downgrades ?? 0,
      decisions: this.decisions,
    };
  }

  /** Test/session reset hook. */
  resetSessionState(): void {
    this.state = null;
    this.ps = freshPolicyState();
    this.manualOverride = false;
    this.lastSource = null;
    this.warnedUnconfigured = false;
    this.warnedNonReasoning = false;
    this.warnedEnvOnly = false;
    this.decisions = 0;
  }

  /** Warn once that Jev is unconfigured and the local rule engine takes over. */
  warnUnconfigured(): void {
    if (this.warnedUnconfigured) return;
    this.warnedUnconfigured = true;
    this.deps.notify(
      "jev-router: Jev is not configured (endpoint/model missing) — falling back to the local rule engine",
      "warning",
    );
  }

  // --------------------------------------------------------------------------
  // Decision internals
  // --------------------------------------------------------------------------

  private async maybeEscalate(turnIndex: number): Promise<void> {
    if (!this.state) return;
    const now = this.deps.now();
    if (!callGateOpen(this.ps, this.deps.config, now, false)) return;
    const snap = this.state.snapshot(this.deps.getContextTokens());
    const started = now;
    const outcome = await this.decide("failure", snap);
    this.applyOutcome(outcome, snap, "failure", this.deps.now() - started, turnIndex);
  }

  private async maybeDowngrade(turnIndex: number): Promise<void> {
    if (!this.state) return;
    const { config } = this.deps;
    const snap = this.state.snapshot(this.deps.getContextTokens());
    const curIdx = ROUTED_INDEX[snap.current_thinking_level];
    const baseIdx = ROUTED_INDEX[snap.base_thinking_level];
    const longStable = snap.execution.consecutive_clean_turns >= config.downgradeStableTurns * 2;
    const candidate =
      curIdx > 0 && // never below low
      (curIdx > baseIdx || longStable) &&
      snap.execution.consecutive_clean_turns >= config.downgradeStableTurns && // avoid wasted Jev calls
      this.ps.downgrades < config.maxDowngradesPerTask &&
      turnIndex - this.ps.lastChangeTurn >= config.pinTurns;
    if (!candidate) return;
    const now = this.deps.now();
    if (!callGateOpen(this.ps, config, now, false)) return;

    const started = now;
    const outcome = await this.decide("downgrade-check", snap);
    this.applyOutcome(outcome, snap, "downgrade-check", this.deps.now() - started, turnIndex);
  }

  /**
   * Produce a raw suggested level: Jev when configured (falling back to rules
   * on any error), local rules otherwise. Never throws.
   */
  private async decide(
    trigger: Trigger,
    snap: TaskSnapshot,
    initialFallback?: RoutedLevel,
  ): Promise<{ suggested: RoutedLevel; source: DecisionSource; jev?: JevResult; error?: string }> {
    const { config } = this.deps;
    const configured = Boolean(config.endpoint && config.model);
    if (configured) {
      try {
        const consult = this.deps.consultJev ?? defaultConsult(config);
        const jev = await consult(trigger, snap);
        this.ps.lastJevCallAt = this.deps.now();
        this.decisions += 1;
        return { suggested: jev.level, source: "jev", jev };
      } catch (err) {
        // Jev failed -> safe fallback (spec principle 3).
        this.ps.lastJevCallAt = this.deps.now();
        this.decisions += 1;
        const suggested =
          initialFallback ??
          rulesDecideReeval(snap, trigger === "downgrade-check" ? "downgrade-check" : "failure") ??
          snap.current_thinking_level;
        return {
          suggested,
          source: "fallback",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    if (!this.warnedUnconfigured) {
      this.warnUnconfigured();
    }
    this.decisions += 1;
    const suggested =
      initialFallback ??
      rulesDecideReeval(snap, trigger === "downgrade-check" ? "downgrade-check" : "failure") ??
      snap.current_thinking_level;
    return { suggested, source: "rules" };
  }

  private applyOutcome(
    outcome: { suggested: RoutedLevel; source: DecisionSource; jev?: JevResult; error?: string },
    snap: TaskSnapshot,
    trigger: Trigger,
    elapsedMs: number,
    turnIndex?: number,
  ): void {
    if (!this.state) return;
    const before = this.state.currentLevel;
    let after = before;
    let changed = false;
    let clamped = false;
    let reason: string;

    if (trigger === "task-start") {
      // Initial decision: take the suggestion (Jev or rules base) verbatim.
      after = outcome.suggested;
      changed = after !== before;
      clamped = false;
      reason =
        `initial level for ${snap.task_type} task via ${outcome.source}` +
        (outcome.jev ? ` (confidence ${outcome.jev.confidence.toFixed(2)})` : "") +
        (outcome.error ? ` [jev failed: ${outcome.error}]` : "");
    } else {
      const res = clampDecision(
        outcome.suggested,
        snap,
        this.deps.config,
        this.ps,
        turnIndex ?? 0,
        outcome.source === "fallback" ? "rules" : outcome.source,
      );
      after = res.level;
      changed = res.changed;
      clamped = res.clamped;
      reason =
        res.reason +
        (outcome.error ? ` [jev failed: ${outcome.error}]` : "") +
        (outcome.jev ? ` [jev p=${outcome.jev.confidence.toFixed(2)}]` : "");
    }

    this.state.currentLevel = after;
    this.lastSource = outcome.source;

    if (changed) {
      // Sync the per-task counters the snapshot/summary report from.
      const up = ROUTED_INDEX[after] > ROUTED_INDEX[before];
      if (trigger === "task-start") {
        // Initial selection is not an escalation event.
      } else if (up) {
        this.state.escalations += 1;
      } else {
        this.state.downgrades += 1;
      }
      this.suppressLevelEvent = true;
      try {
        this.deps.setThinkingLevel(after);
      } finally {
        this.suppressLevelEvent = false;
      }
      this.deps.notify(`jev-router: ${before} -> ${after} (${reason})`, "info");
    }

    this.deps.logger.append({
      kind: "decision",
      timestamp: new Date(this.deps.now()).toISOString(),
      task_id: this.state.taskId,
      trigger,
      source: outcome.source,
      task_type: snap.task_type,
      thinking_level_before: before,
      thinking_level_after: after,
      changed,
      clamped,
      reason,
      previous_failures: snap.execution.previous_failures,
      env_failures: snap.execution.env_failures,
      tool_calls: snap.execution.tool_calls,
      tests_run: snap.execution.tests_run,
      tests_failed: snap.execution.tests_failed,
      context_tokens: snap.context.context_tokens,
      turn_index: turnIndex ?? null,
      jev_latency_ms: outcome.jev?.latencyMs ?? null,
      jev_confidence: outcome.jev?.confidence ?? null,
      jev_probabilities: outcome.jev?.probabilities ?? null,
      execution_time_ms: elapsedMs,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }
}

// ---------------------------------------------------------------------------

const ROUTED_INDEX: Record<RoutedLevel, number> = { low: 0, medium: 1, high: 2, xhigh: 3 };

function freshPolicyState(): PolicyState {
  return { lastJevCallAt: 0, lastChangeTurn: -999, escalations: 0, downgrades: 0 };
}

/** Binds the real Jev client to the configured endpoint. */
function defaultConsult(cfg: RouterConfig) {
  return (trigger: Trigger, snap: TaskSnapshot): Promise<JevResult> =>
    consultJev(cfg, snap, trigger);
}

export { parseLevel };
