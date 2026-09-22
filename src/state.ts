/**
 * AgentState tracker — mirrors the decision-input structure from the spec (§9).
 * Fed from pi events; never talks to Jev or pi internals directly.
 */

import type { ErrorKind, ToolFailure } from "./errors.ts";
import { classifyToolResult, looksLikeTestRun, type RawToolResult } from "./errors.ts";
import type { RoutedLevel } from "./levels.ts";

export type TaskType =
  | "implementation"
  | "debugging"
  | "refactoring"
  | "architecture"
  | "testing"
  | "documentation"
  | "optimization";

const TASK_TYPE_PATTERNS: Array<[TaskType, RegExp]> = [
  // NOTE: \b word boundaries only work for ASCII; CJK alternatives must stay outside \b(...).
  ["debugging", /\b(fix|debug|bug|error|exception|crash|stack ?trace|regression|NPE|stacktrace|failing|broken)\b|修复|调试|报错|排错/i],
  ["architecture", /\b(architecture|architect|system design|overall design|schema design|migration plan)\b|技术方案|架构|设计.{0,6}(系统|方案)/i],
  ["refactoring", /\b(refactor|restructure|clean ?up|decouple|extract (class|method|module))\b|重(构|组)|整理/i],
  ["optimization", /\b(optimi[sz]e|performance|bottleneck|latency|speed ?up|too slow|memory usage)\b|优化|性能|慢/i],
  ["testing", /\b(write|add|fix) (the )?(unit )?tests?\b|\btest (suite|coverage|case)\b|单元测试|测试用例/i],
  ["documentation", /\b(document|docs|readme|comment(s)? (for|on)|changelog)\b|文档|注释|说明文档/i],
];

export function classifyTaskType(prompt: string): TaskType {
  for (const [type, re] of TASK_TYPE_PATTERNS) {
    if (re.test(prompt)) return type;
  }
  return "implementation";
}

/** Base level a task type starts at when the local rule engine drives routing. */
export function baseLevelForTask(type: TaskType): RoutedLevel {
  switch (type) {
    case "documentation":
      return "low";
    case "architecture":
    case "optimization":
      return "high";
    // implementation / debugging / refactoring / testing: ordinary coding tasks.
    default:
      return "medium";
  }
}

export interface TaskSnapshot {
  task: string;
  task_type: TaskType;
  current_thinking_level: RoutedLevel;
  base_thinking_level: RoutedLevel;
  context: {
    relevant_files: number;
    changed_files: number;
    context_tokens: number;
  };
  execution: {
    tool_calls: number;
    previous_failures: number;
    env_failures: number;
    tests_run: number;
    tests_failed: number;
    consecutive_clean_turns: number;
    escalations: number;
    downgrades: number;
  };
  recent_error: string;
  recent_error_kind: ErrorKind | null;
  recent_actions: string[];
}

export interface TurnReport {
  failures: ToolFailure[];
  testsRun: number;
  testsFailed: number;
  changedFiles: string[];
  toolCalls: number;
  actions: string[];
}

export class AgentState {
  readonly taskId: string;
  taskText = "";
  taskType: TaskType = "implementation";
  baseLevel: RoutedLevel = "medium";
  currentLevel: RoutedLevel = "medium";

  toolCalls = 0;
  reasoningFailures = 0;
  envFailures = 0;
  testsRun = 0;
  testsFailed = 0;
  escalations = 0;
  downgrades = 0;

  /** Turns with no failure at all, counted since the last failure or level change. */
  consecutiveCleanTurns = 0;

  recentError: string | null = null;
  recentErrorKind: ErrorKind | null = null;
  recentActions: string[] = [];

