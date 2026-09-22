import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseLevel, foldLevel, levelIndex, ROUTED_LEVELS } from "../src/levels.ts";
import {
  classifyToolResult,
  classifyText,
  looksLikeTestRun,
  type RawToolResult,
} from "../src/errors.ts";
import {
  AgentState,
  classifyTaskType,
  baseLevelForTask,
} from "../src/state.ts";
import {
  rulesDecideInitial,
  rulesDecideReeval,
  clampDecision,
  callGateOpen,
  DEFAULT_POLICY,
  type PolicyState,
} from "../src/policy.ts";
import type { ErrorKind } from "../src/errors.ts";
import type { RoutedLevel } from "../src/levels.ts";
import { coerceConfigValue, DEFAULT_CONFIG } from "../src/config.ts";

// ------------------------------------------------------------------ levels

describe("levels", () => {
  test("parseLevel accepts only routed levels (case-insensitive)", () => {
    assert.equal(parseLevel("high"), "high");
    assert.equal(parseLevel("  XHIGH "), "xhigh");
    assert.equal(parseLevel("Medium"), "medium");
    assert.equal(parseLevel("max"), null);
    assert.equal(parseLevel("off"), null);
    assert.equal(parseLevel("superhigh"), null);
    assert.equal(parseLevel(42), null);
    assert.equal(parseLevel(undefined), null);
  });

  test("foldLevel maps pi's extended levels into the routed space", () => {
    assert.equal(foldLevel("off"), "low");
    assert.equal(foldLevel("minimal"), "low");
    assert.equal(foldLevel("max"), "xhigh");
    assert.equal(foldLevel("high"), "high");
  });

  test("levelIndex orders the ladder", () => {
    assert.ok(levelIndex("low") < levelIndex("medium"));
    assert.ok(levelIndex("medium") < levelIndex("high"));
    assert.ok(levelIndex("high") < levelIndex("xhigh"));
    assert.equal(ROUTED_LEVELS.length, 4);
  });
});

// ------------------------------------------------------------------ errors

function bashResult(overrides: Partial<RawToolResult> = {}): RawToolResult {
  return {
    toolName: "bash",
    isError: false,
    text: "all good",
    command: "echo hi",
    ...overrides,
  };
}

describe("errors: classification", () => {
  test("failing test run with assertion error is a reasoning-type test failure", () => {
    const raw = bashResult({
      isError: true,
      command: "npm test",
      text: "FAIL src/app.test.ts\nAssertionError: expected 2 to be 3\nCommand exited with code 1",
    });
    assert.equal(looksLikeTestRun(raw), true);
    const f = classifyToolResult(raw);
    assert.ok(f);
    assert.equal(f.isTestRun, true);
    assert.equal(f.isTestFailure, true);
    assert.equal(f.kind, "reasoning");
  });

  test("network error is environmental even inside a failed command", () => {
    const f = classifyToolResult(
      bashResult({
        isError: true,
        command: "npm install",
        text: "npm ERR! network request to https://registry.npmjs.org failed\nECONNREFUSED",
      }),
    );
    assert.ok(f);
    assert.equal(f.kind, "environment");
  });

  test("docker daemon down is environmental, not xhigh-worthy", () => {
    const f = classifyToolResult(
      bashResult({
        isError: true,
        command: "docker compose up",
        text: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      }),
    );
    assert.ok(f);
    assert.equal(f.kind, "environment");
  });

  test("compile error is reasoning", () => {
    assert.equal(classifyText("src/main.rs:42:5: error[E0308]: mismatched types — compilation failed"), "reasoning");
    assert.equal(classifyText("src/index.ts(12,3): error TS2345: Argument of type 'string'"), "reasoning");
  });

  test("env classification wins over reasoning patterns", () => {
    // Both patterns present: environment must dominate (do not escalate for networks).
    assert.equal(classifyText("ETIMEDOUT while running pytest: AssertionError expected"), "environment");
  });

  test("successful results are never failures", () => {
    assert.equal(classifyToolResult(bashResult()), null);
    assert.equal(classifyToolResult(bashResult({ text: "FAIL" })), null); // not an error result
  });

  test("bare 500 in line numbers does not classify as environment", () => {
    assert.equal(classifyText("src/app.py:500:1 unexpected indent"), "unknown");
    assert.equal(classifyText("HTTP 503 Service Unavailable"), "environment");
  });
});

// ------------------------------------------------------------------ state

