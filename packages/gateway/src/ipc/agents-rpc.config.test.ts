import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { markExtracted, setConfidence, upsertCandidate } from "../decisions/decision-store.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { type AgentsRpcContext, AgentsRpcError, dispatchAgentsRpc } from "./agents-rpc.ts";

/**
 * The inputs `agents-rpc.ts` reads from `nimbus.toml` PER CALL rather than leaving to the agents —
 * `[user] me_person_id`, the `[metrics.dora.*]`/`[ci.service.*]` service bindings,
 * `[decisions] min_confidence` and `[[filesystem.roots]]` — each proven by an effect only that
 * config can produce, plus the degrade-don't-abort path a malformed service block takes.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const openDbs: Database[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function indexDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return db;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function configDirWith(toml: string): string {
  const dir = tempDir("nimbus-agents-cfg-");
  writeFileSync(join(dir, "nimbus.toml"), toml, "utf8");
  return dir;
}

type Ready = { sessionId: string; findings: Record<string, unknown>; synthesis: unknown };

/**
 * A `notify` that settles on `<kind>.briefReady` (rejecting on `<kind>.briefError`). Briefs are
 * built in an un-awaited task after the dispatch resolves, so the brief is only observable here.
 */
function capture(kind: string) {
  let resolveReady!: (v: Ready) => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<Ready>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const notify = (method: string, params: unknown): void => {
    if (method === `${kind}.briefReady`) resolveReady(params as Ready);
    if (method === `${kind}.briefError`) rejectReady(new Error(JSON.stringify(params)));
  };
  return { notify, ready };
}

/** A runner that records each prompt and declines, so synthesis falls back deterministically. */
function recordingRunner(): { runner: SynthesisRunner; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    runner: {
      run: (prompt: string) => {
        prompts.push(prompt);
        return Promise.resolve({ ok: false, reason: "no_eligible_provider" });
      },
    },
  };
}

/** The `AgentsRpcError` (or other error) a dispatch rejects with; resolving fails the test. */
async function rejection(method: string, params: unknown, ctx: AgentsRpcContext): Promise<Error> {
  const out: unknown = await dispatchAgentsRpc(method, params, ctx).then(
    (hit) => new Error(`${method} resolved: ${JSON.stringify(hit)}`),
    (e: unknown) => e,
  );
  expect(out).toBeInstanceOf(Error);
  expect((out as Error).message).not.toStartWith(`${method} resolved:`);
  return out as Error;
}

/**
 * A stderr spy that swallows output for the duration of `fn` and returns what was written.
 * Restored in `finally`, so a failing assertion inside cannot leave stderr muted for later files.
 */
async function withStderr<T>(fn: () => Promise<T>): Promise<{ value: T; written: string }> {
  const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const value = await fn();
    return { value, written: spy.mock.calls.map((c) => String(c[0])).join("") };
  } finally {
    spy.mockRestore();
  }
}

/** One active PagerDuty incident, written in the shape `connectors/pagerduty-sync.ts` writes. */
function seedPagerdutyIncident(db: Database, externalId: string, pdService: string): string {
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId,
    title: `Incident ${externalId}`,
    bodyPreview: "triggered",
    modifiedAt: now - HOUR_MS,
    metadata: {
      status: "triggered",
      incidentId: externalId,
      assignee_emails: [],
      resolved_by_email: null,
      unattributed_actors: [],
      opened_at_ms: now - HOUR_MS,
      pagerduty_service_id: pdService,
    },
    syncedAt: now,
  });
  return `pagerduty:${externalId}`;
}

const CHECKOUT_DORA =
  '[metrics.dora.checkout]\nrepos = ["github:acme/checkout"]\npagerduty_services = ["PSVC1"]\n';
/** `repos` is required, so this block makes the service-config loader throw. */
const MALFORMED_SERVICE = '[ci.service.checkout]\npagerduty_services = ["PSVC1"]\n';
const LOAD_FAILURE = "failed to load [metrics.dora.*]/[ci.service.*] from nimbus.toml";

