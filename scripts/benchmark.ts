/**
 * 3-seed A/B benchmark: fixed thinking level (max, no routing) vs jev-router.
 *
 *   node scripts/benchmark.ts [--seeds 3]
 *
 * Task: fixed fail-then-fix bug (integer-division average) so every run
 * exercises at least one failing test run. Each run gets a fresh temp dir.
 *
 * Arms (interleaved A,B,A,B,... to decorrelate drift):
 *   A "max": pi --mode json --thinking max        (extension NOT loaded)
 *   B "jev": pi --mode json -e ./index.ts         (router on, auto levels)
 *
 * Metrics per run: wall seconds, summed input/output/cacheRead tokens
 * (from message_end.usage events), task success (node --test afterwards),
 * router decision count (decisions.jsonl line diff).
 *
 * Results: tmp/benchmark-results.json + stdout table. Feed into
 * scripts/charts.py (fig_ab).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "index.ts");
const DECISIONS_LOG = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "jev-router", "decisions.jsonl");

const CALC_JS = `function average(nums) {
  // BUG: integer division truncates the average
  return Math.floor(nums.reduce((a, b) => a + b, 0) / nums.length);
}
module.exports = { average };
`;

const CALC_TEST = `const test = require("node:test");
const assert = require("node:assert/strict");
const { average } = require("./calc.js");

test("average of [1,2] is 1.5", () => {
  assert.equal(average([1, 2]), 1.5);
});
test("average of [2,3,4] is 3", () => {
  assert.equal(average([2, 3, 4]), 3);
});
`;

const TASK =
  "IMPORTANT: First run 'node --test calc.test.js' to see the current state, " +
  "then fix whatever fails until all tests pass.";

interface RunResult {
  arm: "max" | "jev";
  seed: number;
  wall_s: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  /** 主模型（glm）token 见上三项；jev 的 token 单独计价，分列统计 */
  jev_input_tokens: number | null;
  jev_output_tokens: number | null;
  success: boolean;
  decisions: number | null;
  error?: string;
}

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-bench-"));
  writeFileSync(join(dir, "calc.js"), CALC_JS);
  writeFileSync(join(dir, "calc.test.js"), CALC_TEST);
  return dir;
}

function countLines(path: string): number {
  try {
    const st = statSync(path);
    if (!st.isFile()) return 0;
    return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Sum jev-side tokens from the decision-log lines written during a run. */
function jevTokensInNewLines(path: string, beforeLines: number): { input: number; output: number } {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    let input = 0;
    let output = 0;
    for (const line of lines.slice(beforeLines)) {
      try {
        const e = JSON.parse(line) as { jev_input_tokens?: number | null; jev_output_tokens?: number | null };
        input += e.jev_input_tokens ?? 0;
        output += e.jev_output_tokens ?? 0;
      } catch {
        // skip malformed line
      }
    }
    return { input, output };
  } catch {
    return { input: 0, output: 0 };
  }
}

function runPi(arm: "max" | "jev", workspace: string): { stdout: string; wall_s: number } {
  const args = ["--mode", "json", "--no-session"];
  if (arm === "max") {
    args.push("--thinking", "max");
  } else {
    args.push("-e", EXT);
  }
  // Quote the task so cmd.exe keeps it as ONE argv element even though it
  // contains single quotes (which cmd does not treat as quoting chars).
  const task = TASK.includes('"') ? TASK : `"${TASK}"`;
  args.push("--", task);

  const command = `pi ${args.join(" ")}`;
  const started = Date.now();
  const res = spawnSync(command, {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: true,
    timeout: 15 * 60 * 1000,
    env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
  });
  const wall_s = (Date.now() - started) / 1000;
  if (res.error) throw res.error;
  if (res.status !== 0 && !res.stdout) {
    throw new Error(`pi exited ${res.status}: ${String(res.stderr).slice(0, 300)}`);
  }
  return { stdout: res.stdout ?? "", wall_s };
}

function parseUsage(jsonLines: string): {
  input: number;
  output: number;
  cacheRead: number;
  parseErrors: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let parseErrors = 0;
  for (const line of jsonLines.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number } };
      };
      if (e.type === "message_end" && e.message?.role === "assistant" && e.message.usage) {
        input += e.message.usage.input ?? 0;
        output += e.message.usage.output ?? 0;
        cacheRead += e.message.usage.cacheRead ?? 0;
      }
    } catch {
      parseErrors += 1;
    }
  }
  return { input, output, cacheRead, parseErrors };
}

