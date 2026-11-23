import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentRunController } from "../../agent-runs/agent-run-store.ts";
import type { BriefRun } from "../../briefs/brief-types.ts";
import type { NimbusBriefsToml } from "../../config/nimbus-toml.ts";
import { LocalIndex } from "../../index/local-index.ts";
import type { LlmRouter } from "../../llm/router.ts";
import { createMemoryVault } from "../../testing/bun-test-support.ts";
import type { HttpSidecarOpts } from "./http-sidecar.ts";
import {
  bootAgentsIntoHttpSidecar,
  bootBriefsIntoHttpSidecar,
  bootResolveFetchableIntoHttpSidecar,
  httpOriginFor,
} from "./http-sidecar-boot.ts";

let db: Database;
let index: LocalIndex;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  index = new LocalIndex(db);
});
afterEach(() => {
  db.close();
});

const EMPTY_REPORT_JSON = '{"summary":"s","findings":[],"conflicts":[],"gaps":[]}';

/** A router whose single provider answers every generate() with `text`; `undefined` = none. */
function routerAnswering(text: string | undefined, isLocal = true): LlmRouter {
  return {
    selectProvider: async () =>
      text === undefined
        ? undefined
        : { generate: async () => ({ text, modelUsed: "fake-model", isLocal }) },
  } as unknown as LlmRouter;
}

function briefsToml(overrides: Partial<NimbusBriefsToml> = {}): NimbusBriefsToml {
  return { enabled: true, preferLocal: true, ttlMinutes: 30, ...overrides };
}

