// packages/gateway/src/connectors/connector-writes/commit-bound.test.ts
// Phase 9.7 D1c: the two multi-file commit rows, bound to the branch head their prepare tool read.
// The reply fixtures follow the shape the INSTALLED connectors' prepare handlers build (pinned
// against their source below), as bare objects and as the MCP-wrapped text the mesh returns.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { boundInputRefusal, PREPARE_REFUSALS, runPrepareStep } from "../../engine/prepare-step.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type { PlannedAction } from "../../engine/types.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import {
  declaredInputKeys,
  withSchemaArgumentDeclarations,
} from "../testing/connector-schema-source.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";
import { commitHeadFrom } from "./commit-bound.ts";
import { COMMIT_INPUT_REFUSALS, COMMIT_LIMITS } from "./commit-limits.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import { PREPARE_TOOL_IDS } from "./prepare-tools.ts";
import { buildConnectorWritePreviewFrom, renderConnectorWritePreviewLines } from "./preview.ts";
import { previewTemplateKeys } from "./types.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const GH_ROW = row("github_file_commit");
const GL_ROW = row("gitlab_commit_create");

function row(toolId: string) {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
}

const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const GH_INPUT = {
  owner: "acme",
  repo: "api",
  branch: "feat/x",
  message: "Fix the thing",
  files: [
    { path: "src/a.ts", content: "export const a = 2;\n" },
    { path: "docs/new.md", content: "# New\n" },
  ],
};
const GL_INPUT = {
  projectPath: "grp/app",
  branch: "feat/x",
  message: "Fix the thing",
  files: GH_INPUT.files,
};

/** The reply `github_commit_prepare` builds (installed source, `tools.ts`). */
const GH_REPLY = {
  headSha: HEAD,
  files: [
    {
      path: "src/a.ts",
      exists: true,
      mode: "100644",
      oldSha: "b".repeat(40),
      oldContent: "export const a = 1;\n",
    },
    { path: "docs/new.md", exists: false, mode: "100644" },
  ],
};
/** The reply `gitlab_commit_prepare` builds. */
const GL_REPLY = {
  headSha: HEAD,
  files: [
    {
      path: "src/a.ts",
      exists: true,
      lastCommitId: "c".repeat(40),
      executable: false,
      oldContent: "export const a = 1;\n",
    },
    { path: "docs/new.md", exists: false },
  ],
};

const sources = readConnectorPackageSources(installedConnectorsPackageRoot());
const scan = scanWriteToolRegistrations(sources);

function declaredKeys(toolId: string): string[] {
  const reg = scan.registrations.find((r) => r.id === toolId);
  if (reg === undefined) throw new Error(`${toolId}: not a registered write`);
  const code = stripComments(sources.find((s) => s.rel === reg.file)?.text ?? "");
  const call = code.slice(reg.span[0], reg.span[1] + 1);
  return declaredInputKeys(withSchemaArgumentDeclarations(sources, code, call)).sort();
}

