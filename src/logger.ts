/**
 * JSONL decision logger. Two entry kinds:
 *  - "decision": one router evaluation (task start / failure / downgrade check)
 *  - "task-summary": written when the agent run fully settles
 *
 * Fields follow the experiment schema from the spec (§12); `reason` is always
 * generated locally (Jev itself only ever answers with a level).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RoutedLevel } from "./levels.ts";
import type { TaskType } from "./state.ts";

export type DecisionSource = "jev" | "rules" | "fallback";

export interface DecisionLogEntry {
  kind: "decision";
  timestamp: string;
  task_id: string;
  trigger: "task-start" | "failure" | "downgrade-check" | "manual-override";
  source: DecisionSource;
  task_type: TaskType;
  thinking_level_before: RoutedLevel;
  thinking_level_after: RoutedLevel;
  changed: boolean;
  clamped: boolean;
  reason: string;
  previous_failures: number;
  env_failures: number;
  tool_calls: number;
  tests_run: number;
  tests_failed: number;
  context_tokens: number;
  turn_index: number | null;
  jev_latency_ms: number | null;
  jev_confidence: number | null;
  jev_probabilities: Record<string, number> | null;
  execution_time_ms: number;
  error?: string;
}

export interface TaskSummaryLogEntry {
  kind: "task-summary";
  timestamp: string;
  task_id: string;
  task: string;
  task_type: TaskType;
  final_level: RoutedLevel;
  base_level: RoutedLevel;
  escalations: number;
  downgrades: number;
  tool_calls: number;
  tests_run: number;
  tests_failed: number;
  reasoning_failures: number;
  env_failures: number;
  execution_time_ms: number;
  decisions: number;
}

export type LogEntry = DecisionLogEntry | TaskSummaryLogEntry;

export class JsonlLogger {
  private queue: LogEntry[] = [];
  private writing = false;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  append(entry: LogEntry): void {
    this.queue.push(entry);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.writing || this.queue.length === 0) return;
    this.writing = true;
    const pending = this.queue.splice(0, this.queue.length);
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const lines = pending.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await appendFile(this.path, lines, "utf8");
    } catch {
      // Logging must never break routing; drop on failure.
    } finally {
      this.writing = false;
      if (this.queue.length > 0) void this.flush();
    }
  }
}
