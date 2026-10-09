import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NimbusFleetJobToml } from "../../../src/config/fleet-toml.ts";
import { listEgress } from "../../../src/egress/egress-verify.ts";
import { buildFleetInvoker, type FleetJobOutcome } from "../../../src/fleet/fleet-invoker.ts";
import {
  createFleetRemoteBudget,
  type FleetRemoteBudget,
} from "../../../src/fleet/fleet-synthesis-router.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { LlmRegistry } from "../../../src/llm/registry.ts";
import type { LlmRouterConfig } from "../../../src/llm/router.ts";
import type { LlmGenerateOptions, LlmProvider } from "../../../src/llm/types.ts";

// This tree is NOT loaded by `bun test packages/gateway/src` — run the CI command
// (`bun test packages/gateway packages/cli scripts`) to exercise it.

/**
 * I38, composed end to end through a REAL agent.
 *
 * Every other I38 test stubs at least one layer: the wrapper tests drive the two doors directly,
 * and `fleet-invoker.test.ts`'s composed block replaces `dispatch` with a function that calls the
 * runner by hand. This file stubs only the vendor's network. The job goes through the real
 * `buildFleetInvoker`, its default dispatch (the real `dispatchAgentsRpc`), the real `changelog`
 * handler and renderer, the real `emitBriefWithSynthesis` → `buildAgentSynthesisRunner` path, and
 * a real `LlmRegistry` whose `addRoute` applies `wrapLedgeredProvider` — so a remote call that
 * happens is a real `model`-class `egress_ledger` row, and one that does not happen is its absence.
 *
 * `changelog` is chosen because it is fleet-eligible and renders on an empty index (no
 * `[ci.service.*]` → zero counts), so the test needs no seeded data to prove the agent ran.
 */

const REMOTE_MODEL = "frontier-test-model";
const SYNTH_MARKER = "SYNTHESISED-BY-FAKE-REMOTE";
/** The line `synthesize.ts` puts before the deterministic template inside the prompt. */
const TEMPLATE_LEAD =
  "Deterministic fallback rendering (use as a structural template — do not copy verbatim):\n";

const ROUTER_CONFIG: LlmRouterConfig = {
  preferLocal: true,
  localModel: "llama3.2",
  minReasoningParams: 7,
  enforceAirGap: false,
};

const JOB: NimbusFleetJobToml = {
  name: "nightly-changelog",
  agent: "changelog",
  intervalSeconds: 3600,
  params: {},
  digestMinDelta: 1,
  sweep: null,
};

/** A REMOTE vendor whose network is the only thing faked. Counts every real generate. */
function fakeRemoteProvider(): { provider: LlmProvider; calls: LlmGenerateOptions[] } {
  const calls: LlmGenerateOptions[] = [];
  const provider: LlmProvider = {
    providerId: "fakevendor",
    isLocal: false,
    isAvailable: async () => true,
    listModels: async () => [{ provider: "fakevendor", modelName: REMOTE_MODEL }],
    generate: async (opts) => {
      calls.push(opts);
      // A plausible rewrite: the deterministic template the prompt carries, plus a marker. It must
      // keep the template's interleaved disclosures, or I31's contract check discards it and the
      // brief falls back to the deterministic render — which would hide whether the call happened.
      const idx = opts.prompt.indexOf(TEMPLATE_LEAD);
      const template = idx === -1 ? "# Changelog\n" : opts.prompt.slice(idx + TEMPLATE_LEAD.length);
      return {
        text: `${template}\n${SYNTH_MARKER}\n`,
        tokensIn: 1,
        tokensOut: 1,
        modelUsed: REMOTE_MODEL,
        isLocal: false,
        provider: "fakevendor",
      };
    },
  };
  return { provider, calls };
}

describe("I38 composed path — fleet invoker → real dispatch → real changelog agent → real ledger", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function setup(budget: FleetRemoteBudget): {
    db: Database;
    calls: LlmGenerateOptions[];
    invoke: (job: NimbusFleetJobToml) => Promise<FleetJobOutcome>;
  } {
    const configDir = mkdtempSync(join(tmpdir(), "nimbus-fleet-i38-"));
    // Without `allow-remote` the DEFAULT `synthesis = "local"` refuses a remote provider on its
    // own, and every assertion in case A would hold for a reason unrelated to I38.
    writeFileSync(join(configDir, "nimbus.toml"), '[agents]\nsynthesis = "allow-remote"\n');
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    cleanups.push(() => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    });

    const registry = new LlmRegistry({ config: ROUTER_CONFIG, db });
    const { provider, calls } = fakeRemoteProvider();
    // The ONLY remote route, entered through `addRoute` so `wrapLedgeredProvider` ledgers it.
    registry.addRoute(provider, REMOTE_MODEL);

    const invoke = buildFleetInvoker({
      db,
      // `LlmRouter` satisfies `SynthesisRouter` structurally — the same object production hands in.
      router: registry.llmRouter,
      budget,
      configDir,
      timeoutMs: 30_000,
      // NO `dispatch`: the default is the real `dispatchAgentsRpc`.
    });
    return { db, calls, invoke };
  }

  function modelRows(db: Database): ReturnType<typeof listEgress> {
    return listEgress(db, {}).filter((r) => r.sourceType === "model");
  }

  test("A: allow_remote = false — the real agent renders deterministically, nothing leaves", async () => {
    const budget = createFleetRemoteBudget(false, 0);
    const { db, calls, invoke } = setup(budget);

    const out = await invoke(JOB);

    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    // The real changelog renderer ran — a stub dispatch could not produce this heading.
    expect(out.briefMarkdown).toContain("# Changelog");
    expect(out.briefMarkdown).not.toContain(SYNTH_MARKER);
    // The invariant: no remote generate, and no `model` row in the real ledger.
    expect(calls).toHaveLength(0);
    expect(modelRows(db)).toHaveLength(0);
    expect(listEgress(db, {})).toHaveLength(0);
    expect(budget.spent()).toBe(0);
    // And the withholding is disclosed on THIS brief, not merely counted.
    const synthesis = JSON.parse(out.synthesisJson ?? "null") as Record<string, unknown>;
    expect(synthesis["fleetRemoteWithheld"]).toBe(1);
  });

  test("B: allow_remote = true, budget 1 — granted once, ledgered once", async () => {
    const budget = createFleetRemoteBudget(true, 1);
    const { db, calls, invoke } = setup(budget);

    const out = await invoke(JOB);

    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    // The synthesised text came back through the real agent's emit path.
    expect(out.briefMarkdown).toContain(SYNTH_MARKER);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.egressMethod).toBe("agents.changelog.synthesis");
    const rows = modelRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: "model",
      destination: "fakevendor",
      method: "agents.changelog.synthesis",
      resultStatus: "authorized",
    });
    expect(budget.spent()).toBe(1);
    const synthesis = JSON.parse(out.synthesisJson ?? "null") as Record<string, unknown>;
    expect(synthesis).not.toHaveProperty("fleetRemoteWithheld");

    // Same run, budget now spent: the second job is withheld and nothing more leaves.
    const second = await invoke(JOB);
    expect(second.status).toBe("done");
    if (second.status !== "done") return;
    expect(second.briefMarkdown).toContain("# Changelog");
    expect(second.briefMarkdown).not.toContain(SYNTH_MARKER);
    expect(calls).toHaveLength(1);
    expect(modelRows(db)).toHaveLength(1);
    const s2 = JSON.parse(second.synthesisJson ?? "null") as Record<string, unknown>;
    expect(s2["fleetRemoteWithheld"]).toBe(1);
  });
});
