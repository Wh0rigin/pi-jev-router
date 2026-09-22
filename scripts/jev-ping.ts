/**
 * Standalone Jev connectivity check (same protocol as the extension).
 *
 *   node scripts/jev-ping.ts
 *
 * Prints the level jev suggests for two probe snapshots (a trivial docs edit
 * and a deep concurrency debug) plus latency. Exit code 0 = reachable.
 */

import { consultJev, DEFAULT_JEV, resolveApiKey } from "../src/jev-client.ts";
import { AgentState } from "../src/state.ts";

async function main(): Promise<number> {
  const cfg = { ...DEFAULT_JEV };
  if (process.env.JEV_ENDPOINT) cfg.endpoint = process.env.JEV_ENDPOINT;
  if (process.env.JEV_MODEL) cfg.model = process.env.JEV_MODEL;

  if (!cfg.endpoint || !cfg.model) {
    console.error("jev is not configured: set JEV_ENDPOINT and JEV_MODEL (or use /jev-router set).");
    return 2;
  }
  const key = await resolveApiKey(cfg);
  if (!key) {
    console.error("no API key found: set JEV_API_KEY or configure the cc-switch credential store.");
    return 2;
  }
  console.log(`endpoint: ${cfg.endpoint}\nmodel:    ${cfg.model}\nkey:      ${"*".repeat(8)}${key.slice(-4)}`);

  const probes = [
    {
      name: "trivial docs edit",
      prompt: "Rename the variable 'data' to 'userData' in utils.ts and update its doc comment",
      failures: 0,
      error: "",
    },
    {
      name: "deep concurrency debug",
      prompt: "Fix a NullPointerException that only occurs when two requests commit the same inventory row concurrently",
      failures: 2,
      error: "NullPointerException at InventoryService.commit(InventoryService.java:88); medium attempt already failed",
    },
  ];

  let failed = false;
  for (const probe of probes) {
    const s = new AgentState("ping");
    s.startTask(probe.prompt, "medium", "medium");
    for (let i = 0; i < probe.failures; i++) {
      s.ingestToolResult({
        toolName: "bash",
        isError: true,
        command: "mvn test",
        text: probe.error || "test failure",
      });
    }
    const snap = s.snapshot(probe.failures > 1 ? 52_000 : 8_000);
    try {
      const r = await consultJev(cfg, snap, "jev-ping probe");
      console.log(
        `\nprobe [${probe.name}] -> ${r.level} (confidence ${r.confidence.toFixed(2)}, ${r.latencyMs}ms)` +
          `\n  probabilities: ${JSON.stringify(r.probabilities)}`,
      );
    } catch (err) {
      failed = true;
      console.error(`\nprobe [${probe.name}] FAILED: ${(err as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
