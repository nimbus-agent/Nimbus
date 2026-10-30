import { describe, expect, test } from "bun:test";
import {
  candidatesOf,
  type InstalledRunDeps,
  parseEvalResults,
  registryScoreOf,
  runEvalInstalled,
} from "./eval-installed.ts";

/** A valid scorer-1 report with `passed` of `cases` exact-rubric cases passing. */
function report(passed: number, cases: number): Record<string, unknown> {
  const results = [];
  for (let i = 0; i < cases; i++) {
    const pass = i < passed;
    results.push({
      suite: "evals/a.eval.json",
      case: `c${i}`,
      rubric: "exact",
      pass,
      reason: pass ? null : "wrong",
    });
  }
  return {
    scorer: 1,
    score: Math.floor((passed * 100) / cases),
    cases,
    passed,
    rubrics: {
      exact: { cases, passed },
      "json-match": { cases: 0, passed: 0 },
      "one-of": { cases: 0, passed: 0 },
    },
    results,
  };
}

function row(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, version: "1.0.0", kind: "extension", enabled: 1, source_registry: null, ...extra };
}

const okEntry = (id: string, version: string, passed: number, cases = 10) => ({
  id,
  version,
  ok: true,
  report: report(passed, cases),
});
const errEntry = (id: string, code: string, message = "msg") => ({
  id,
  version: "1.0.0",
  ok: false,
  error: { code, message },
});

function info(registry: string, versions: unknown[]): Record<string, unknown> {
  return { registry, id: "x", versions };
}
const ver = (version: string, quality: unknown, extra: Record<string, unknown> = {}) => ({
  version,
  quality,
  ...extra,
});

interface Script {
  list?: unknown;
  evalAnswer?: unknown;
  evalFn?: (ids: string[]) => unknown;
  info?: Record<string, unknown>;
}

function harness(script: Script) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const errs: string[] = [];
  const answer = (a: unknown): unknown => {
    if (a instanceof Error) throw a;
    return a;
  };
  const deps: InstalledRunDeps = {
    call: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (method === "extension.list") return answer(script.list) as T;
      if (method === "extension.eval") {
        const ids = params["ids"] as string[];
        const resolved = script.evalFn === undefined ? script.evalAnswer : script.evalFn(ids);
        return answer(resolved) as T;
      }
      if (method === "registry.info") {
        const key = `${String(params["registry"])}/${String(params["id"])}`;
        return answer(script.info?.[key]) as T;
      }
      throw new Error(`unexpected ${method}`);
    },
    log: (s) => logs.push(s),
    err: (s) => errs.push(s),
  };
  return { deps, calls, logs, errs, methods: () => calls.map((c) => c.method) };
}

const listOf = (...rows: unknown[]) => ({ extensions: rows, runtimeEnabled: true });

/** The text table's data rows, split on runs of 2+ spaces. */
function tableRows(logs: string[]): string[][] {
  return logs.slice(1, -1).map((l) => l.split(/ {2,}/));
}

describe("candidatesOf", () => {
  test("keeps enabled extensions; drops disabled and starter packs; absent kind is an extension", () => {
    const errs: string[] = [];
    const out = candidatesOf(
      listOf(
        row("a/one", { source_registry: "official" }),
        row("a/off", { enabled: 0 }),
        row("a/pack", { kind: "starter-pack" }),
        { id: "a/old", version: "2.0.0", enabled: 1 },
      ),
      (s) => errs.push(s),
    );
    expect(out).toEqual([
      { id: "a/one", version: "1.0.0", source_registry: "official" },
      { id: "a/old", version: "2.0.0", source_registry: null },
    ]);
    expect(errs).toEqual([]);
  });

  test("a malformed row is skipped with a stderr note, never trusted", () => {
    const errs: string[] = [];
    const out = candidatesOf(
      listOf(
        "nope",
        null,
        { id: 3, version: "1", enabled: 1 },
        { id: "a/x", enabled: 1 },
        { id: "a/y", version: "1", enabled: "1" },
        { id: "a/z", version: "1", enabled: 1, kind: 7 },
        { id: "a/w", version: "1", enabled: 1, source_registry: 9 },
        { id: "  ", version: "1", enabled: 1 },
        row("a/good"),
      ),
      (s) => errs.push(s),
    );
    expect(out).toEqual([{ id: "a/good", version: "1.0.0", source_registry: null }]);
    expect(errs.length).toBe(8);
  });

  test("empty or whitespace source_registry is a local install", () => {
    const out = candidatesOf(
      listOf(row("a/e", { source_registry: "" }), row("a/w", { source_registry: "  \t" })),
      () => {},
    );
    expect(out?.map((c) => c.source_registry)).toEqual([null, null]);
  });

  test.each([["nope"], [null], [{}], [{ extensions: "x" }], [[]]])(
    "a malformed top-level answer is null (%p)",
    (raw) => {
      expect(candidatesOf(raw, () => {})).toBeNull();
    },
  );
});