async function untilTerminal(run: BriefRun): Promise<BriefRun["status"]> {
  for (let i = 0; i < 200 && (run.status === "collecting" || run.status === "running"); i++) {
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  return run.status;
}

function newRun(opts: HttpSidecarOpts): BriefRun {
  const created = opts.briefRuns?.create({
    brief: "why did it break",
    sources: [],
    useIndex: false,
  });
  if (created === undefined || "error" in created) throw new Error("expected a run");
  return created.run;
}

describe("bootBriefsIntoHttpSidecar", () => {
  test("a disabled [briefs] section wires nothing onto the sidecar options", () => {
    const opts: HttpSidecarOpts = {};
    bootBriefsIntoHttpSidecar({
      briefsToml: briefsToml({ enabled: false }),
      llmRouter: routerAnswering(EMPTY_REPORT_JSON),
      localIndex: index,
      db,
      scheduleItemEmbedding: undefined,
      httpSidecarOpts: opts,
    });
    expect(opts.briefRuns).toBeUndefined();
    expect(opts.briefStartRun).toBeUndefined();
    expect(opts.briefSave).toBeUndefined();
  });

  function boot(router: LlmRouter, scheduled: string[] = []): HttpSidecarOpts {
    const opts: HttpSidecarOpts = {};
    bootBriefsIntoHttpSidecar({
      briefsToml: briefsToml(),
      llmRouter: router,
      localIndex: index,
      db,
      scheduleItemEmbedding: (id) => scheduled.push(id),
      httpSidecarOpts: opts,
    });
    return opts;
  }

  test("an enabled section wires the run store, the starter and the saver", () => {
    const opts = boot(routerAnswering(EMPTY_REPORT_JSON));
    expect(opts.briefRuns).toBeDefined();
    expect(typeof opts.briefStartRun).toBe("function");
    expect(typeof opts.briefSave).toBe("function");
  });

  test("[briefs] ttl_minutes sets the run lifetime in whole minutes", () => {
    const opts: HttpSidecarOpts = {};
    bootBriefsIntoHttpSidecar({
      briefsToml: briefsToml({ ttlMinutes: 2 }),
      llmRouter: routerAnswering(undefined),
      localIndex: index,
      db,
      scheduleItemEmbedding: undefined,
      httpSidecarOpts: opts,
    });
    const run = newRun(opts);
    expect(run.expiresAtMs - run.createdAtMs).toBe(2 * 60_000);
  });

  test("starting an unknown run id is a silent no-op", () => {
    const opts = boot(routerAnswering(EMPTY_REPORT_JSON));
    expect(() => opts.briefStartRun?.("run_does_not_exist")).not.toThrow();
  });

  test("a run with no provider ends failed with llm_unavailable", async () => {
    const opts = boot(routerAnswering(undefined));
    const run = newRun(opts);
    opts.briefStartRun?.(run.id);
    expect(run.status).toBe("running");
    expect(await untilTerminal(run)).toBe("failed");
    expect(run.error).toBe("llm_unavailable");
  });

  test("a run whose model answers with valid JSON ends done and can be saved and embedded", async () => {
    const scheduled: string[] = [];
    const opts = boot(routerAnswering(EMPTY_REPORT_JSON), scheduled);
    const run = newRun(opts);
    opts.briefStartRun?.(run.id);
    expect(await untilTerminal(run)).toBe("done");
    expect(run.report?.summary).toBe("s");
    expect(run.report?.synthesis.model).toBe("fake-model");
    expect(run.report?.synthesis.remote).toBe(false);

    const saved = opts.briefSave?.(run.id);
    expect(saved?.itemId).toBeTruthy();
    expect(scheduled).toEqual([saved?.itemId as string]);
    const row = db
      .query(`SELECT service, type FROM item WHERE id = ?`)
      .get(saved?.itemId as string) as { service: string; type: string } | null;
    expect(row).toEqual({ service: "nimbus", type: "research_brief" });
  });

  test("a remote provider is disclosed on the finished report", async () => {
    const opts = boot(routerAnswering(EMPTY_REPORT_JSON, false));
    const run = newRun(opts);
    opts.briefStartRun?.(run.id);
    expect(await untilTerminal(run)).toBe("done");
    expect(run.report?.synthesis.remote).toBe(true);
  });

  test("saving an unknown run throws, and saving a run with no report throws", async () => {
    const opts = boot(routerAnswering(undefined));
    expect(() => opts.briefSave?.("run_does_not_exist")).toThrow("run not found");
    const run = newRun(opts);
    opts.briefStartRun?.(run.id);
    await untilTerminal(run);
    expect(() => opts.briefSave?.(run.id)).toThrow();
  });
});

describe("bootAgentsIntoHttpSidecar", () => {
  test("assigns the run store and an invoker that refuses an unknown agent", async () => {
    const opts: HttpSidecarOpts = {};
    bootAgentsIntoHttpSidecar({
      db,
      localIndex: index,
      configDir: "unused-config-dir",
      selfIdentity: undefined,
      llmRouter: undefined as never,
      httpSidecarOpts: opts,
    });
    expect(opts.agentRuns).toBeInstanceOf(AgentRunController);
    expect(await opts.agentInvoke?.("no_such_agent", {}, "label")).toEqual({
      ok: false,
      reason: "unknown_agent",
    });
  });

  test("the invoker is built over the SAME run store it assigns (a refused call opens no run)", async () => {
    const opts: HttpSidecarOpts = {};
    bootAgentsIntoHttpSidecar({
      db,
      localIndex: index,
      configDir: "unused-config-dir",
      selfIdentity: undefined,
      llmRouter: undefined as never,
      agentLatencyRecorder: { record: () => {} } as never,
      httpSidecarOpts: opts,
    });
    const before = opts.agentRuns?.activeCount();
    await opts.agentInvoke?.("no_such_agent", {}, "label");
    expect(opts.agentRuns?.activeCount()).toBe(before);
  });
});

describe("httpOriginFor", () => {
  async function vaultWith(entries: Record<string, string>) {
    const vault = createMemoryVault();
    for (const [k, v] of Object.entries(entries)) await vault.set(k, v);
    return vault;
  }

  test("returns the literal http origin of a self-hosted GitLab, Jenkins or Jira", async () => {
    const vault = await vaultWith({
      "gitlab.api_base": "http://GitLab.Internal:8080/api/v4/",
      "jenkins.base_url": " http://ci.internal/jenkins ",
      "jira.base_url": "http://jira.internal",
    });
    expect(await httpOriginFor(vault, "gitlab")).toBe("http://gitlab.internal:8080");
    expect(await httpOriginFor(vault, "jenkins")).toBe("http://ci.internal");
    expect(await httpOriginFor(vault, "jira")).toBe("http://jira.internal");
  });

  test("an https origin is never an http exception", async () => {
    const vault = await vaultWith({ "gitlab.api_base": "https://gitlab.example.com/api/v4" });
    expect(await httpOriginFor(vault, "gitlab")).toBeNull();
  });

  test.each([
    ["absent", {}],
    ["blank", { "jira.base_url": "   " }],
    ["unparseable", { "jira.base_url": "not a url" }],
  ])("an %s secret yields null", async (_label, entries) => {
    expect(await httpOriginFor(await vaultWith(entries), "jira")).toBeNull();
  });

  test("github and bitbucket never carry an http exception, even with a secret", async () => {
    const vault = await vaultWith({
      "github.api_base": "http://ghe.internal",
      "bitbucket.base_url": "http://bb.internal",
    });
    expect(await httpOriginFor(vault, "github")).toBeNull();
    expect(await httpOriginFor(vault, "bitbucket")).toBeNull();
  });
});

describe("bootResolveFetchableIntoHttpSidecar", () => {
  test("derives the fetchable predicate from the Vault fresh on every call", async () => {
    const vault = createMemoryVault();
    const opts: HttpSidecarOpts = {};
    bootResolveFetchableIntoHttpSidecar({ vault, httpSidecarOpts: opts });

    const empty = await opts.resolveFetchable?.();
    expect(empty?.("github.com")).toBe(false);

    await vault.set("github.pat", "ghp_x");
    const configured = await opts.resolveFetchable?.();
    expect(configured?.("github.com")).toBe(true);
    expect(configured?.("GitHub.com")).toBe(true);
    expect(configured?.("gitlab.com")).toBe(false);

    // Revoking the credential stops advertising it on the very next call.
    await vault.delete("github.pat");
    expect((await opts.resolveFetchable?.())?.("github.com")).toBe(false);
  });
});
