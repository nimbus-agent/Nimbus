import { describe, expect, test } from "bun:test";
import { parseEvalReport, parseEvalRoleDocument } from "./eval-role-document.ts";
import { type EvalCaseOutcome, scoreEval } from "./eval-score.ts";

function report(): Record<string, unknown> {
  return {
    scorer: 1,
    score: 50,
    cases: 2,
    passed: 1,
    rubrics: {
      exact: { cases: 2, passed: 1 },
      "json-match": { cases: 0, passed: 0 },
      "one-of": { cases: 0, passed: 0 },
    },
    results: [
      { suite: "evals/a.eval.json", case: "one", rubric: "exact", pass: true, reason: null },
      {
        suite: "evals/a.eval.json",
        case: "two",
        rubric: "exact",
        pass: false,
        reason: "wrong text",
      },
    ],
  };
}

const okDoc = (): Record<string, unknown> => ({
  ok: true,
  extensionId: "acme/tool",
  version: "1.0.0",
  report: report(),
});

describe("parseEvalRoleDocument", () => {
  test("accepts a report built by the real scorer", () => {
    const outcomes: EvalCaseOutcome[] = [
      { suite: "evals/a.eval.json", case: "one", rubric: "exact", pass: true, reason: null },
      { suite: "evals/a.eval.json", case: "two", rubric: "json-match", pass: false, reason: "x" },
      { suite: "evals/b.eval.json", case: "three", rubric: "one-of", pass: true, reason: null },
    ];
    const scored = scoreEval(outcomes);
    expect(scored).not.toBeNull();
    const text = JSON.stringify({
      ok: true,
      extensionId: "acme.x",
      version: "1.0.0",
      report: scored,
    });
    const doc = parseEvalRoleDocument(text);
    expect(doc?.ok).toBe(true);
    if (doc?.ok !== true) return;
    expect(doc.extensionId).toBe("acme.x");
    expect(doc.version).toBe("1.0.0");
    expect(doc.report).toEqual(JSON.parse(JSON.stringify(scored)));
  });

  test("accepts both document shapes", () => {
    expect(parseEvalRoleDocument(JSON.stringify(okDoc()))?.ok).toBe(true);
    expect(parseEvalRoleDocument('{"ok":false,"error":{"code":"a","message":"b"}}')).toEqual({
      ok: false,
      error: { code: "a", message: "b" },
    });
  });

  test("an error document keeps only code and message", () => {
    const doc = parseEvalRoleDocument(
      '{"ok":false,"error":{"code":"a","message":"b","stack":"s"},"extra":1}',
    );
    expect(doc).toEqual({ ok: false, error: { code: "a", message: "b" } });
  });

  test("rejects invalid documents", () => {
    const bad = (mut: (d: Record<string, unknown>) => void): void => {
      const d = okDoc();
      mut(d);
      expect(parseEvalRoleDocument(JSON.stringify(d))).toBeNull();
    };
    expect(parseEvalRoleDocument("not json")).toBeNull();
    expect(parseEvalRoleDocument("[]")).toBeNull();
    expect(parseEvalRoleDocument("null")).toBeNull();
    expect(parseEvalRoleDocument('{"ok":1}')).toBeNull();
    expect(parseEvalRoleDocument('{"ok":false}')).toBeNull();
    expect(parseEvalRoleDocument('{"ok":false,"error":{"code":1,"message":"b"}}')).toBeNull();
    expect(parseEvalRoleDocument('{"ok":false,"error":{"code":"a"}}')).toBeNull();
    bad((d) => {
      d["extensionId"] = 5;
    });
    bad((d) => {
      d["version"] = undefined;
    });
    bad((d) => {
      d["report"] = null;
    });
    bad((d) => {
      (d["report"] as Record<string, unknown>)["results"] = "x";
    });
    bad((d) => {
      (d["report"] as Record<string, unknown>)["results"] = [{ suite: 1 }];
    });
    bad((d) => {
      (d["report"] as Record<string, unknown>)["score"] = 99;
    });
    bad((d) => {
      const rep = d["report"] as { results: unknown[] };
      rep.results = rep.results.slice(1);
    });
    bad((d) => {
      const rep = d["report"] as { results: { pass: boolean }[] };
      for (const r of rep.results) r.pass = true;
    });
  });
});

describe("parseEvalReport", () => {
  test("accepts a consistent report and returns it", () => {
    const r = report();
    expect(parseEvalReport(r)).toEqual(r as never);
  });

  test("rejects a non-object, a reason of the wrong type and a bad quality", () => {
    expect(parseEvalReport(null)).toBeNull();
    expect(parseEvalReport([])).toBeNull();
    const wrongReason = report();
    (wrongReason["results"] as Record<string, unknown>[])[0] = {
      suite: "evals/a.eval.json",
      case: "one",
      rubric: "exact",
      pass: true,
      reason: 3,
    };
    expect(parseEvalReport(wrongReason)).toBeNull();
    const badQuality = report();
    badQuality["scorer"] = 2;
    expect(parseEvalReport(badQuality)).toBeNull();
  });
});