describe("the rows: shape, keys and offerability", () => {
  test("the template keys are the write tool's input keys minus expectedHeadSha (spelled out AND read from the installed source)", () => {
    const gh = ["branch", "files", "message", "owner", "repo"];
    const gl = ["branch", "files", "message", "projectPath"];
    expect([...previewTemplateKeys(GH_ROW.preview as never)].sort()).toEqual(gh);
    expect([...previewTemplateKeys(GL_ROW.preview as never)].sort()).toEqual(gl);
    expect(declaredKeys("github_file_commit")).toEqual([...gh, "expectedHeadSha"].sort());
    expect(declaredKeys("gitlab_commit_create")).toEqual([...gl, "expectedHeadSha"].sort());
  });

  test("expectedHeadSha is REQUIRED by both write schemas, so a call without it cannot succeed", () => {
    const root = installedConnectorsPackageRoot();
    for (const [rel, id] of [
      [join("connectors", "github", "src", "tools.ts"), "github_file_commit"],
      [join("connectors", "gitlab", "src", "tools.ts"), "gitlab_commit_create"],
    ] as const) {
      const text = readFileSync(join(root, rel), "utf8");
      const at = text.indexOf(`registerWriteTool(\n    "${id}"`);
      expect(at, id).toBeGreaterThan(0);
      const body = text.slice(at, at + 6000);
      expect(body, id).toContain("expectedHeadSha: fullShaSchema,");
      expect(body, id).not.toContain("expectedHeadSha: fullShaSchema.optional()");
    }
  });

  test("both are bound, offerable, confirm on the target and are bound to expectedHeadSha only", () => {
    for (const r of [GH_ROW, GL_ROW]) {
      expect(isModelOfferableRow(r), r.toolId).toBe(true);
      expect(
        r.bound?.binds.map((b) => b.field),
        r.toolId,
      ).toEqual(["expectedHeadSha"]);
      expect(previewTemplateKeys(r.preview as never).has("expectedHeadSha"), r.toolId).toBe(false);
      expect(r.bound?.prepare.tool && PREPARE_TOOL_IDS.has(r.bound.prepare.tool), r.toolId).toBe(
        true,
      );
      expect(r.before, r.toolId).toBeUndefined();
      expect(r.preview?.fields.filter((f) => f.kind === "diff").map((f) => f.key)).toEqual([
        "files",
      ]);
    }
    expect(GH_ROW.bound?.prepare.tool).toBe("github_commit_prepare");
    expect(GL_ROW.bound?.prepare.tool).toBe("gitlab_commit_prepare");
    expect(GH_ROW.confirm?.template).toBe("commit {owner}/{repo}@{branch}");
    expect(GL_ROW.confirm?.template).toBe("commit {projectPath}@{branch}");
  });

  test("every prepare argKey is a key the write input has, and the limits come from one table", () => {
    for (const r of [GH_ROW, GL_ROW]) {
      const p = r.bound?.prepare;
      expect(p?.budgetMs).toBe(COMMIT_LIMITS.budgetMs);
      expect(p?.maxInputBytes).toBe(COMMIT_LIMITS.maxInputChars);
      expect(p?.maxReplyBytes).toBe(COMMIT_LIMITS.maxReplyChars);
      expect(p?.diff?.maxOldBytes).toBe(COMMIT_LIMITS.maxOldContentBytes);
      expect(p?.diff?.maxDiffBytes).toBe(COMMIT_LIMITS.maxDiffBytes);
      expect(p?.inputRefusal).toBeFunction();
    }
  });
});

describe("the installed connectors still reply the way the rows read them", () => {
  const read = (...rel: string[]): string =>
    stripComments(readFileSync(join(installedConnectorsPackageRoot(), ...rel), "utf8"));
  const gh = read("connectors", "github", "src", "tools.ts");
  const gl = read("connectors", "gitlab", "src", "tools.ts");

  test("GitHub prepare: headSha and files with path, exists, mode, oldSha, oldContent", () => {
    expect(gh).toContain('if (!f.exists) return { path: f.path, exists: false, mode: "100644" };');
    expect(gh).toContain(
      "return { path: f.path, exists: true, mode: f.mode, oldSha: f.sha, oldContent: f.content };",
    );
    expect(gh).toContain("return jsonResult({ headSha: head, files });");
  });

  test("GitLab prepare: headSha and files with path, exists, lastCommitId, executable, oldContent", () => {
    expect(gl).toContain("if (!f.exists) return { path: f.path, exists: false };");
    for (const part of [
      "exists: true,",
      "lastCommitId: f.lastCommitId,",
      "executable: f.executable,",
      "oldContent: f.content,",
    ]) {
      expect(gl).toContain(part);
    }
    expect(gl).toContain("return jsonResult({ headSha: head, files });");
  });
});

describe("commitHeadFrom: the bound value", () => {
  test("a 40-hex head in any case is accepted and lower-cased, bare or MCP-wrapped", () => {
    expect(commitHeadFrom({ headSha: HEAD })).toBe(HEAD);
    expect(commitHeadFrom({ headSha: HEAD.toUpperCase() })).toBe(HEAD);
    expect(commitHeadFrom(mcp({ headSha: HEAD.toUpperCase() }))).toBe(HEAD);
  });

  test("39, 41, non-hex, empty, missing, numeric and nested heads are not a head", () => {
    for (const bad of [
      HEAD.slice(1),
      `${HEAD}0`,
      `${HEAD.slice(0, 39)}g`,
      "",
      ` ${HEAD}`,
      `${HEAD}\n`,
      12345,
      null,
      { sha: HEAD },
    ]) {
      expect(commitHeadFrom({ headSha: bad }), JSON.stringify(bad)).toBeUndefined();
    }
    expect(commitHeadFrom({})).toBeUndefined();
    expect(commitHeadFrom(undefined)).toBeUndefined();
    expect(commitHeadFrom("not json")).toBeUndefined();
    expect(commitHeadFrom({ content: [{ type: "text", text: "not json" }] })).toBeUndefined();
    expect(commitHeadFrom({ files: { headSha: HEAD } })).toBeUndefined();
  });

  test("both rows bind it through that function", () => {
    for (const b of [GH_ROW.bound, GL_ROW.bound]) {
      expect(b?.binds[0]?.from(GH_REPLY)).toBe(HEAD);
      expect(b?.binds[0]?.from({ headSha: "nope" })).toBeUndefined();
    }
  });
});