describe("agents.oncall — [user] and the service bindings come from configDir", () => {
  test("[user] me_person_id resolves the owner without git, so the refusal is about INCIDENTS", async () => {
    // Without the override, an empty index refuses with ERR_ONCALL_IDENTITY_UNRESOLVED (the
    // shape-bound tests in agents-rpc.test.ts reach that). With it, identity resolves and the
    // refusal moves on to the next question — which incidents are assigned to that person.
    const err = await rejection(
      "agents.oncall",
      {},
      {
        db: indexDb(),
        notify: () => {},
        configDir: configDirWith('[user]\nme_person_id = "person-me"\n'),
      },
    );
    expect(err).toBeInstanceOf(AgentsRpcError);
    expect((err as AgentsRpcError).rpcCode).toBe(-32000);
    expect(err.message).toStartWith(
      "ERR_ONCALL_NO_ACTIVE_INCIDENT: no active incident is assigned to you.",
    );
    expect(err.message).not.toContain("ERR_ONCALL_IDENTITY_UNRESOLVED");
  });

  test("a [metrics.dora.*] binding maps the named service onto its PagerDuty ids", async () => {
    const db = indexDb();
    const incidentItemId = seedPagerdutyIncident(db, "PINC1", "PSVC1");
    const { runner, prompts } = recordingRunner();
    const cap = capture("oncall");
    const out = await dispatchAgentsRpc(
      "agents.oncall",
      { service: "checkout" },
      { db, notify: cap.notify, configDir: configDirWith(CHECKOUT_DORA), runner },
    );
    expect(out.kind).toBe("hit");
    const { findings, synthesis } = await cap.ready;
    expect((findings["incident"] as { id: string }).id).toBe(incidentItemId);
    expect(findings["selection"]).toBe("auto_service");
    expect(findings["binding"]).toEqual({
      nimbusServiceId: "checkout",
      pagerdutyServiceId: "PSVC1",
    });
    // The runner on the context reached synthesis.
    expect(prompts).toHaveLength(1);
    expect(synthesis).toEqual({ attempted: false, reason: "no_eligible_provider" });
  });

  test("a malformed service block DEGRADES to no bindings, says so on stderr, and still answers", async () => {
    const db = indexDb();
    seedPagerdutyIncident(db, "PINC1", "PSVC1");
    const { value: err, written } = await withStderr(() =>
      rejection(
        "agents.oncall",
        { service: "checkout" },
        { db, notify: () => {}, configDir: configDirWith(MALFORMED_SERVICE) },
      ),
    );
    // The agent still ran: with no binding, `checkout` names no PagerDuty ids, so the refusal is
    // the agent's own — not the loader's "missing required 'repos'" taking the call down.
    expect(err).toBeInstanceOf(AgentsRpcError);
    expect((err as AgentsRpcError).rpcCode).toBe(-32000);
    expect(err.message).toStartWith(
      "ERR_ONCALL_NO_ACTIVE_INCIDENT: no active incident for service `checkout`.",
    );
    expect(written).toContain(`agents.oncall: ${LOAD_FAILURE}`);
    expect(written).toContain("missing required 'repos'");
    expect(written).not.toContain("agents.changelog:");
  });

  test("an internal fault propagates unchanged rather than as one of the three refusals", async () => {
    const bare = new Database(":memory:");
    openDbs.push(bare);
    const err = await rejection(
      "agents.oncall",
      { incidentId: "pagerduty:PINC1" },
      { db: bare, notify: () => {} },
    );
    expect(err).not.toBeInstanceOf(AgentsRpcError);
    expect(err.message).toContain("no such table: item");
  });
});