describe("parseEvalResults", () => {
  test("one entry per requested id in order", () => {
    const raw = { results: [okEntry("a", "1", 5), errEntry("b", "ERR_EVAL_NO_SUITES")] };
    const out = parseEvalResults(raw, ["a", "b"]);
    expect(out?.map((e) => e.id)).toEqual(["a", "b"]);
  });

  test.each([
    ["short", { results: [okEntry("a", "1", 5)] }],
    ["reordered", { results: [errEntry("b", "E"), okEntry("a", "1", 5)] }],
    ["foreign id", { results: [okEntry("a", "1", 5), errEntry("c", "E")] }],
    [
      "bad report",
      {
        results: [
          { ...okEntry("a", "1", 5), report: { ...report(5, 10), score: 99 } },
          errEntry("b", "E"),
        ],
      },
    ],
    ["not an object", 7],
  ])("rejects %s", (_n, raw) => {
    expect(parseEvalResults(raw, ["a", "b"])).toBeNull();
  });
});

describe("registryScoreOf", () => {
  test("the evaluated version's valid score", () => {
    expect(registryScoreOf(info("r", [ver("1.0.0", { score: 80 })]), "1.0.0")).toEqual({
      score: 80,
    });
  });

  test.each([
    ["version absent", info("r", [ver("2.0.0", { score: 90 })]), "version not in the registry"],
    ["quality null", info("r", [ver("1.0.0", null)]), "not evaluated"],
    ["quality absent", info("r", [{ version: "1.0.0" }]), "not evaluated"],
    [
      "qualityInvalid",
      info("r", [ver("1.0.0", { score: 80 }, { qualityInvalid: "bad sig" })]),
      "invalid score",
    ],
    ["score string", info("r", [ver("1.0.0", { score: "87" })]), "invalid score"],
    ["score 101", info("r", [ver("1.0.0", { score: 101 })]), "invalid score"],
    ["score 1.5", info("r", [ver("1.0.0", { score: 1.5 })]), "invalid score"],
    ["no versions", { registry: "r" }, "invalid score"],
    ["not an object", "x", "invalid score"],
  ])("%s", (_n, raw, note) => {
    expect(registryScoreOf(raw, "1.0.0")).toEqual({ note });
  });
});