describe("state: AgentState", () => {
  test("task type classification", () => {
    assert.equal(classifyTaskType("fix the Redis distributed lock issue in Spring Boot"), "debugging");
    assert.equal(classifyTaskType("设计一个新的缓存架构方案"), "architecture");
    assert.equal(classifyTaskType("refactor the auth module"), "refactoring");
    assert.equal(classifyTaskType("optimize the slow query performance"), "optimization");
    assert.equal(classifyTaskType("write unit tests for the parser"), "testing");
    assert.equal(classifyTaskType("update the README docs"), "documentation");
    assert.equal(classifyTaskType("add a /users endpoint to the API"), "implementation");
  });

  test("base level per task type", () => {
    assert.equal(baseLevelForTask("documentation"), "low");
    assert.equal(baseLevelForTask("implementation"), "medium");
    assert.equal(baseLevelForTask("debugging"), "medium");
    assert.equal(baseLevelForTask("architecture"), "high");
    assert.equal(baseLevelForTask("optimization"), "high");
  });

  test("ingest counts failures, tests, changed files and resets clean streak", () => {
    const s = new AgentState("t1");
    s.startTask("fix bug", "medium", "medium");
    s.ingestToolResult({ toolName: "read", isError: false, text: "ok", path: "a.ts" });
    s.ingestToolResult({ toolName: "edit", isError: false, text: "ok", path: "a.ts" });
    s.ingestToolResult({
      toolName: "bash",
      isError: true,
      command: "npm test",
      text: "AssertionError: expected 1 to be 2",
    });
    s.endTurn(false); // turn had a failure inside, endTurn(false) won't count it twice — actually ingest already reset
    const snap = s.snapshot(35000);
    assert.equal(snap.execution.tool_calls, 3);
    assert.equal(snap.execution.previous_failures, 1);
    assert.equal(snap.execution.tests_failed, 1);
    assert.equal(snap.execution.tests_run, 1);
    assert.equal(snap.context.changed_files, 1);
    assert.equal(snap.context.relevant_files, 2);
    assert.equal(snap.execution.consecutive_clean_turns, 1);
    assert.equal(snap.recent_error_kind, "reasoning");
  });

  test("clean turns accumulate after failure-free turns", () => {
    const s = new AgentState("t2");
    s.startTask("docs update", "low", "low");
    s.endTurn(false);
    s.endTurn(false);
    s.ingestToolResult({ toolName: "bash", isError: true, command: "pytest", text: "getaddrinfo ENOTFOUND" });
    assert.equal(s.consecutiveCleanTurns, 0);
    const snap = s.snapshot(0);
    assert.equal(snap.execution.env_failures, 1);
    assert.equal(snap.execution.previous_failures, 0);
    assert.equal(snap.recent_error_kind, "environment");
  });
});

// ------------------------------------------------------------------ policy

function policyState(): PolicyState {
  return { lastJevCallAt: 0, lastChangeTurn: -999, escalations: 0, downgrades: 0 };
}

function snapFor(overrides: {
  current?: RoutedLevel;
  base?: RoutedLevel;
  cleanTurns?: number;
  reasoningFailures?: number;
  envFailures?: number;
  errorKind?: ErrorKind | null;
}) {
  const s = new AgentState("snap");
  s.startTask("generic task", overrides.base ?? "medium", overrides.current ?? "medium");
  s.consecutiveCleanTurns = overrides.cleanTurns ?? 0;
  s.reasoningFailures = overrides.reasoningFailures ?? 0;
  s.envFailures = overrides.envFailures ?? 0;
  s.recentErrorKind = overrides.errorKind ?? null;
  return s.snapshot(0);
}

describe("policy: rules engine", () => {
  test("initial level from task type", () => {
    assert.equal(rulesDecideInitial("implementation"), "medium");
    assert.equal(rulesDecideInitial("documentation"), "low");
    assert.equal(rulesDecideInitial("architecture"), "high");
  });

  test("failure escalates one step; environment-only failure does not", () => {
    const snap = snapFor({ current: "medium", errorKind: "reasoning" });
    assert.equal(rulesDecideReeval(snap, "failure"), "high");
    const envSnap = snapFor({ current: "medium", errorKind: "environment", envFailures: 1 });
    assert.equal(rulesDecideReeval(envSnap, "failure"), null);
    const mixedSnap = snapFor({ current: "medium", errorKind: "environment", envFailures: 1, reasoningFailures: 1 });
    assert.equal(rulesDecideReeval(mixedSnap, "failure"), "high");
  });

  test("downgrade check returns base level when above it", () => {
    const snap = snapFor({ current: "high", base: "medium", cleanTurns: 2 });
    assert.equal(rulesDecideReeval(snap, "downgrade-check"), "medium");
    const atBase = snapFor({ current: "medium", base: "medium" });
    assert.equal(rulesDecideReeval(atBase, "downgrade-check"), null);
  });
});