describe("prepare args: the write's own keys, files rebuilt as bare pairs", () => {
  test("GitHub sends owner, repo, branch and path/content pairs only", () => {
    const args = GH_ROW.bound?.prepare.args({
      ...GH_INPUT,
      files: [{ path: "a", content: "x", sneaky: 1 }],
    } as never);
    expect(args).toEqual({
      owner: "acme",
      repo: "api",
      branch: "feat/x",
      files: [{ path: "a", content: "x" }],
    });
  });

  test("GitLab sends projectPath, branch and the pairs", () => {
    expect(GL_ROW.bound?.prepare.args(GL_INPUT)).toEqual({
      projectPath: "grp/app",
      branch: "feat/x",
      files: GL_INPUT.files,
    });
  });

  test("an input that cannot name a target is undefined", () => {
    for (const bad of [
      { ...GH_INPUT, owner: "" },
      { ...GH_INPUT, repo: 5 },
      { ...GH_INPUT, files: "x" },
      { ...GH_INPUT, files: [{ path: "a" }] },
      { ...GH_INPUT, files: [null] },
    ]) {
      expect(GH_ROW.bound?.prepare.args(bad as never)).toBeUndefined();
    }
    expect(
      GL_ROW.bound?.prepare.args({ ...GL_INPUT, projectPath: undefined } as never),
    ).toBeUndefined();
  });
});

describe("diff.files: each input file is paired with exactly one reply entry", () => {
  const pairGh = (reply: unknown, input: unknown = GH_INPUT) =>
    GH_ROW.bound?.prepare.diff?.files(input as never, reply);
  const pairGl = (reply: unknown) => GL_ROW.bound?.prepare.diff?.files(GL_INPUT as never, reply);

  test("GitHub: old text from the reply, new text from the caller, mode from the reply", () => {
    expect(pairGh(GH_REPLY)).toEqual([
      {
        path: "src/a.ts",
        oldContent: "export const a = 1;\n",
        newContent: "export const a = 2;\n",
        mode: "100644",
      },
      { path: "docs/new.md", oldContent: undefined, newContent: "# New\n", mode: "100644" },
    ]);
    expect(pairGh(mcp(GH_REPLY))).toEqual(pairGh(GH_REPLY));
  });

  test("GitLab: executable or regular from the reply; a new file is regular", () => {
    const got = pairGl(GL_REPLY);
    expect(got?.map((f) => f.mode)).toEqual(["regular", "regular"]);
    const exec = {
      ...GL_REPLY,
      files: [{ ...GL_REPLY.files[0], executable: true }, GL_REPLY.files[1]],
    };
    expect(pairGl(exec)?.[0]?.mode).toBe("executable");
  });

  test("the order follows the input, not the reply", () => {
    const swapped = { ...GH_REPLY, files: [...GH_REPLY.files].reverse() };
    expect(pairGh(swapped)?.map((f) => f.path)).toEqual(["src/a.ts", "docs/new.md"]);
  });

  test("a missing, extra, duplicate or foreign entry refuses (undefined)", () => {
    const [a, b] = GH_REPLY.files;
    for (const files of [
      [a],
      [a, b, { path: "extra", exists: false, mode: "100644" }],
      [a, a],
      [a, { ...b, path: "other.md" }],
      [],
    ]) {
      expect(pairGh({ ...GH_REPLY, files }), JSON.stringify(files)).toBeUndefined();
    }
    expect(pairGh({ headSha: HEAD })).toBeUndefined();
    expect(pairGh("nope")).toBeUndefined();
  });

  test("an existing file with no old text, or a new file WITH some, refuses", () => {
    const [a, b] = GH_REPLY.files;
    const { oldContent: _drop, ...noOld } = a as { oldContent: string };
    expect(pairGh({ ...GH_REPLY, files: [noOld, b] })).toBeUndefined();
    expect(pairGh({ ...GH_REPLY, files: [a, { ...b, oldContent: "ghost" }] })).toBeUndefined();
    // A number is not text.
    expect(pairGh({ ...GH_REPLY, files: [{ ...a, oldContent: 5 }, b] })).toBeUndefined();
    // An existing EMPTY file is text.
    expect(pairGh({ ...GH_REPLY, files: [{ ...a, oldContent: "" }, b] })?.[0]?.oldContent).toBe("");
  });

  test("a mode the row cannot label refuses", () => {
    const [a, b] = GH_REPLY.files;
    expect(pairGh({ ...GH_REPLY, files: [{ ...a, mode: "rw-r--r--" }, b] })).toBeUndefined();
    expect(pairGh({ ...GH_REPLY, files: [{ ...a, mode: undefined }, b] })).toBeUndefined();
    const [ga, gb] = GL_REPLY.files;
    const { executable: _x, ...noExec } = ga as { executable: boolean };
    expect(pairGl({ ...GL_REPLY, files: [noExec, gb] })).toBeUndefined();
  });

  test("the input is not trusted either: a malformed files value refuses", () => {
    expect(pairGh(GH_REPLY, { ...GH_INPUT, files: [{ path: "a" }] })).toBeUndefined();
    expect(pairGh(GH_REPLY, { ...GH_INPUT, files: "x" })).toBeUndefined();
  });
});