describe("agents.changelog — the default window and the service bindings", () => {
  test("no sinceMs means seven days, no service means every service, and the runner is threaded", async () => {
    const { runner, prompts } = recordingRunner();
    const cap = capture("changelog");
    const out = await dispatchAgentsRpc(
      "agents.changelog",
      {},
      {
        db: indexDb(),
        notify: cap.notify,
        runner,
      },
    );
    expect(out.kind).toBe("hit");
    const { findings } = await cap.ready;
    const query = findings["query"] as { sinceMs: number; nowMs: number; service: unknown };
    expect(query.nowMs - query.sinceMs).toBe(7 * DAY_MS);
    expect(query.service).toBeNull();
    expect(prompts).toHaveLength(1);
  });

  const UNBOUND = "has no repositories and no PagerDuty services bound to it";

  function gapDetails(findings: Record<string, unknown>): string[] {
    return (findings["gaps"] as Array<{ detail: string }>).map((g) => g.detail);
  }

  test("a configured [ci.service.*] binding reaches the agent: no 'nothing can match' gap", async () => {
    const cap = capture("changelog");
    await dispatchAgentsRpc(
      "agents.changelog",
      { service: "billing" },
      {
        db: indexDb(),
        notify: cap.notify,
        configDir: configDirWith('[ci.service.billing]\nrepos = ["github:acme/billing"]\n'),
      },
    );
    const { findings } = await cap.ready;
    expect((findings["query"] as { service: unknown }).service).toBe("billing");
    expect(gapDetails(findings).some((d) => d.includes(UNBOUND))).toBe(false);
  });

  test("a malformed block degrades to the unbound-service gap instead of failing the brief", async () => {
    const cap = capture("changelog");
    const { written } = await withStderr(async () => {
      const out = await dispatchAgentsRpc(
        "agents.changelog",
        { service: "checkout" },
        { db: indexDb(), notify: cap.notify, configDir: configDirWith(MALFORMED_SERVICE) },
      );
      expect(out.kind).toBe("hit");
      return out;
    });
    expect(written).toContain(`agents.changelog: ${LOAD_FAILURE}`);
    expect(written).toContain("service scoping will be unavailable until this is fixed.");
    expect(written).not.toContain("agents.oncall:");
    const { findings } = await cap.ready;
    expect(gapDetails(findings).some((d) => d.includes(`\`checkout\` ${UNBOUND}`))).toBe(true);
  });
});

describe("agents.decisions — [decisions] min_confidence is only the DEFAULT floor", () => {
  /** Two extracted decisions, written through the store's own mutators. */
  function seedDecisions(db: Database): void {
    const now = Date.now();
    const rows = [
      { id: "dec-high", confidence: 0.8, decidedAt: now - HOUR_MS },
      { id: "dec-low", confidence: 0.5, decidedAt: now - 2 * HOUR_MS },
    ];
    for (const r of rows) {
      upsertCandidate(db, {
        id: r.id,
        sourceItemId: `slack:${r.id}`,
        cueTier: "explicit",
        cueText: "we decided",
        priority: 1,
        decidedAt: r.decidedAt,
        nowMs: now,
      });
      markExtracted(
        db,
        r.id,
        { statement: r.id, rationale: null, alternatives: [], extractionSource: "snippet" },
        now,
      );
      setConfidence(db, r.id, r.confidence, false, now);
    }
  }

  function entryIds(findings: Record<string, unknown>): string[] {
    return (findings["entries"] as Array<{ id: string }>).map((e) => e.id);
  }

  const FLOOR_TOML = "[decisions]\nmin_confidence = 0.65\n";

  test("with no minConfidence in the request, the configured floor applies", async () => {
    const db = indexDb();
    seedDecisions(db);
    const cap = capture("decisions");
    await dispatchAgentsRpc(
      "agents.decisions",
      {},
      {
        db,
        notify: cap.notify,
        configDir: configDirWith(FLOOR_TOML),
      },
    );
    const { findings } = await cap.ready;
    expect((findings["query"] as { minConfidence: number }).minConfidence).toBe(0.65);
    expect(entryIds(findings)).toEqual(["dec-high"]);
  });

  test("an explicit minConfidence wins over the configured floor, and limit caps the entries", async () => {
    const db = indexDb();
    seedDecisions(db);
    const cap = capture("decisions");
    await dispatchAgentsRpc(
      "agents.decisions",
      { minConfidence: 0.4, limit: 1 },
      {
        db,
        notify: cap.notify,
        configDir: configDirWith(FLOOR_TOML),
      },
    );
    const { findings } = await cap.ready;
    expect((findings["query"] as { minConfidence: number }).minConfidence).toBe(0.4);
    // Both clear 0.4; `limit: 1` keeps the most recently decided one.
    expect(entryIds(findings)).toEqual(["dec-high"]);
  });

  test("null params are the all-defaults request, and every explicit field reaches the query", async () => {
    const db = indexDb();
    seedDecisions(db);
    const defaults = capture("decisions");
    await dispatchAgentsRpc("agents.decisions", null, { db, notify: defaults.notify });
    const d = await defaults.ready;
    expect(d.findings["query"]).toMatchObject({ service: null, minConfidence: 0, explain: false });
    expect(entryIds(d.findings)).toEqual(["dec-high", "dec-low"]);

    const explicit = capture("decisions");
    await dispatchAgentsRpc(
      "agents.decisions",
      { sinceMs: 90 * 60 * 1000, service: "billing", explain: true },
      { db, notify: explicit.notify },
    );
    const e = await explicit.ready;
    const query = e.findings["query"] as { sinceMs: number; service: string; explain: boolean };
    expect(query.service).toBe("billing");
    expect(query.explain).toBe(true);
    // `sinceMs` is a DURATION in the request and an absolute cutoff in the brief.
    expect((e.findings["generatedAt"] as number) - query.sinceMs).toBe(90 * 60 * 1000);
  });
});