describe("policy: clamps", () => {
  test("escalation takes Jev's suggestion when it is one step up", () => {
    const ps = policyState();
    const snap = snapFor({ current: "medium", errorKind: "reasoning" });
    const r = clampDecision("high", snap, DEFAULT_POLICY, ps, 3, "jev");
    assert.deepEqual([r.level, r.changed], ["high", true]);
    assert.equal(ps.escalations, 1);
    assert.equal(ps.lastChangeTurn, 3);
  });

  test("escalation jumps are clamped to +1 per decision", () => {
    const ps = policyState();
    const snap = snapFor({ current: "medium", errorKind: "reasoning" });
    const r = clampDecision("xhigh", snap, DEFAULT_POLICY, ps, 1, "jev");
    assert.equal(r.level, "high");
    assert.equal(r.changed, true);
    assert.equal(r.clamped, true);
  });

  test("escalation cap stops further increases", () => {
    const ps = policyState();
    ps.escalations = DEFAULT_POLICY.maxEscalationsPerTask;
    const snap = snapFor({ current: "high", errorKind: "reasoning" });
    const r = clampDecision("xhigh", snap, DEFAULT_POLICY, ps, 5, "jev");
    assert.equal(r.level, "high");
    assert.equal(r.changed, false);
    assert.match(r.reason, /cap reached/);
  });

  test("environment-only failure never escalates (spec §8)", () => {
    const ps = policyState();
    const snap = snapFor({ current: "medium", errorKind: "environment", envFailures: 1 });
    const r = clampDecision("high", snap, DEFAULT_POLICY, ps, 2, "jev");
    assert.equal(r.level, "medium");
    assert.equal(r.changed, false);
    assert.match(r.reason, /environment/);
  });

  test("downgrade requires the stability window", () => {
    const ps = policyState();
    const snap = snapFor({ current: "high", base: "medium", cleanTurns: 1 });
    const r = clampDecision("medium", snap, DEFAULT_POLICY, ps, 4, "rules");
    assert.equal(r.level, "high");
    assert.match(r.reason, /not stable long enough/);
  });

  test("downgrade is one step at a time with base-level floor", () => {
    const ps = policyState();
    const snap = snapFor({ current: "high", base: "medium", cleanTurns: 3 });
    const r = clampDecision("low", snap, DEFAULT_POLICY, ps, 4, "rules");
    assert.equal(r.level, "medium"); // floor at base + max -1 step
    assert.equal(ps.downgrades, 1);
  });

  test("long stability lets the level drop below the base (down to suggestion)", () => {
    const ps = policyState();
    const snap = snapFor({ current: "medium", base: "medium", cleanTurns: DEFAULT_POLICY.downgradeStableTurns * 2 });
    const r = clampDecision("low", snap, DEFAULT_POLICY, ps, 9, "rules");
    assert.equal(r.level, "low");
  });

  test("downgrade right after an escalation is pinned", () => {
    const ps = policyState();
    ps.escalations = 1;
    ps.lastChangeTurn = 4;
    const snap = snapFor({ current: "high", base: "medium", cleanTurns: DEFAULT_POLICY.downgradeStableTurns * 2 });
    const r = clampDecision("low", snap, { ...DEFAULT_POLICY, pinTurns: 2 }, ps, 5, "rules");
    assert.equal(r.level, "high");
    assert.match(r.reason, /pinned/);
  });

  test("same-level suggestion keeps without side effects", () => {
    const ps = policyState();
    const snap = snapFor({ current: "medium" });
    const r = clampDecision("medium", snap, DEFAULT_POLICY, ps, 1, "jev");
    assert.equal(r.changed, false);
    assert.equal(ps.escalations, 0);
    assert.equal(ps.downgrades, 0);
  });

  test("call gate throttles Jev invocations", () => {
    const ps = policyState();
    ps.lastJevCallAt = 1_000;
    assert.equal(callGateOpen(ps, { ...DEFAULT_POLICY, minCallIntervalMs: 15_000 }, 10_000, false), false);
    assert.equal(callGateOpen(ps, { ...DEFAULT_POLICY, minCallIntervalMs: 15_000 }, 16_001, false), true);
    assert.equal(callGateOpen(ps, { ...DEFAULT_POLICY, minCallIntervalMs: 15_000 }, 2_000, true), true); // force
  });
});

// ------------------------------------------------------------------ config

describe("config", () => {
  test("coerceConfigValue validates numbers", () => {
    assert.deepEqual(coerceConfigValue("timeoutMs", "5000"), { ok: true, value: 5000 });
    assert.equal(coerceConfigValue("timeoutMs", "-3").ok, false);
    assert.equal(coerceConfigValue("timeoutMs", "abc").ok, false);
    assert.equal(coerceConfigValue("maxEscalationsPerTask", "0").ok, false);
  });

  test("coerceConfigValue validates booleans and passes strings", () => {
    assert.deepEqual(coerceConfigValue("enabled", "on"), { ok: true, value: true });
    assert.deepEqual(coerceConfigValue("enabled", "false"), { ok: true, value: false });
    assert.equal(coerceConfigValue("enabled", "maybe").ok, false);
    assert.deepEqual(coerceConfigValue("endpoint", " https://x "), { ok: true, value: "https://x" });
  });

  test("defaults are safe (routing on, jev unconfigured -> rules)", () => {
    assert.equal(DEFAULT_CONFIG.enabled, true);
    assert.equal(DEFAULT_CONFIG.endpoint, "");
    assert.equal(DEFAULT_CONFIG.model, "");
    assert.equal(DEFAULT_CONFIG.timeoutMs > 0, true);
    assert.equal(DEFAULT_CONFIG.maxEscalationsPerTask >= 1, true);
  });
});