describe("runEvalInstalled", () => {
  test("no candidates: prints a note, exit 0, only extension.list called", async () => {
    const h = harness({ list: listOf(row("a/off", { enabled: 0 })) });
    expect(await runEvalInstalled({ threshold: 5, json: false }, h.deps)).toBe(0);
    expect(h.methods()).toEqual(["extension.list"]);
    expect(h.logs).toEqual(["no installed extension to evaluate"]);
  });

  test("no candidates with --json prints {threshold, results: []}", async () => {
    const h = harness({ list: listOf() });
    expect(await runEvalInstalled({ threshold: 7, json: true }, h.deps)).toBe(0);
    expect(JSON.parse(h.logs[0] ?? "")).toEqual({ threshold: 7, results: [] });
    expect(h.logs.length).toBe(1);
  });

  test("51 candidates: ERR_EVAL_TOO_MANY_EXTENSIONS, exit 2, no extension.eval", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => row(`a/e${i}`));
    const h = harness({ list: listOf(...rows) });
    expect(await runEvalInstalled({ threshold: 5, json: false }, h.deps)).toBe(2);
    expect(h.methods()).toEqual(["extension.list"]);
    const err = h.errs.join("\n");
    expect(err).toContain("ERR_EVAL_TOO_MANY_EXTENSIONS");
    expect(err).toContain("51");
    expect(err).toContain("--extension <id>");
    const j = harness({ list: listOf(...rows) });
    expect(await runEvalInstalled({ threshold: 5, json: true }, j.deps)).toBe(2);
    const doc = JSON.parse(j.logs[0] ?? "");
    expect(doc.ok).toBe(false);
    expect(doc.error.code).toBe("ERR_EVAL_TOO_MANY_EXTENSIONS");
    expect(doc.error.message).toContain("51");
  });

  test("50 candidates are evaluated in one call", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`a/e${i}`));
    const h = harness({
      list: listOf(...rows),
      evalFn: (ids) => ({ results: ids.map((id) => errEntry(id, "ERR_EVAL_NO_SUITES")) }),
    });
    expect(await runEvalInstalled({ threshold: 5, json: false }, h.deps)).toBe(0);
    expect(h.methods()).toEqual(["extension.list", "extension.eval"]);
  });

  test("a malformed extension.list answer: ERR_EVAL_BAD_RESPONSE, exit 2, no extension.eval", async () => {
    const h = harness({ list: { nope: true } });
    expect(await runEvalInstalled({ threshold: 5, json: false }, h.deps)).toBe(2);
    expect(h.methods()).toEqual(["extension.list"]);
    expect(h.errs.join("\n")).toContain("ERR_EVAL_BAD_RESPONSE");
    const j = harness({ list: null });
    expect(await runEvalInstalled({ threshold: 5, json: true }, j.deps)).toBe(2);
    expect(JSON.parse(j.logs[0] ?? "").error.code).toBe("ERR_EVAL_BAD_RESPONSE");
  });

  test("extension.list throwing is ERR_EVAL_IPC", async () => {
    const h = harness({ list: new Error("socket closed") });
    expect(await runEvalInstalled({ threshold: 5, json: true }, h.deps)).toBe(2);
    expect(JSON.parse(h.logs[0] ?? "")).toEqual({
      ok: false,
      error: { code: "ERR_EVAL_IPC", message: "socket closed" },
    });
  });

  function happy() {
    return harness({
      list: listOf(
        row("a/same", { source_registry: "official" }),
        row("a/worse", { source_registry: "community" }),
        row("a/local"),
        row("a/nosuite"),
      ),
      evalAnswer: {
        results: [
          okEntry("a/same", "1.0.0", 8),
          okEntry("a/worse", "2.0.0", 7),
          okEntry("a/local", "1.0.0", 9),
          errEntry("a/nosuite", "ERR_EVAL_NO_SUITES", "no evals/ directory"),
        ],
      },
      info: {
        "official/a/same": info("official", [ver("1.0.0", { score: 80, cases: 10, passed: 8 })]),
        "community/a/worse": info("community", [ver("2.0.0", { score: 80, cases: 10, passed: 8 })]),
      },
    });
  }

  test("happy path: one approval, registry reads after it, regression exits 1", async () => {
    const h = happy();
    expect(await runEvalInstalled({ threshold: 5, json: false }, h.deps)).toBe(1);
    expect(h.calls).toEqual([
      { method: "extension.list", params: {} },
      {
        method: "extension.eval",
        params: { ids: ["a/same", "a/worse", "a/local", "a/nosuite"] },
      },
      { method: "registry.info", params: { id: "a/same", registry: "official" } },
      { method: "registry.info", params: { id: "a/worse", registry: "community" } },
    ]);
    expect(h.logs[0]?.split(/\s+/)).toEqual([
      "id",
      "version",
      "local",
      "registry",
      "delta",
      "status",
    ]);
    const rows = tableRows(h.logs);
    expect(rows[0]).toEqual(["a/same", "1.0.0", "80", "80 (official)", "0", "ok"]);
    expect(rows[1]).toEqual(["a/worse", "2.0.0", "70", "80 (community)", "-10", "REGRESSION"]);
    expect(rows[2]).toEqual([
      "a/local",
      "1.0.0",
      "90",
      "—",
      "—",
      "no registry score: local install",
    ]);
    expect(rows[3]).toEqual(["a/nosuite", "1.0.0", "—", "—", "—", "no eval suites"]);
    expect(h.logs.at(-1)).toBe("threshold 5: 1 regression(s)");
    expect(h.errs).toEqual([]);
  });

  test("happy path --json: exactly one document of the documented shape", async () => {
    const h = happy();
    expect(await runEvalInstalled({ threshold: 5, json: true }, h.deps)).toBe(1);
    expect(h.logs.length).toBe(1);
    expect(JSON.parse(h.logs[0] ?? "")).toEqual({
      threshold: 5,
      results: [
        {
          id: "a/same",
          version: "1.0.0",
          local: 80,
          registry: { name: "official", score: 80 },
          delta: 0,
          status: "ok",
        },
        {
          id: "a/worse",
          version: "2.0.0",
          local: 70,
          registry: { name: "community", score: 80 },
          delta: -10,
          status: "regression",
        },
        {
          id: "a/local",
          version: "1.0.0",
          local: 90,
          registry: null,
          registryNote: "local install",
          delta: null,
          status: "no-registry-score",
        },
        {
          id: "a/nosuite",
          version: "1.0.0",
          local: null,
          registry: null,
          registryNote: "local install",
          delta: null,
          status: "no-suites",
        },
      ],
    });
  });

  function oneRegistry(local: number, registry: unknown, threshold: number, qExtra = {}) {
    const h = harness({
      list: listOf(row("a/x", { source_registry: "r" })),
      evalAnswer: { results: [okEntry("a/x", "1.0.0", local, 100)] },
      info: { "r/a/x": info("r", [ver("1.0.0", registry, qExtra)]) },
    });
    return { h, run: () => runEvalInstalled({ threshold, json: true }, h.deps) };
  }

  test("threshold boundary: registry - local == threshold is ok; threshold+1 regresses", async () => {
    const at = oneRegistry(75, { score: 80 }, 5);
    expect(await at.run()).toBe(0);
    expect(JSON.parse(at.h.logs[0] ?? "").results[0].status).toBe("ok");
    const over = oneRegistry(74, { score: 80 }, 5);
    expect(await over.run()).toBe(1);
    expect(JSON.parse(over.h.logs[0] ?? "").results[0]).toMatchObject({
      status: "regression",
      delta: -6,
    });
  });

  test("--threshold 0: any drop regresses, equal is ok", async () => {
    const drop = oneRegistry(79, { score: 80 }, 0);
    expect(await drop.run()).toBe(1);
    const equal = oneRegistry(80, { score: 80 }, 0);
    expect(await equal.run()).toBe(0);
  });

  test("--threshold 100: never a regression", async () => {
    const r = oneRegistry(0, { score: 100 }, 100);
    expect(await r.run()).toBe(0);
  });

  test("local above registry is +N and ok", async () => {
    const h = harness({
      list: listOf(row("a/x", { source_registry: "r" })),
      evalAnswer: { results: [okEntry("a/x", "1.0.0", 9)] },
      info: { "r/a/x": info("r", [ver("1.0.0", { score: 80 })]) },
    });
    expect(await runEvalInstalled({ threshold: 5, json: false }, h.deps)).toBe(0);
    expect(tableRows(h.logs)[0]).toEqual(["a/x", "1.0.0", "90", "80 (r)", "+10", "ok"]);
  });

  test("version mismatch never borrows another version's score", async () => {
    const newerOnly = harness({
      list: listOf(row("a/x", { source_registry: "r" })),
      evalAnswer: { results: [okEntry("a/x", "1.0.0", 1)] },
      info: { "r/a/x": info("r", [ver("2.0.0", { score: 100 })]) },
    });
    expect(await runEvalInstalled({ threshold: 5, json: true }, newerOnly.deps)).toBe(0);
    expect(JSON.parse(newerOnly.logs[0] ?? "").results[0]).toMatchObject({
      registry: null,
      registryNote: "version not in the registry",
      status: "no-registry-score",
    });
    const unscored = harness({
      list: listOf(row("a/x", { source_registry: "r" })),
      evalAnswer: { results: [okEntry("a/x", "1.0.0", 1)] },
      info: { "r/a/x": info("r", [ver("2.0.0", { score: 100 }), ver("1.0.0", null)]) },
    });
    expect(await runEvalInstalled({ threshold: 5, json: true }, unscored.deps)).toBe(0);
    expect(JSON.parse(unscored.logs[0] ?? "").results[0].registryNote).toBe("not evaluated");
  });

  test.each([
    ["quality null", null, {}, "not evaluated"],
    ["qualityInvalid", { score: 80 }, { qualityInvalid: "signature" }, "invalid score"],
    ["string score", { score: "87" }, {}, "invalid score"],
  ])("%s gives no registry score, exit unaffected", async (_n, quality, extra, note) => {
    const r = oneRegistry(10, quality, 5, extra);
    expect(await r.run()).toBe(0);
    expect(JSON.parse(r.h.logs[0] ?? "").results[0]).toMatchObject({
      registry: null,
      registryNote: note,
      delta: null,
      status: "no-registry-score",
    });
  });

  test("a registry.info answer naming another registry is an invalid score", async () => {
    const h = harness({
      list: listOf(row("a/x", { source_registry: "r" })),
      evalAnswer: { results: [okEntry("a/x", "1.0.0", 1)] },
      info: { "r/a/x": info("other", [ver("1.0.0", { score: 100 })]) },
    });
    expect(await runEvalInstalled({ threshold: 5, json: true }, h.deps)).toBe(0);
    expect(JSON.parse(h.logs[0] ?? "").results[0].registryNote).toBe("invalid score");
  });

  test("registry.info throwing is `registry unreadable`, exit unaffected, one table row", async () => {
    const h = harness({
      list: listOf(row("a/x", { source_registry: "r" })),
      evalAnswer: { results: [okEntry("a/x", "1.0.0", 1)] },
      info: { "r/a/x": new Error("ERR_REGISTRY_FETCH: line one\nline two") },
    });
    expect(await runEvalInstalled({ threshold: 5, json: false }, h.deps)).toBe(0);
    expect(h.logs.length).toBe(3);
    const status = tableRows(h.logs)[0]?.at(-1);
    expect(status).toBe(
      "no registry score: registry unreadable: ERR_REGISTRY_FETCH: line one line two",
    );
    const j = harness({
      list: listOf(row("a/x", { source_registry: "r" })),
      evalAnswer: { results: [okEntry("a/x", "1.0.0", 1)] },
      info: { "r/a/x": new Error("ERR_REGISTRY_FETCH: down") },
    });
    expect(await runEvalInstalled({ threshold: 5, json: true }, j.deps)).toBe(0);
    expect(JSON.parse(j.logs[0] ?? "").results[0].registryNote).toBe(
      "registry unreadable: ERR_REGISTRY_FETCH: down",
    );
  });

  test("an error entry exits 2 even when another regressed; its message follows the table on stderr", async () => {
    const h = harness({
      list: listOf(row("a/worse", { source_registry: "r" }), row("a/broken")),
      evalAnswer: {
        results: [
          okEntry("a/worse", "1.0.0", 1),
          errEntry("a/broken", "ERR_EVAL_SANDBOX_UNAVAILABLE", "no sandbox here"),
        ],
      },
      info: { "r/a/worse": info("r", [ver("1.0.0", { score: 90 })]) },
    });
    expect(await runEvalInstalled({ threshold: 5, json: false }, h.deps)).toBe(2);
    expect(tableRows(h.logs)[1]).toEqual([
      "a/broken",
      "1.0.0",
      "—",
      "—",
      "—",
      "error ERR_EVAL_SANDBOX_UNAVAILABLE",
    ]);
    expect(h.logs.join("\n")).not.toContain("no sandbox here");
    expect(h.errs).toEqual(["a/broken: ERR_EVAL_SANDBOX_UNAVAILABLE: no sandbox here"]);
    const j = harness({
      list: listOf(row("a/broken")),
      evalAnswer: {
        results: [{ id: "a/broken", version: null, ok: false, error: { code: "E", message: "m" } }],
      },
    });
    expect(await runEvalInstalled({ threshold: 5, json: true }, j.deps)).toBe(2);
    expect(JSON.parse(j.logs[0] ?? "").results[0]).toEqual({
      id: "a/broken",
      version: null,
      local: null,
      registry: null,
      registryNote: "local install",
      delta: null,
      status: "error",
      error: { code: "E", message: "m" },
    });
  });

  test("denied: exit 2, no registry.info, no table; --json prints the failure document", async () => {
    const denial = new Error("ERR_EXTENSION_EVAL_NOT_APPROVED: the owner declined");
    const h = harness({ list: listOf(row("a/x", { source_registry: "r" })), evalAnswer: denial });
    expect(await runEvalInstalled({ threshold: 5, json: false }, h.deps)).toBe(2);
    expect(h.methods()).toEqual(["extension.list", "extension.eval"]);
    expect(h.logs).toEqual([]);
    expect(h.errs.join("\n")).toContain("ERR_EXTENSION_EVAL_NOT_APPROVED");
    const j = harness({ list: listOf(row("a/x", { source_registry: "r" })), evalAnswer: denial });
    expect(await runEvalInstalled({ threshold: 5, json: true }, j.deps)).toBe(2);
    expect(JSON.parse(j.logs[0] ?? "")).toEqual({
      ok: false,
      error: {
        code: "ERR_EXTENSION_EVAL_NOT_APPROVED",
        message: "ERR_EXTENSION_EVAL_NOT_APPROVED: the owner declined",
      },
    });
  });

  test("an extension.eval IPC error is ERR_EVAL_IPC", async () => {
    const h = harness({ list: listOf(row("a/x")), evalAnswer: new Error("timeout") });
    expect(await runEvalInstalled({ threshold: 5, json: true }, h.deps)).toBe(2);
    expect(JSON.parse(h.logs[0] ?? "").error.code).toBe("ERR_EVAL_IPC");
  });

  test.each([
    ["short", { results: [] }],
    ["foreign id", { results: [okEntry("a/other", "1.0.0", 1)] }],
    ["bad report", { results: [{ ...okEntry("a/x", "1.0.0", 1), report: { score: 1 } }] }],
  ])("bad answer (%s): ERR_EVAL_BAD_RESPONSE, no registry.info", async (_n, raw) => {
    const h = harness({ list: listOf(row("a/x", { source_registry: "r" })), evalAnswer: raw });
    expect(await runEvalInstalled({ threshold: 5, json: true }, h.deps)).toBe(2);
    expect(h.methods()).toEqual(["extension.list", "extension.eval"]);
    expect(JSON.parse(h.logs[0] ?? "").error.code).toBe("ERR_EVAL_BAD_RESPONSE");
  });

  test("control characters are stripped in text output; JSON keeps strings verbatim", async () => {
    const evil = "\u001b[2K\u009b2J";
    const id = `a/x${evil}`;
    const reg = `r${evil}`;
    const script = (): Script => ({
      list: listOf(row(id, { source_registry: reg }), row("a/b")),
      evalAnswer: {
        results: [
          okEntry(id, `1.0.0${evil}`, 1),
          errEntry("a/b", `ERR_X${evil}`, `bad\n${evil}thing`),
        ],
      },
      info: { [`${reg}/${id}`]: info(reg, [ver(`1.0.0${evil}`, { score: 10 })]) },
    });
    const h = harness(script());
    expect(await runEvalInstalled({ threshold: 5, json: false }, h.deps)).toBe(2);
    const all = [...h.logs, ...h.errs].join("\n");
    expect(all).not.toContain("\u001b");
    expect(all).not.toContain("\u009b");
    expect(all).toContain("a/x[2K2J");
    expect(all).toContain("10 (r[2K2J)");
    expect(h.errs).toEqual(["a/b: ERR_X[2K2J: bad [2K2Jthing"]);
    const j = harness(script());
    expect(await runEvalInstalled({ threshold: 5, json: true }, j.deps)).toBe(2);
    const doc = JSON.parse(j.logs[0] ?? "");
    expect(doc.results[0].id).toBe(id);
    expect(doc.results[0].registry.name).toBe(reg);
  });

  test("a very long gateway string is capped at 120 characters in its table cell", async () => {
    const long = `a/${"x".repeat(300)}`;
    const h = harness({
      list: listOf(row(long)),
      evalAnswer: { results: [errEntry(long, "ERR_EVAL_NO_SUITES")] },
    });
    expect(await runEvalInstalled({ threshold: 5, json: false }, h.deps)).toBe(0);
    expect(tableRows(h.logs)[0]?.[0]?.length).toBe(120);
  });
});