describe("select: the prepared facts", () => {
  test("GitHub: the head and the counts", () => {
    expect(GH_ROW.bound?.prepare.select(GH_REPLY)).toEqual([
      {
        label: "Branch head",
        value: `${HEAD} (the commit this change was prepared against; the commit is refused if the branch has moved)`,
      },
      {
        label: "Files",
        value:
          "1 new, 1 already in the branch (each is rewritten whole; the diff below shows what changes)",
      },
    ]);
  });

  test("GitLab adds the non-atomic head check", () => {
    const facts = GL_ROW.bound?.prepare.select(mcp(GL_REPLY));
    expect(facts?.map((f) => f.label)).toEqual(["Branch head", "Files", "Head check"]);
    expect(facts?.[2]?.value).toContain("other files may change before this lands");
  });

  test("a reply with a head but no file list shows zero files rather than failing", () => {
    expect(GH_ROW.bound?.prepare.select({ headSha: HEAD })?.[1]?.value).toContain(
      "0 new, 0 already",
    );
  });

  test("a null-prototype reply and entries are read like plain ones", () => {
    const entry = Object.assign(Object.create(null), GH_REPLY.files[1]);
    const old = Object.assign(Object.create(null), GH_REPLY.files[0]);
    const reply = Object.assign(Object.create(null), { headSha: HEAD, files: [old, entry] });
    expect(GH_ROW.bound?.prepare.diff?.files(GH_INPUT as never, reply)?.map((f) => f.path)).toEqual(
      ["src/a.ts", "docs/new.md"],
    );
  });

  test("a reply with no head throws (the step turns that into unshowable)", () => {
    expect(() => GH_ROW.bound?.prepare.select({ files: [] })).toThrow();
  });
});

