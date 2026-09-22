/**
 * Routing policy: local rule engine (used when Jev is unconfigured/failed)
 * plus the anti-flap clamps applied to every decision (whether it came from
 * Jev or from the rules).
 *
 * Clamps (spec §6/§7):
 *  - escalation: at most +1 step per decision; needs a reasoning-type failure;
 *    capped by maxEscalationsPerTask.
 *  - downgrade: at most -1 step per decision; needs downgradeStableTurns clean
 *    turns; floor at the task's base level (below that only after 2x the
 *    stable window); capped by maxDowngradesPerTask.
 *  - after any level change, the level is pinned for pinTurns turns.
 *  - environment-only failures never escalate (spec §8).
 */

import { levelIndex, ROUTED_LEVELS, type RoutedLevel } from "./levels.ts";
import { baseLevelForTask, type TaskSnapshot, type TaskType } from "./state.ts";

export interface PolicyConfig {
  minCallIntervalMs: number;
  maxEscalationsPerTask: number;
  maxDowngradesPerTask: number;
  downgradeStableTurns: number;
  pinTurns: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  minCallIntervalMs: 15_000,
  maxEscalationsPerTask: 2,
  maxDowngradesPerTask: 2,
  downgradeStableTurns: 2,
  pinTurns: 1,
};

export interface PolicyState {
  lastJevCallAt: number;
  lastChangeTurn: number;
  escalations: number;
  downgrades: number;
}

export interface ClampResult {
  level: RoutedLevel;
  changed: boolean;
  /** Why the clamp kept/changed the level — recorded as the log `reason`. */
  reason: string;
  /** True when the suggested level was adjusted by policy (not taken verbatim). */
  clamped: boolean;
}

// ---------------------------------------------------------------------------
// Local rule engine (fallback when Jev is unconfigured or unreachable)
// ---------------------------------------------------------------------------

export function rulesDecideInitial(taskType: TaskType): RoutedLevel {
  return baseLevelForTask(taskType);
}

/**
 * Local rules for re-evaluation. Returns the level the rules recommend, or
 * null when the rules have no opinion (caller keeps the current level).
 */
export function rulesDecideReeval(
  snap: TaskSnapshot,
  trigger: "failure" | "downgrade-check",
): RoutedLevel | null {
  if (trigger === "failure") {
    const cur = snap.current_thinking_level;
    const idx = levelIndex(cur);
    // Environment-only problems are not fixable by more thinking (spec §8).
    if (snap.recent_error_kind === "environment" && snap.execution.previous_failures === 0) {
      return null;
    }
    // Escalate one step per repeated reasoning failure, up to xhigh.
    if (idx < ROUTED_LEVELS.length - 1) {
      return ROUTED_LEVELS[idx + 1];
    }
    return null;
  }
  // downgrade-check: drop back toward the task's base level once stable.
  const base = snap.base_thinking_level;
  if (levelIndex(snap.current_thinking_level) > levelIndex(base)) {
    return base;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Clamps shared by Jev and rules decisions
// ---------------------------------------------------------------------------

export function clampDecision(
  suggested: RoutedLevel,
  snap: TaskSnapshot,
  policy: PolicyConfig,
  ps: PolicyState,
  turnIndex: number,
  source: "jev" | "rules",
): ClampResult {
  const current = snap.current_thinking_level;
  if (suggested === current) {
    return { level: current, changed: false, reason: `${source} suggests keeping ${current}`, clamped: false };
  }

  const up = levelIndex(suggested) > levelIndex(current);

  if (up) {
    if (ps.escalations >= policy.maxEscalationsPerTask) {
      return {
        level: current,
        changed: false,
        reason: `escalation cap reached (${ps.escalations}/${policy.maxEscalationsPerTask}), keep ${current}`,
        clamped: true,
      };
    }
    if (snap.recent_error_kind === "environment" && snap.execution.previous_failures === 0) {
      return {
        level: current,
        changed: false,
        reason: `only environment-type failures seen; more thinking will not help, keep ${current}`,
        clamped: true,
      };
    }
    // At most +1 step per decision.
    const nextIdx = Math.min(levelIndex(current) + 1, levelIndex(suggested));
    const target = ROUTED_LEVELS[nextIdx];
    if (target === current) {
      return { level: current, changed: false, reason: `already at ${current}`, clamped: false };
    }
    ps.escalations += 1;
    ps.lastChangeTurn = turnIndex;
    return {
      level: target,
      changed: true,
      reason: `escalate ${current} -> ${target} (${source}; ${summarizePressure(snap)})`,
      clamped: target !== suggested,
    };
  }

  // Downgrade path.
  if (ps.downgrades >= policy.maxDowngradesPerTask) {
    return {
      level: current,
      changed: false,
      reason: `downgrade cap reached (${ps.downgrades}/${policy.maxDowngradesPerTask}), keep ${current}`,
      clamped: true,
    };
  }
  const stable = snap.execution.consecutive_clean_turns;
  if (stable < policy.downgradeStableTurns) {
    return {
      level: current,
      changed: false,
      reason: `not stable long enough for downgrade (${stable}/${policy.downgradeStableTurns} clean turns), keep ${current}`,
      clamped: true,
    };
  }
  const pinned = turnIndex - ps.lastChangeTurn < policy.pinTurns;
  if (pinned && ps.lastChangeTurn >= 0) {
    return {
      level: current,
      changed: false,
      reason: `level pinned right after change (turn ${ps.lastChangeTurn}), keep ${current}`,
      clamped: true,
    };
  }
  // Floor: the task's base level, unless the task has been stable for twice
  // the window — then trust the suggestion down to `low`.
  const baseIdx = levelIndex(snap.base_thinking_level);
  const curIdx = levelIndex(current);
  const longStable = stable >= policy.downgradeStableTurns * 2;
  const floorIdx = longStable ? 0 : baseIdx;
  const nextIdx = Math.max(levelIndex(suggested), floorIdx, curIdx - 1);
  const target = ROUTED_LEVELS[nextIdx];
  if (target === current) {
    return {
      level: current,
      changed: false,
      reason: `downgrade floor reached (base ${snap.base_thinking_level}), keep ${current}`,
      clamped: true,
    };
  }
  ps.downgrades += 1;
  ps.lastChangeTurn = turnIndex;
  return {
    level: target,
    changed: true,
    reason: `downgrade ${current} -> ${target} (${source}; ${stable} clean turns)`,
    clamped: target !== suggested,
  };
}

function summarizePressure(snap: TaskSnapshot): string {
  const parts: string[] = [];
  if (snap.execution.tests_failed > 0) parts.push(`tests failed ${snap.execution.tests_failed}/${snap.execution.tests_run}`);
  if (snap.execution.previous_failures > 0) parts.push(`failures ${snap.execution.previous_failures}`);
  if (snap.recent_error) parts.push(`recent: ${snap.recent_error_kind}`);
  return parts.join(", ") || "task pressure";
}

/** Whether the call-frequency gate allows another Jev call right now. */
export function callGateOpen(ps: PolicyState, policy: PolicyConfig, now: number, force: boolean): boolean {
  if (force) return true;
  return now - ps.lastJevCallAt >= policy.minCallIntervalMs;
}