describe("[[filesystem.roots]] reach the agents that resolve paths", () => {
  function rootsToml(rootDir: string): string {
    return `[[filesystem.roots]]\npath = "${rootDir}"\n`;
  }

  test("agents.whyPeek resolves a root-relative ref against the configured root, at the line asked", async () => {
    const root = tempDir("nimbus-why-root-");
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const db = indexDb();

    // The control: with no configDir there is no root, so the same ref names nothing.
    const bare = await dispatchAgentsRpc(
      "agents.whyPeek",
      { ref: "a.ts", line: 3 },
      {
        db,
        notify: () => {},
      },
    );
    expect((bare as { kind: "hit"; value: { subject: unknown } }).value.subject).toBeNull();

    const out = await dispatchAgentsRpc(
      "agents.whyPeek",
      { ref: "a.ts", line: 3 },
      {
        db,
        notify: () => {},
        configDir: configDirWith(rootsToml(root)),
      },
    );
    expect(out.kind).toBe("hit");
    const peek = (out as { kind: "hit"; value: { subject: unknown; author: unknown } }).value;
    // `line` came from the request (the ref carries no `:N` suffix); the root has no `.git`, so
    // no blame is spawned and the author stays null.
    expect(peek.subject).toEqual({ repoRoot: resolve(root), filePath: "a.ts", lineNo: 3 });
    expect(peek.author).toBeNull();
  });

  test("agents.ownership counts the configured root, so the no-roots gap is gone", async () => {
    const NO_ROOTS = "There are no git-aware filesystem roots configured";
    const root = tempDir("nimbus-own-root-");

    const without = capture("ownership");
    await dispatchAgentsRpc("agents.ownership", null, { db: indexDb(), notify: without.notify });
    const w = await without.ready;
    const withoutGaps = (w.findings["gaps"] as Array<{ detail: string }>).map((g) => g.detail);
    expect(withoutGaps.some((d) => d.startsWith(NO_ROOTS))).toBe(true);

    const withRoot = capture("ownership");
    await dispatchAgentsRpc("agents.ownership", null, {
      db: indexDb(),
      notify: withRoot.notify,
      configDir: configDirWith(rootsToml(root)),
    });
    const r = await withRoot.ready;
    const withGaps = (r.findings["gaps"] as Array<{ detail: string }>).map((g) => g.detail);
    expect(withGaps.some((d) => d.startsWith(NO_ROOTS))).toBe(false);
  });
});