describe("the preview, end to end through the prepare step", () => {
  const actionOf = (id: string, input: Record<string, unknown>): PlannedAction => {
    const r = row(id);
    return {
      type: r.actionType,
      origin: "model",
      payload: { mcpToolId: mcpClientToolKey(serviceOf(r.actionType), id), input },
    };
  };

  async function prepared(id: string, input: Record<string, unknown>, reply: unknown) {
    const r = row(id);
    const bound = r.bound;
    if (bound === undefined) throw new Error("not bound");
    return runPrepareStep(
      { gate: async () => "proceed", dispatch: async () => mcp(reply) },
      r,
      bound,
      actionOf(id, input),
      { prepareToolIds: PREPARE_TOOL_IDS },
    );
  }

  test("GitHub: the owner's prompt, golden", async () => {
    const p = await prepared("github_file_commit", GH_INPUT, GH_REPLY);
    const base = buildConnectorWritePreviewFrom(
      actionOf("github_file_commit", GH_INPUT),
      CONNECTOR_WRITE_ROWS,
      () => "personal",
    );
    if (base === undefined || p.diff === undefined) throw new Error("no preview");
    const lines = renderConnectorWritePreviewLines({
      ...base,
      prepared: { status: "ok", fields: p.fields },
      diff: p.diff,
    });
    expect(lines).toEqual([
      "Service: github",
      "Credential: personal",
      "Target:  acme/api@feat/x",
      "Commit to branch feat/x of acme/api as ONE commit (full diff below)",
      "",
      '  Owner: "acme"',
      '  Repository: "api"',
      '  Branch: "feat/x"',
      '  Commit message: "Fix the thing"',
      "  Files: 2 files: src/a.ts, docs/new.md",
      "",
      "Prepared:",
      `  Branch head: ${HEAD} (the commit this change was prepared against; the commit is refused if the branch has moved)`,
      "  Files: 1 new, 1 already in the branch (each is rewritten whole; the diff below shows what changes)",
      "",
      "=== src/a.ts (modified, mode 100644)",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-export const a = 1;",
      "+export const a = 2;",
      "=== docs/new.md (new file, mode 100644)",
      "--- /dev/null",
      "+++ b/docs/new.md",
      "@@ -0,0 +1,1 @@",
      "+# New",
      "End of diff: 2 files, +2 -1",
    ]);
    // The head is never owner-visible input: it is not in the preview, only in "Prepared".
    expect(base.otherFields).toEqual([]);
  });

  test("the rendered plus lines are the caller's text, whatever the reply claims", async () => {
    const forged = { ...GH_REPLY, diff: "+++ FORGED", patch: "FORGED", hunks: ["FORGED"] };
    const p = await prepared("github_file_commit", GH_INPUT, forged);
    expect(JSON.stringify(p.diff)).not.toContain("FORGED");
    const plus = p.diff?.files.flatMap((f) =>
      f.hunks.flatMap((h) => h.lines.filter((l) => l.op === "+").map((l) => l.text)),
    );
    expect(plus).toEqual(["export const a = 2;", "# New"]);
  });

  test("GitLab: prepares and shows both files", async () => {
    const p = await prepared("gitlab_commit_create", GL_INPUT, GL_REPLY);
    expect(p.values).toEqual({ expectedHeadSha: HEAD });
    expect(p.diff?.files.map((f) => [f.path, f.state, f.mode])).toEqual([
      ["src/a.ts", "modified", "regular"],
      ["docs/new.md", "new", "regular"],
    ]);
  });

  test("a head that is not 40 hex is the fixed 'unbound' refusal, not a dispatch", async () => {
    await expect(
      prepared("github_file_commit", GH_INPUT, { ...GH_REPLY, headSha: "abc" }),
    ).rejects.toMatchObject({ reason: PREPARE_REFUSALS.unbound });
  });

  test("a commit whose every file is unchanged is refused as nothing to commit", async () => {
    const same = {
      ...GH_INPUT,
      files: [{ path: "src/a.ts", content: "export const a = 1;\n" }],
    };
    const reply = { headSha: HEAD, files: [GH_REPLY.files[0]] };
    await expect(prepared("github_file_commit", same, reply)).rejects.toMatchObject({
      reason: PREPARE_REFUSALS.nothingToCommit,
    });
  });

  test("a rendered diff over 64 KiB is the fixed 'too large' refusal, though input and old text are within their caps", async () => {
    // A full rewrite of a 32 KiB file: 16,384 lines out and 16,384 lines in, three bytes each.
    const input = {
      ...GH_INPUT,
      files: [{ path: "big.txt", content: "y\n".repeat(16_384) }],
    };
    const reply = {
      headSha: HEAD,
      files: [{ path: "big.txt", exists: true, mode: "100644", oldContent: "x\n".repeat(16_384) }],
    };
    expect(
      boundInputRefusal(
        row("github_file_commit").bound as never,
        actionOf("github_file_commit", input),
      ),
    ).toBeUndefined();
    await expect(prepared("github_file_commit", input, reply)).rejects.toMatchObject({
      reason: PREPARE_REFUSALS.diffTooLarge,
    });
  });
});

describe("boundInputRefusal on the real rows", () => {
  const act = (id: string, input: Record<string, unknown>): PlannedAction => ({
    type: row(id).actionType,
    payload: { mcpToolId: id, input },
  });

  test("the row's input hook is the commit input check", () => {
    const tooMany = {
      ...GH_INPUT,
      files: Array.from({ length: 21 }, (_, i) => ({ path: `f${String(i)}`, content: "x" })),
    };
    expect(boundInputRefusal(GH_ROW.bound as never, act("github_file_commit", tooMany))).toBe(
      COMMIT_INPUT_REFUSALS.filesInvalid,
    );
    expect(
      boundInputRefusal(
        GL_ROW.bound as never,
        act("gitlab_commit_create", {
          ...GL_INPUT,
          files: [{ path: "../etc/passwd", content: "x" }],
        }),
      ),
    ).toBe(COMMIT_INPUT_REFUSALS.pathUnsafe);
    expect(
      boundInputRefusal(GH_ROW.bound as never, act("github_file_commit", GH_INPUT)),
    ).toBeUndefined();
  });

  test("a caller-supplied expectedHeadSha is refused first, at the root and in input", () => {
    for (const a of [
      { type: "github.file.commit", payload: { expectedHeadSha: HEAD, input: GH_INPUT } },
      act("github_file_commit", { ...GH_INPUT, expectedHeadSha: HEAD }),
    ] as PlannedAction[]) {
      expect(boundInputRefusal(GH_ROW.bound as never, a)).toBe(PREPARE_REFUSALS.callerBound);
    }
  });
});
