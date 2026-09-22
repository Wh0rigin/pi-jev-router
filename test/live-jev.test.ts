/**
 * Live connectivity test against the real Jev instance.
 * Skipped unless JEV_LIVE=1 is set (keeps `npm test` hermetic):
 *
 *   JEV_LIVE=1 node --test test/live-jev.test.ts
 *
 * Uses the same key-resolution chain as the extension:
 * config-less -> JEV_API_KEY env -> cc-switch credential store.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { consultJev, resolveApiKey } from "../src/jev-client.ts";
import { loadConfig } from "../src/config.ts";
import { AgentState } from "../src/state.ts";

const LIVE = process.env.JEV_LIVE === "1";

test(
  "live jev: resolves a key and answers a level question",
  { skip: !LIVE ? "set JEV_LIVE=1 to run the live connectivity test" : false },
  async () => {
    // Same config chain as the running extension: ~/.pi/jev-router.json
    // + JEV_ENDPOINT/JEV_MODEL env overrides.
    const cfg = await loadConfig();
    if (!cfg.endpoint || !cfg.model) {
      throw new Error("jev not configured: set endpoint/model in ~/.pi/jev-router.json or via env");
    }

    const key = await resolveApiKey(cfg);
    assert.ok(key, "an API key must be resolvable (env or cc-switch store)");

    const s = new AgentState("live-test");
    s.startTask(
      "Fix a NullPointerException that only occurs when two requests commit the same inventory row concurrently",
      "medium",
      "medium",
    );
    s.ingestToolResult({
      toolName: "bash",
      isError: true,
      command: "mvn test",
      text: "NullPointerException at InventoryService.commit(InventoryService.java:88)\nTests run: 24, Failures: 1",
    });
    const snap = s.snapshot(41_000);

    const result = await consultJev(cfg, snap, "live connectivity test");
    assert.ok(["low", "medium", "high", "xhigh"].includes(result.level));
    assert.ok(result.latencyMs >= 0);
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
    console.log(
      `live jev -> ${result.level} (confidence ${result.confidence.toFixed(2)}, ` +
        `${result.latencyMs}ms, ${result.inputTokens}+${result.outputTokens} tokens, model ${result.model})`,
    );
    console.log("probabilities:", result.probabilities);
  },
);