function taskSucceeded(workspace: string): boolean {
  const res = spawnSync("node", ["--test", "calc.test.js"], {
    cwd: workspace,
    encoding: "utf8",
    shell: true,
    timeout: 60_000,
  });
  return res.status === 0;
}

async function runOne(arm: "max" | "jev", seed: number): Promise<RunResult> {
  const workspace = makeWorkspace();
  const before = arm === "jev" ? countLines(DECISIONS_LOG) : 0;
  try {
    const { stdout, wall_s } = runPi(arm, workspace);
    const usage = parseUsage(stdout);
    const success = taskSucceeded(workspace);
    let decisions: number | null = null;
    let jevTokens = { input: 0, output: 0 };
    if (arm === "jev") {
      const after = countLines(DECISIONS_LOG);
      decisions = Math.max(0, after - before);
      jevTokens = jevTokensInNewLines(DECISIONS_LOG, before);
    }
    return {
      arm,
      seed,
      wall_s,
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_tokens: usage.cacheRead,
      jev_input_tokens: arm === "jev" ? jevTokens.input : null,
      jev_output_tokens: arm === "jev" ? jevTokens.output : null,
      success,
      decisions,
      ...(usage.parseErrors > 0 ? { error: `${usage.parseErrors} unparsable event lines` } : {}),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const seedsArg = process.argv.find((a) => a.startsWith("--seeds"));
  const seeds = seedsArg ? Number(seedsArg.split("=")[1] ?? process.argv[process.argv.indexOf(seedsArg) + 1]) : 3;
  const n = Number.isFinite(seeds) && seeds > 0 ? Math.floor(seeds) : 3;

  console.log(`3-seed A/B: max vs jev-router — ${n} interleaved seeds per arm`);
  console.log(`task: fail-then-fix (calc.js integer division), fresh dir per run\n`);

  const results: RunResult[] = [];
  for (let seed = 1; seed <= n; seed++) {
    for (const arm of ["max", "jev"] as const) {
      process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] arm=${arm} seed=${seed} ... `);
      try {
        const r = await runOne(arm, seed);
        results.push(r);
        console.log(
          `${r.wall_s.toFixed(1)}s | in ${r.input_tokens} out ${r.output_tokens} cache ${r.cache_read_tokens}` +
            ` | ${r.success ? "PASS" : "FAIL"}` +
            (r.decisions !== null ? ` | decisions ${r.decisions}` : "") +
            (r.error ? ` | ${r.error}` : ""),
        );
      } catch (err) {
        console.log(`ERROR ${(err as Error).message}`);
        results.push({
          arm,
          seed,
          wall_s: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          jev_input_tokens: null,
          jev_output_tokens: null,
          success: false,
          decisions: null,
          error: (err as Error).message,
        });
      }
    }
  }

  const outDir = join(ROOT, "tmp");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "benchmark-results.json");
  writeFileSync(outPath, JSON.stringify({ generated: new Date().toISOString(), seeds: n, results }, null, 2) + "\n");

  console.log(`\nresults written to ${outPath}`);
  console.log("\narm  seed  wall_s  glm_in  glm_out  glm_cache  jev_in  jev_out  success  decisions");
  for (const r of results) {
    console.log(
      `${r.arm.padEnd(4)} ${String(r.seed).padEnd(5)} ${r.wall_s.toFixed(1).padEnd(7)} ${String(r.input_tokens).padEnd(7)} ${String(r.output_tokens).padEnd(8)} ${String(r.cache_read_tokens).padEnd(10)} ${String(r.jev_input_tokens ?? "-").padEnd(7)} ${String(r.jev_output_tokens ?? "-").padEnd(8)} ${String(r.success).padEnd(8)} ${r.decisions ?? "-"}`,
    );
  }
  return 0;
}

main().then((c) => process.exit(c), (e) => {
  console.error(e);
  process.exit(1);
});
