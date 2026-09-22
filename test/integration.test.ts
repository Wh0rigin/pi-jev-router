/**
 * Integration tests: drive the full decision loop (state -> Jev over HTTP ->
 * policy clamps -> level application -> JSONL logging) against a mock Jev
 * server that speaks the same choice protocol as pi-decision-prior.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JevRouterEngine, type StatusInfo } from "../src/engine.ts";
import { JsonlLogger, type DecisionLogEntry, type TaskSummaryLogEntry } from "../src/logger.ts";
import { DEFAULT_CONFIG, type RouterConfig } from "../src/config.ts";
import type { RoutedLevel, ThinkingLevel } from "../src/levels.ts";

// ---------------------------------------------------------------- mock jev

interface ScriptedAnswer {
  choice: string;
  confidence?: number;
  /** When set, the server replies with this HTTP status instead of an answer. */
  status?: number;
  /** When set, respond with a malformed body. */
  malformed?: boolean;
}

function startMockJev(script: ScriptedAnswer[]): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  let i = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        requests.push(JSON.parse(body));
      } catch {
        requests.push({ unparsable: body });
      }
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      if (step.status) {
        res.writeHead(step.status, { "content-type": "text/plain" });
        res.end("mock error");
        return;
      }
      if (step.malformed) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("<not json");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "jev-mock",
          answers: {
            q: {
              choice: step.choice,
              confidence: step.confidence ?? 0.82,
              probabilities: {
                low: step.choice === "low" ? 0.7 : 0.1,
                medium: step.choice === "medium" ? 0.7 : 0.1,
                high: step.choice === "high" ? 0.7 : 0.1,
                xhigh: step.choice === "xhigh" ? 0.7 : 0.1,
              },
            },
          },
          usage: { input_tokens: 120, output_tokens: 8 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1/systemone`, requests });
    });
  });
}

// ------------------------------------------------------------- test harness

interface Harness {
  engine: JevRouterEngine;
  levels: ThinkingLevel[];
  setCalls: ThinkingLevel[];
  notifications: Array<{ message: string; level: string }>;
  status(): StatusInfo;
  readLog(): Promise<Array<DecisionLogEntry | TaskSummaryLogEntry>>;
}

function makeHarness(configOverrides: Partial<RouterConfig>): Harness {
  const levels: ThinkingLevel[] = ["low"];
  const setCalls: ThinkingLevel[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const logFile = join(tmpdir(), `jev-router-test-${Math.random().toString(36).slice(2)}.jsonl`);
  const config: RouterConfig = {
    ...DEFAULT_CONFIG,
    logFile,
    apiKey: "test-key",
    timeoutMs: 2000,
    minCallIntervalMs: 0, // no throttling in tests
    ...configOverrides,
  };
  const logger = new JsonlLogger(logFile);
  const engine = new JevRouterEngine({
    config,
    logger,
    now: () => Date.now(),
    randomId: () => "task01",
    getContextTokens: () => 35_000,
    getThinkingLevel: () => levels[levels.length - 1],
    setThinkingLevel: (l) => {
      levels.push(l);
      setCalls.push(l);
    },
    notify: (message, level) => notifications.push({ message, level: level ?? "info" }),
    isReasoningModel: () => true,
  });
  return {
    engine,
    levels,
    setCalls,
    notifications,
    status: () => engine.status(),
    readLog: async () => {
      await new Promise((r) => setTimeout(r, 120)); // let async JSONL flushes land
      const raw = await readFile(logFile, "utf8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as DecisionLogEntry | TaskSummaryLogEntry);
    },
  };
}

const bashFail = (command: string, text: string) => [
  { toolName: "bash", isError: true, command, text },
];
const okTool = (toolName = "read") => [{ toolName, isError: false, text: "ok", path: "src/a.ts" }];

describe("integration: full routing loop with mock jev", () => {
  let mock: { server: Server; url: string; requests: unknown[] };
  let h: Harness;

  before(async () => {
    mock = await startMockJev([
      { choice: "medium" }, // task start
      { choice: "high" }, // failure turn 0
      { choice: "medium" }, // downgrade check turn 2
      { choice: "xhigh" }, // failure turn 3 (clamped to high? no: current medium -> +1 = high)
      { choice: "xhigh" }, // failure turn 4 (cap reached -> keep)
    ]);
    h = makeHarness({ endpoint: mock.url, model: "jev-mock" });
  });

  after(() => new Promise<void>((resolve) => mock.server.close(() => resolve())));

  test("scenario: start -> escalate -> downgrade -> escalate -> cap", async () => {
    const { engine } = h;

    // Task start: pi is at low, jev says medium.
    await engine.onTaskStart("Fix the Redis distributed lock issue in the Spring Boot project");
    assert.deepEqual(h.setCalls, ["medium"]);
    assert.equal(h.status().currentLevel, "medium");
    assert.equal(h.status().lastSource, "jev");

    // Turn 0: failing test -> escalate to high.
    await engine.onTurnEnd(
      [...okTool("read"),
      ...bashFail("npm test", "FAIL src/lock.test.ts\nAssertionError: expected lock to be released\nCommand exited with code 1")],
      0,
    );
    assert.deepEqual(h.setCalls, ["medium", "high"]);

    // Turn 1: clean turn -> streak 1, no downgrade yet.
    await engine.onTurnEnd(okTool("read"), 1);
    assert.deepEqual(h.setCalls, ["medium", "high"]);

    // Turn 2: streak 2 -> downgrade check; jev says medium.
    await engine.onTurnEnd(
      [...okTool("read"), { toolName: "edit", isError: false, text: "ok", path: "src/b.ts" }],
      2,
    );
    assert.deepEqual(h.setCalls, ["medium", "high", "medium"]);

    // Turn 3: another failing test -> escalate; jev says xhigh but clamp is +1 -> high.
    await engine.onTurnEnd(
      bashFail("go test ./...", "# FAIL TestLock\n--- FAIL: TestLock (0.00s)\nexit status 1"),
      3,
    );
    assert.deepEqual(h.setCalls, ["medium", "high", "medium", "high"]);

    // Turn 4: still failing -> jev says xhigh, but escalation cap (2) reached.
    await engine.onTurnEnd(
      bashFail("pytest", "AssertionError: assert 3 == 5\n1 failed in 0.2s"),
      4,
    );
    assert.deepEqual(h.setCalls, ["medium", "high", "medium", "high"]); // unchanged
    assert.equal(h.status().escalations, 2);
    assert.equal(h.status().downgrades, 1);

    // User takes over manually -> router suspends.
    engine.onExternalLevelChange("off");
    await engine.onTurnEnd(bashFail("npm test", "AssertionError: nope"), 5);
    assert.deepEqual(h.setCalls, ["medium", "high", "medium", "high"]); // still unchanged
    assert.equal(h.status().manualOverride, true);

    // Settle -> summary entry.
    engine.onTaskSettled();
    await new Promise((r) => setTimeout(r, 50));
  });

  test("jev received well-formed choice questions", () => {
    assert.ok(mock.requests.length >= 5);
    for (const req of mock.requests) {
      const r = req as { model?: string; questions?: { q?: { options?: string[]; type?: string } }; state?: string };
      assert.equal(r.model, "jev-mock");
      assert.equal(r.questions?.q?.type, "choice");
      assert.deepEqual(r.questions?.q?.options, ["low", "medium", "high", "xhigh"]);
      assert.ok(r.state && r.state.length > 0);
    }
    // The state payload includes our agent-state summary.
    const first = mock.requests[0] as { state?: string };
    assert.match(first.state!, /task_type: debugging/);
  });

  test("decision log is valid JSONL with the spec'd fields", async () => {
    const entries = await h.readLog();
    assert.ok(entries.length >= 6);
    const decisions = entries.filter((e): e is DecisionLogEntry => e.kind === "decision");
    const summaries = entries.filter((e): e is TaskSummaryLogEntry => e.kind === "task-summary");
    assert.equal(summaries.length, 1);

    for (const d of decisions) {
      for (const field of [
        "timestamp", "task_id", "trigger", "source", "task_type",
        "thinking_level_before", "thinking_level_after", "changed", "clamped",
        "reason", "previous_failures", "tool_calls", "tests_run", "tests_failed",
        "context_tokens", "jev_latency_ms", "execution_time_ms",
      ]) {
        assert.ok(field in d, `missing field ${field}`);
      }
      assert.ok(["low", "medium", "high", "xhigh"].includes(d.thinking_level_before));
      assert.ok(["low", "medium", "high", "xhigh"].includes(d.thinking_level_after));
      assert.ok(d.jev_latency_ms === null || d.jev_latency_ms >= 0);
    }

    // Sequence: start(->medium), failure(->high), downgrade(->medium), failure(->high), failure(cap), manual
    const seq = decisions.map((d) => `${d.trigger}:${d.thinking_level_before}>${d.thinking_level_after}`);
    assert.deepEqual(seq, [
      "task-start:low>medium",
      "failure:medium>high",
      "downgrade-check:high>medium",
      "failure:medium>high",
      "failure:high>high",
      "manual-override:high>low", // user set pi to off -> routed space low
    ]);
    assert.equal(decisions[0].source, "jev");
    assert.equal(decisions[0].jev_confidence, 0.82);
    assert.equal(decisions[1].clamped, false);
    assert.equal(decisions[3].clamped, true); // xhigh suggestion clamped to high

    const s = summaries[0];
    assert.equal(s.final_level, "low"); // routed space of the user's manual "off"
    assert.equal(s.escalations, 2);
    assert.equal(s.downgrades, 1);
    assert.equal(s.tests_failed, 3);
    assert.equal(s.reasoning_failures, 3); // the post-override failure is not ingested
  });

  test("level changes produce notifications", () => {
    const msgs = h.notifications.map((n) => n.message).filter((m) => m.startsWith("jev-router:"));
    // 4 level changes: start low->medium, failure ->high, downgrade ->medium, failure ->high
    assert.equal(msgs.length, 4);
    assert.match(msgs[0], /low -> medium/);
    assert.match(msgs[1], /medium -> high/);
    assert.match(msgs[2], /high -> medium/);
    assert.match(msgs[3], /medium -> high/);
  });
});

describe("integration: fallback safety", () => {
  test("jev HTTP failure -> falls back to local rules, keeps routing alive", async () => {
    const mock = await startMockJev([{ status: 500 }]);
    const h = makeHarness({ endpoint: mock.url, model: "jev-mock" });
    try {
      await h.engine.onTaskStart("optimize the database query performance"); // jev 500 -> rules base high
      assert.deepEqual(h.setCalls, ["high"]);
      assert.equal(h.status().lastSource, "fallback");

      // Failure with jev down: rules escalate one step.
      await h.engine.onTurnEnd(
        bashFail("npm test", "AssertionError: expected 1 to be 2"),
        0,
      );
      // clamp: environment-only check passes (errorKind reasoning), +1 from high -> xhigh
      assert.deepEqual(h.setCalls, ["high", "xhigh"]);

      const entries = await h.readLog();
      const fallbacks = entries.filter(
        (e): e is DecisionLogEntry => e.kind === "decision" && e.source === "fallback",
      );
      assert.equal(fallbacks.length, 2);
      assert.match(fallbacks[0].reason!, /jev failed/);
      assert.ok(fallbacks[0].error!.includes("500"));
    } finally {
      await new Promise<void>((r) => mock.server.close(() => r()));
    }
  });

  test("malformed jev answer -> fallback, invalid level never applied", async () => {
    const mock = await startMockJev([{ malformed: true }]);
    const h = makeHarness({ endpoint: mock.url, model: "jev-mock" });
    try {
      await h.engine.onTaskStart("refactor the parser module");
      assert.deepEqual(h.setCalls, ["medium"]); // rules base for refactoring
      const entries = await h.readLog();
      const d = entries[0] as DecisionLogEntry;
      assert.equal(d.source, "fallback");
      assert.match(d.error!, /invalid|Unexpected|JSON/i);
    } finally {
      await new Promise<void>((r) => mock.server.close(() => r()));
    }
  });

  test("unconfigured jev -> warning once, then pure local rules", async () => {
    const h = makeHarness({ endpoint: "", model: "" });
    h.engine.warnUnconfigured();
    await h.engine.onTaskStart("update the README documentation");
    // pi already at low, rules say low for docs tasks -> no change needed
    assert.deepEqual(h.setCalls, []);
    assert.equal(h.status().currentLevel, "low");
    assert.equal(h.status().lastSource, "rules");
    assert.equal(h.status().jevConfigured, false);
    const warned = h.notifications.filter((n) => n.level === "warning" && n.message.includes("not configured"));
    assert.equal(warned.length, 1);
    // Second task start must not repeat the warning; an implementation task moves low -> medium.
    h.engine.onTaskSettled();
    await h.engine.onTaskStart("add a /users endpoint to the API");
    assert.deepEqual(h.setCalls, ["medium"]);
    const warned2 = h.notifications.filter((n) => n.level === "warning" && n.message.includes("not configured"));
    assert.equal(warned2.length, 1);
  });

  test("environment-only failures never escalate nor call jev", async () => {
    const mock = await startMockJev([
      { choice: "medium" }, // task start
      { choice: "xhigh" }, // (would be offered if an escalation were attempted)
    ]);
    const h = makeHarness({ endpoint: mock.url, model: "jev-mock" });
    try {
      await h.engine.onTaskStart("debug the flaky integration test");
      const callsBefore = mock.requests.length;
      await h.engine.onTurnEnd(
        bashFail("npm install", "npm ERR! network ECONNREFUSED registry.npmjs.org"),
        0,
      );
      assert.deepEqual(h.setCalls, ["medium"]); // unchanged (task start answer)
      assert.equal(mock.requests.length, callsBefore); // jev not consulted
      const envWarnings = h.notifications.filter((n) => n.message.includes("environment-type"));
      assert.equal(envWarnings.length, 1);
    } finally {
      await new Promise<void>((r) => mock.server.close(() => r()));
    }
  });

  test("non-reasoning models disable the router entirely", async () => {
    const levels: ThinkingLevel[] = ["off"];
    const config: RouterConfig = { ...DEFAULT_CONFIG, logFile: join(tmpdir(), "unused.jsonl") };
    const engine = new JevRouterEngine({
      config,
      logger: new JsonlLogger(config.logFile),
      now: () => Date.now(),
      randomId: () => "x",
      getContextTokens: () => 0,
      getThinkingLevel: () => levels[0],
      setThinkingLevel: (l) => levels.push(l),
      notify: () => {},
      isReasoningModel: () => false,
    });
    await engine.onTaskStart("any task");
    assert.equal(levels.length, 1); // no setThinkingLevel call
    assert.equal(engine.status().active, false);
  });

  test("disabled router does nothing (slash off)", async () => {
    const h = makeHarness({ endpoint: "", model: "", enabled: false });
    await h.engine.onTaskStart("fix a bug");
    await h.engine.onTurnEnd(bashFail("npm test", "AssertionError"), 0);
    assert.deepEqual(h.setCalls, []);
    assert.equal(h.status().decisions, 0);
  });
});

describe("integration: steering continuations do not reset the task", () => {
  test("engine keeps task state across re-evaluations", async () => {
    const mock = await startMockJev([
      { choice: "medium" },
      { choice: "high" },
      { choice: "high" },
    ]);
    const h = makeHarness({ endpoint: mock.url, model: "jev-mock" });
    try {
      await h.engine.onTaskStart("fix the login bug");
      await h.engine.onTurnEnd(bashFail("npm test", "FAIL\nAssertionError"), 0);
      // (A steering message would arrive here — handled in index.ts by not
      // calling onTaskStart again; the engine simply continues.)
      await h.engine.onTurnEnd(bashFail("npm run test:e2e", "FAIL\nCommand exited with code 1"), 1);
      // Both failures counted on the same task:
      const s = h.status();
      assert.equal(s.taskType, "debugging");
      assert.equal(s.taskId, "task01");
      const entries = await h.readLog();
      const decisions = entries.filter((e): e is DecisionLogEntry => e.kind === "decision");
      assert.equal(new Set(decisions.map((d) => d.task_id)).size, 1);
    } finally {
      await new Promise<void>((r) => mock.server.close(() => r()));
    }
  });
});

describe("integration: log persistence to temp dir", () => {
  test("logger creates parent directories and flushes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-log-"));
    const logFile = join(dir, "nested", "decisions.jsonl");
    const logger = new JsonlLogger(logFile);
    logger.append({
      kind: "decision",
      timestamp: new Date().toISOString(),
      task_id: "abc",
      trigger: "task-start",
      source: "rules",
      task_type: "implementation",
      thinking_level_before: "low",
      thinking_level_after: "medium",
      changed: true,
      clamped: false,
      reason: "test entry",
      previous_failures: 0,
      env_failures: 0,
      tool_calls: 0,
      tests_run: 0,
      tests_failed: 0,
      context_tokens: 0,
      turn_index: 0,
      jev_latency_ms: null,
      jev_confidence: null,
      jev_probabilities: null,
      execution_time_ms: 5,
    });
    await new Promise((r) => setTimeout(r, 100));
    const raw = await readFile(logFile, "utf8");
    assert.match(raw, /"task_id":"abc"/);
    await rm(dir, { recursive: true, force: true });
  });
});