  readonly changedFiles = new Set<string>();
  readonly touchedFiles = new Set<string>();

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  startTask(prompt: string, base: RoutedLevel, currentLevel: RoutedLevel): void {
    this.taskText = prompt.replace(/\s+/g, " ").trim().slice(0, 400);
    this.taskType = classifyTaskType(prompt);
    this.baseLevel = base;
    this.currentLevel = currentLevel;
    this.toolCalls = 0;
    this.reasoningFailures = 0;
    this.envFailures = 0;
    this.testsRun = 0;
    this.testsFailed = 0;
    this.escalations = 0;
    this.downgrades = 0;
    this.consecutiveCleanTurns = 0;
    this.recentError = null;
    this.recentErrorKind = null;
    this.recentActions = [];
    this.changedFiles.clear();
    this.touchedFiles.clear();
  }

  /** Ingest one finalized tool result. Returns the failure classification if it failed. */
  ingestToolResult(raw: RawToolResult): ToolFailure | null {
    this.toolCalls += 1;
    // Count passing test runs too (a green run is still evidence about the task).
    const isTestRun = looksLikeTestRun(raw);
    if (isTestRun) this.testsRun += 1;
    const f = classifyToolResult(raw);
    if (raw.toolName === "edit" || raw.toolName === "write") {
      if (raw.path) {
        this.changedFiles.add(raw.path);
        this.recentActions.push(`${raw.toolName} ${raw.path}`);
      }
    } else if (raw.toolName === "read" || raw.toolName === "grep" || raw.toolName === "find" || raw.toolName === "ls") {
      if (raw.path) this.touchedFiles.add(raw.path);
    } else if ((raw.toolName === "bash" || raw.toolName === "powershell") && raw.command) {
      this.recentActions.push(`${raw.toolName}: ${raw.command.slice(0, 60)}`);
    }

    if (f) {
      if (f.isTestFailure) this.testsFailed += 1;
      if (f.kind === "environment") this.envFailures += 1;
      else this.reasoningFailures += 1; // reasoning + unknown both feed escalation
      this.recentError = f.excerpt;
      this.recentErrorKind = f.kind;
      this.consecutiveCleanTurns = 0;
      this.recentActions.push(`FAILED ${f.label}`);
    }
    if (this.recentActions.length > 12) {
      this.recentActions.splice(0, this.recentActions.length - 12);
    }
    return f;
  }

  /** Call at each turn_end: if the turn produced no failure, advance the clean streak. */
  endTurn(hadFailure: boolean): void {
    if (!hadFailure) this.consecutiveCleanTurns += 1;
  }

  snapshot(contextTokens: number): TaskSnapshot {
    return {
      task: this.taskText,
      task_type: this.taskType,
      current_thinking_level: this.currentLevel,
      base_thinking_level: this.baseLevel,
      context: {
        relevant_files: this.touchedFiles.size + this.changedFiles.size,
        changed_files: this.changedFiles.size,
        context_tokens: contextTokens,
      },
      execution: {
        tool_calls: this.toolCalls,
        previous_failures: this.reasoningFailures,
        env_failures: this.envFailures,
        tests_run: this.testsRun,
        tests_failed: this.testsFailed,
        consecutive_clean_turns: this.consecutiveCleanTurns,
        escalations: this.escalations,
        downgrades: this.downgrades,
      },
      recent_error: this.recentError ?? "",
      recent_error_kind: this.recentErrorKind,
      recent_actions: this.recentActions.slice(-6),
    };
  }
}

/** Compact one-line rendering of a snapshot for the Jev `state` field. */
export function snapshotToStateText(s: TaskSnapshot): string {
  return [
    `task: ${s.task}`,
    `task_type: ${s.task_type}`,
    `current_thinking_level: ${s.current_thinking_level}`,
    `base_thinking_level: ${s.base_thinking_level}`,
    `context: ${JSON.stringify(s.context)}`,
    `execution: ${JSON.stringify(s.execution)}`,
    s.recent_error ? `recent_error (${s.recent_error_kind}): ${s.recent_error}` : "recent_error: (none)",
    `recent_actions: ${s.recent_actions.join(" | ")}`,
  ].join("\n");
}
