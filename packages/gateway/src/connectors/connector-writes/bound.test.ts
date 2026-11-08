// packages/gateway/src/connectors/connector-writes/bound.test.ts
// Phase 9.7 D0b: the `withBound` declaration checks (synthetic rows only), and the pins that no
// production row is bound yet.
import { describe, expect, test } from "bun:test";
import {
  SYNTH_PREPARE_IDS,
  SYNTH_PREPARE_TOOL,
  synthBound,
  synthBoundRow,
} from "./bound-fixtures.test-helpers.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isPrepareToolId } from "./prepare-tools.ts";
import {
  type BoundWrite,
  boundWriteProblems,
  row as makeRow,
  textField,
  withBound,
  withPreview,
} from "./types.ts";

const PREVIEWED = withPreview(makeRow("synth_apply", "iac.terraform.apply", "write", 3), {
  target: "{dir}",
  summary: "Apply {dir} {extra}",
  fields: [textField("dir")],
});

function declare(bound: BoundWrite, ids: ReadonlySet<string> = SYNTH_PREPARE_IDS) {
  return () => withBound(PREVIEWED, bound, ids);
}

describe("withBound", () => {
  test("a well-formed declaration is frozen and carries the bound", () => {
    const r = synthBoundRow();
    expect(Object.isFrozen(r)).toBe(true);
    expect(r.bound?.prepare.tool).toBe(SYNTH_PREPARE_TOOL);
  });

  test("production: no declared prepare tool exists, so nothing can be bound without the seam", () => {
    expect(() => withBound(PREVIEWED, synthBound())).toThrow("not a declared prepare tool");
  });

  test("refuses a row with no typed preview", () => {
    const bare = makeRow("synth_apply", "iac.terraform.apply", "write", 3);
    expect(() => withBound(bare, synthBound(), SYNTH_PREPARE_IDS)).toThrow("needs a typed preview");
  });

  test("refuses a prepare tool outside the declared set", () => {
    expect(declare(synthBound(), new Set(["other_tool"]))).toThrow("not a declared prepare tool");
  });

  test("refuses the write tool itself as its prepare tool", () => {
    const self = synthBound({ tool: "synth_apply" });
    expect(declare(self, new Set(["synth_apply"]))).toThrow("the write tool itself");
  });

  test("refuses prepare argKeys the preview does not name, none, and duplicates", () => {
    expect(declare(synthBound({ argKeys: ["nope"] }))).toThrow("is not a key the preview names");
    expect(declare(synthBound({ argKeys: [] }))).toThrow("at least one argKey");
    expect(declare(synthBound({ argKeys: ["dir", "dir"] }))).toThrow("duplicate argKey");
  });

  test("refuses no bound fields and duplicate bound fields", () => {
    const base = synthBound();
    expect(declare({ ...base, binds: [] })).toThrow("at least one bound field");
    const one = base.binds[0];
    if (one === undefined) throw new Error("fixture");
    expect(declare({ ...base, binds: [one, one] })).toThrow("duplicate bound field");
  });

  test("refuses a bound field the preview names (it would be owner-visible, caller input)", () => {
    const base = synthBound();
    expect(declare({ ...base, binds: [{ field: "dir", from: () => "x" }] })).toThrow(
      "a key the preview names",
    );
    expect(declare({ ...base, binds: [{ field: "extra", from: () => "x" }] })).toThrow(
      "a key the preview names",
    );
  });

  test("refuses an empty bound field and the routing key", () => {
    const base = synthBound();
    expect(declare({ ...base, binds: [{ field: "", from: () => "x" }] })).toThrow("not allowed");
    expect(declare({ ...base, binds: [{ field: "mcpToolId", from: () => "x" }] })).toThrow(
      "not allowed",
    );
  });

  test("refuses a budget or cap that is not a positive integer", () => {
    for (const key of ["budgetMs", "maxInputBytes", "maxReplyBytes"] as const) {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(declare(synthBound({ [key]: bad }))).toThrow(`${key} must be a positive integer`);
      }
    }
  });

  test("boundWriteProblems lists every problem, not just the first", () => {
    const problems = boundWriteProblems(
      PREVIEWED,
      synthBound({ argKeys: [], budgetMs: 0, maxReplyBytes: -4 }),
      new Set(),
    );
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the production table (D0b mechanism, D1c rows)", () => {
  test("the bound production rows are exactly the two multi-file commits", () => {
    expect(
      CONNECTOR_WRITE_ROWS.filter((r) => r.bound !== undefined)
        .map((r) => r.toolId)
        .sort(),
    ).toEqual(["github_file_commit", "gitlab_commit_create"]);
  });

  test("no production row's tool id is a prepare tool (the classes stay apart)", () => {
    for (const r of CONNECTOR_WRITE_ROWS) expect(isPrepareToolId(r.toolId)).toBe(false);
  });
});

describe("settled prepare reads (D2): the settle tag, its tool and its bound field names", () => {
  const two = new Set([SYNTH_PREPARE_TOOL, "synth_show"]);
  const tfBinds = [
    { field: "planFile", from: () => "x" },
    { field: "planSha256", from: () => "x" },
  ];
  const settled = (over: Record<string, unknown>, binds = tfBinds): BoundWrite => ({
    ...synthBound({ settle: "iac-terraform", settleTool: "synth_show", ...over } as never),
    binds,
  });

  test("a terraform settle with its show tool and planFile + planSha256 declares", () => {
    expect(() => withBound(PREVIEWED, settled({}), two)).not.toThrow();
  });

  test("a cfn settle takes no settle tool and binds exactly changeSetId", () => {
    const cfn = {
      ...synthBound({ settle: "iac-cfn" } as never),
      binds: [{ field: "changeSetId", from: () => "x" }],
    } as BoundWrite;
    expect(() => withBound(PREVIEWED, cfn, two)).not.toThrow();
    const withTool = {
      ...synthBound({ settle: "iac-cfn", settleTool: "synth_show" } as never),
      binds: cfn.binds,
    } as BoundWrite;
    expect(() => withBound(PREVIEWED, withTool, two)).toThrow("takes no settle tool");
  });

  test("refuses a terraform settle without a settle tool, and a settle tool without a settle", () => {
    expect(() => withBound(PREVIEWED, settled({ settleTool: undefined }), two)).toThrow(
      "needs a settle tool",
    );
    const orphan = synthBound({ settleTool: "synth_show" } as never);
    expect(() => withBound(PREVIEWED, orphan, two)).toThrow("settle tool without a settle");
  });

  test("refuses a settle tool that is not declared, is the write tool or is the prepare tool", () => {
    expect(() => withBound(PREVIEWED, settled({ settleTool: "nope" }), two)).toThrow(
      "settle tool is not a declared prepare tool",
    );
    expect(() =>
      withBound(
        PREVIEWED,
        settled({ settleTool: "synth_apply" }),
        new Set([...two, "synth_apply"]),
      ),
    ).toThrow("settle tool is the write tool itself");
    expect(() => withBound(PREVIEWED, settled({ settleTool: SYNTH_PREPARE_TOOL }), two)).toThrow(
      "settle tool is the prepare tool itself",
    );
  });

  test("refuses bound field names that are not the settler's value keys", () => {
    expect(() =>
      withBound(PREVIEWED, settled({}, [{ field: "planFile", from: () => "x" }]), two),
    ).toThrow("bound fields must be exactly the settler's values");
    expect(() =>
      withBound(
        PREVIEWED,
        settled({}, [...tfBinds, { field: "extraBound", from: () => "x" }]),
        two,
      ),
    ).toThrow("bound fields must be exactly the settler's values");
  });

  test("a preflight tag is accepted only as iac", () => {
    expect(() =>
      withBound(PREVIEWED, synthBound({ preflight: "iac" } as never), two),
    ).not.toThrow();
    expect(() => withBound(PREVIEWED, synthBound({ preflight: "other" } as never), two)).toThrow(
      "preflight",
    );
  });
});
