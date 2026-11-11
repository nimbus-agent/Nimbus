// Phase 9.7 C2: the typed previews and before-readers of the six VCS writes (branch, pull request
// and merge request create and update). Each row's template keys are exactly its tool's
// input-schema keys in `@nimbus-dev/connectors` 0.6.0, checked twice: against a spelled-out
// constant AND against the keys the installed package's source declares, so a wrong constant fails
// and so does a connector release that renames a key.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { toStandardSchema } from "@mastra/core/schema";

import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { makeEgressSink } from "../../egress/egress-ledger.ts";
import { createBeforeStateRunner, isBeforeReadActionType } from "../../engine/before-state.ts";
import { buildConnectorWriteAgentTools } from "../../engine/connector-write-agent-tools.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../../engine/executor.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type {
  AuditSink,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "../../engine/types.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import {
  declaredInputKeys,
  registrationCallOf,
  withSchemaArgumentDeclarations,
} from "../testing/connector-schema-source.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";
import { setModelWriteEnablement } from "./enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import {
  BROADCAST_MENTION_REFUSAL,
  GITLAB_QUICK_ACTION_REFUSAL,
  REMOTE_CONTENT_REFUSAL,
} from "./model-write-refusals.ts";
import { createModelWriteToolSource } from "./model-write-source.ts";
import {
  buildConnectorWritePreviewFrom,
  type ConnectorWritePreview,
  renderConnectorWritePreviewLines,
} from "./preview.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";
import {
  selectGithubPrBase,
  selectGithubPrUpdate,
  selectGithubRefSha,
  selectGitlabMrUpdate,
} from "./vcs-ci.ts";

const C2_ROWS = [
  "github_branch_create",
  "github_pr_create",
  "github_pr_update",
  "gitlab_branch_create",
  "gitlab_mr_create",
  "gitlab_mr_update",
] as const;
type C2Row = (typeof C2_ROWS)[number];

/** The 0.6.0 input-schema keys of each row, spelled out from the connector source (sorted). */
const SCHEMA_KEYS: Readonly<Record<C2Row, readonly string[]>> = {
  github_branch_create: ["branch", "expectedSha", "fromRef", "owner", "repo"],
  github_pr_create: ["base", "body", "draft", "head", "owner", "repo", "title"],
  github_pr_update: ["base", "body", "owner", "pullNumber", "repo", "title"],
  gitlab_branch_create: ["branch", "expectedSha", "fromRef", "projectPath"],
  gitlab_mr_create: ["description", "projectPath", "sourceBranch", "targetBranch", "title"],
  gitlab_mr_update: ["description", "mergeRequestIid", "projectPath", "targetBranch", "title"],
};

/** The before-reader tool of each row that has one, and the input keys that tool's schema declares. */
const READERS: Readonly<
  Partial<Record<C2Row, { readonly tool: string; readonly keys: readonly string[] }>>
> = {
  github_branch_create: { tool: "github_ref_get", keys: ["owner", "ref", "repo"] },
  github_pr_create: { tool: "github_ref_get", keys: ["owner", "ref", "repo"] },
  github_pr_update: { tool: "github_pr_get", keys: ["owner", "pullNumber", "repo"] },
  gitlab_mr_update: { tool: "gitlab_mr_get", keys: ["mergeRequestIid", "projectPath"] },
};

const sources = readConnectorPackageSources(installedConnectorsPackageRoot());
const scan = scanWriteToolRegistrations(sources);
const codeByFile = new Map(sources.map((s) => [s.rel, stripComments(s.text)]));

function declaredWriteKeys(toolId: string): string[] {
  const reg = scan.registrations.find((r) => r.id === toolId);
  if (reg === undefined)
    throw new Error(`${toolId}: not a registered write in the installed package`);
  const code = codeByFile.get(reg.file) ?? "";
  const call = code.slice(reg.span[0], reg.span[1] + 1);
  return declaredInputKeys(withSchemaArgumentDeclarations(sources, code, call));
}

function declaredReadKeys(toolId: string): string[] {
  const hits = sources.flatMap((s) => {
    const code = codeByFile.get(s.rel) ?? "";
    const call = registrationCallOf(code, toolId);
    return call === undefined ? [] : [{ code, call }];
  });
  if (hits.length !== 1) throw new Error(`${toolId}: registered in ${String(hits.length)} files`);
  const [hit] = hits;
  if (hit === undefined) throw new Error(toolId);
  return declaredInputKeys(withSchemaArgumentDeclarations(sources, hit.code, hit.call));
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const CLEAN: Readonly<Record<C2Row, Record<string, unknown>>> = {
  github_branch_create: { owner: "acme", repo: "api", branch: "fix/x", fromRef: "main" },
  github_pr_create: {
    owner: "acme",
    repo: "api",
    head: "fix/x",
    base: "main",
    title: "Fix x",
    body: "Details",
    draft: true,
  },
  github_pr_update: { owner: "acme", repo: "api", pullNumber: 42, title: "New title" },
  gitlab_branch_create: { projectPath: "grp/api", branch: "fix/x", fromRef: "main" },
  gitlab_mr_create: {
    projectPath: "grp/api",
    sourceBranch: "fix/x",
    targetBranch: "main",
    title: "Fix x",
  },
  gitlab_mr_update: { projectPath: "grp/api", mergeRequestIid: 7, title: "New title" },
};

const GOLDEN: Readonly<Record<C2Row, readonly string[]>> = {
  github_branch_create: [
    "Service: github",
    "Credential: personal",
    "Target:  acme/api:fix/x",
    "Create GitHub branch fix/x in acme/api from main",
    "",
    '  owner: "acme"',
    '  repo: "api"',
    '  Branch to create: "fix/x"',
    '  Create it from (branch, tag or commit): "main"',
    "  Expected commit: (not set: the branch is created from whatever fromRef is when you approve)",
  ],
  github_pr_create: [
    "Service: github",
    "Credential: personal",
    "Target:  acme/api",
    "Open GitHub pull request fix/x -> main in acme/api",
    "",
    '  owner: "acme"',
    '  repo: "api"',
    '  Head (branch, or user:branch for a fork): "fix/x"',
    '  Base branch: "main"',
    '  Title: "Fix x"',
    '  Description: "Details"',
    "  Draft: true",
  ],
  github_pr_update: [
    "Service: github",
    "Credential: personal",
    "Target:  acme/api#42",
    "Update GitHub pull request acme/api#42",
    "",
    '  owner: "acme"',
    '  repo: "api"',
    "  Pull request number: 42",
    '  New title: "New title"',
    "  New description (replaces the whole description): (not set: unchanged)",
    "  New base branch: (not set: unchanged)",
  ],
  gitlab_branch_create: [
    "Service: gitlab",
    "Credential: personal",
    "Target:  grp/api:fix/x",
    "Create GitLab branch fix/x in grp/api from main",
    "",
    '  projectPath: "grp/api"',
    '  Branch to create: "fix/x"',
    '  Create it from (branch, tag or commit): "main"',
    "  Expected commit: (not set: the branch is created from whatever fromRef is when you approve)",
  ],
  gitlab_mr_create: [
    "Service: gitlab",
    "Credential: personal",
    "Target:  grp/api",
    "Open GitLab merge request fix/x -> main in grp/api",
    "",
    '  projectPath: "grp/api"',
    '  Source branch: "fix/x"',
    '  Target branch: "main"',
    '  Title (a Draft: or [Draft] prefix opens it as a draft): "Fix x"',
    "  Description: (not set: no description)",
  ],
  gitlab_mr_update: [
    "Service: gitlab",
    "Credential: personal",
    "Target:  grp/api!7",
    "Update GitLab merge request grp/api!7",
    "",
    '  projectPath: "grp/api"',
    "  Merge request number: 7",
    '  New title: "New title"',
    "  New description (replaces the whole description): (not set: unchanged)",
    "  New target branch: (not set: unchanged)",
  ],
};

function rowOf(toolId: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
}

function previewOf(
  toolId: C2Row,
  input: Record<string, unknown>,
  before?: ConnectorWritePreview["before"],
): ConnectorWritePreview {
  const r = rowOf(toolId);
  const p = buildConnectorWritePreviewFrom(
    {
      type: r.actionType,
      origin: "model",
      payload: { mcpToolId: mcpClientToolKey(serviceOf(r.actionType), toolId), input },
    },
    CONNECTOR_WRITE_ROWS,
    () => "personal",
  );
  if (p === undefined) throw new Error(`no preview for ${toolId}`);
  return before === undefined ? p : { ...p, before };
}

const sortedKeys = (keys: Iterable<string>): string[] =>
  [...keys].sort((a, b) => a.localeCompare(b));
const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fieldMap = (fields: readonly { label: string; value: string }[]): Record<string, string> =>
  Object.fromEntries(fields.map((f) => [f.label, f.value]));

describe("C2 typed previews: the six branch, pull request and merge request rows", () => {
  test("the six rows are mesh, wave 3, templated and offerable; the four with a reader have one", () => {
    expect(C2_ROWS).toHaveLength(6);
    for (const id of C2_ROWS) {
      const r = rowOf(id);
      expect(r.transport, id).toBe("mesh");
      expect(r.wave, id).toBe(3);
      expect(r.preview, id).toBeDefined();
      expect(r.registeredAs, id).toBeUndefined();
      expect(isModelOfferableRow(r), id).toBe(true);
      expect(r.before !== undefined, id).toBe(READERS[id] !== undefined);
    }
  });

  for (const id of C2_ROWS) {
    test(`golden lines: ${id}`, () => {
      const p = previewOf(id, CLEAN[id]);
      expect(renderConnectorWritePreviewLines(p)).toEqual([...GOLDEN[id]]);
      expect(p.otherFields).toEqual([]);
    });
  }

  test("the template keys equal the spelled-out 0.6.0 schema keys", () => {
    for (const id of C2_ROWS) {
      const t = rowOf(id).preview;
      if (t === undefined) throw new Error(id);
      expect(sortedKeys(previewTemplateKeys(t)), id).toEqual([...SCHEMA_KEYS[id]]);
    }
  });

  test("the spelled-out keys equal what the installed package source declares (not circular)", () => {
    for (const id of C2_ROWS) {
      const declared = declaredWriteKeys(id);
      expect(declared.length, `${id}: the schema shape was not recognised`).toBeGreaterThan(0);
      expect(declared, id).toEqual([...SCHEMA_KEYS[id]]);
    }
  });

  test("the reader tools are registered tools of the installed package; each args sends only the keys the tool declares", () => {
    for (const id of C2_ROWS) {
      const want = READERS[id];
      const reader = rowOf(id).before;
      if (want === undefined) {
        expect(reader, id).toBeUndefined();
        continue;
      }
      if (reader === undefined) throw new Error(id);
      expect(reader.tool, id).toBe(want.tool);
      expect(declaredReadKeys(reader.tool), id).toEqual([...want.keys]);
      const sent = reader.args(
        id === "github_pr_create" ? { owner: "o", repo: "r", base: "main" } : CLEAN[id],
      );
      expect(sortedKeys(Object.keys(sent ?? {})), id).toEqual([...want.keys]);
    }
  });

  test("the update readers declare the picked keys the select and guard read", () => {
    expect(rowOf("github_pr_update").before?.argKeys).toEqual([
      "owner",
      "repo",
      "pullNumber",
      "title",
      "body",
      "base",
    ]);
    expect(rowOf("gitlab_mr_update").before?.argKeys).toEqual([
      "projectPath",
      "mergeRequestIid",
      "title",
      "description",
      "targetBranch",
    ]);
  });

  test("GitHub PR create: the update-only fields are absent, the draft default is stated", () => {
    const lines = renderConnectorWritePreviewLines(
      previewOf("github_pr_create", { ...CLEAN.github_pr_create, draft: undefined }),
    ).join("\n");
    expect(lines).toContain("Draft: (not set: opened ready for review)");
  });
});

describe("C2 selectors", () => {
  test("GitHub ref sha: what fromRef resolves to, and expectedSha matches / DIFFERS / absent", () => {
    const reply = mcp({ ref: "main", kind: "branch", sha: SHA_A });
    expect(fieldMap(selectGithubRefSha(reply, {}))).toEqual({
      "fromRef resolves to": `${SHA_A} (branch)`,
    });
    expect(fieldMap(selectGithubRefSha(reply, { expectedSha: SHA_A }))["expectedSha"]).toBe(
      "matches",
    );
    expect(
      fieldMap(selectGithubRefSha(reply, { expectedSha: SHA_A.toUpperCase() }))["expectedSha"],
    ).toBe("matches");
    expect(fieldMap(selectGithubRefSha(reply, { expectedSha: SHA_B }))["expectedSha"]).toBe(
      "DIFFERS: the write will fail",
    );
    expect(fieldMap(selectGithubRefSha({ sha: SHA_A }, {}))).toEqual({
      "fromRef resolves to": SHA_A,
    });
  });

  test("GitHub ref sha: a reply without a 40-hex sha throws (the prompt reads unavailable)", () => {
    expect(() => selectGithubRefSha(mcp({ kind: "branch" }), {})).toThrow();
    expect(() => selectGithubRefSha(mcp({ sha: "abc" }), {})).toThrow();
    expect(() => selectGithubRefSha("nope", {})).toThrow();
    expect(() => selectGithubPrBase(mcp({ sha: "zz" }))).toThrow();
  });

  test("GitHub PR create: the base exists at a short sha; the head is stated as not checked", () => {
    expect(fieldMap(selectGithubPrBase(mcp({ ref: "main", kind: "branch", sha: SHA_A })))).toEqual({
      "Head branch": "not checked",
      "Base branch": `exists at ${"a".repeat(7)}`,
    });
  });

  const PR = {
    title: "Add retries",
    body: "PRIVATE BODY TEXT",
    state: "open",
    merged: false,
    draft: false,
    base: { ref: "main" },
    head: { ref: "feat" },
  };

  test("GitHub PR update: title, state, base, draft; a changed base reads RETARGETS; never the body", () => {
    const same = fieldMap(selectGithubPrUpdate(mcp(PR), { base: "main" }));
    expect(same).toEqual({
      Title: "Add retries",
      State: "open",
      Base: "unchanged (main)",
      Draft: "no",
    });
    expect(JSON.stringify(same)).not.toContain("PRIVATE BODY");
    expect(fieldMap(selectGithubPrUpdate(PR, { base: "release" }))["Base"]).toBe(
      "main -> release (RETARGETS)",
    );
    expect(fieldMap(selectGithubPrUpdate(PR, {}))["Base"]).toBe("main");
    expect(fieldMap(selectGithubPrUpdate({ title: "t" }, { base: "x" }))["Base"]).toBe(
      "(unknown) -> x (RETARGETS)",
    );
    expect(fieldMap(selectGithubPrUpdate({ ...PR, state: "closed" }, {}))["State"]).toBe(
      "closed: it is already closed",
    );
    expect(fieldMap(selectGithubPrUpdate({ ...PR, merged: true }, {}))["State"]).toBe(
      "merged: it is already merged",
    );
    expect(() => selectGithubPrUpdate({ state: "open" }, {})).toThrow();
  });

  const MR = {
    title: "Fix x",
    description: "PRIVATE DESCRIPTION",
    state: "opened",
    draft: false,
    source_branch: "feat",
    target_branch: "main",
  };

  test("GitLab MR update: all four draft transitions, and no title", () => {
    const line = (reply: unknown, picked: Record<string, unknown>) =>
      fieldMap(selectGitlabMrUpdate(reply, picked))["Draft state"];
    // ready now
    expect(line(MR, {})).toBe("unchanged (ready)");
    expect(line(MR, { title: "Other" })).toBe("unchanged (ready)");
    expect(line(MR, { title: "Draft: Other" })).toBe(
      "MARKS AS DRAFT: the new title adds a draft prefix",
    );
    // draft now
    const draft = { ...MR, title: "Draft: Fix x", draft: true };
    expect(line(draft, {})).toBe("unchanged (draft)");
    expect(line(draft, { title: "[Draft] Other" })).toBe("unchanged (draft)");
    expect(line(draft, { title: "Fix x" })).toBe(
      "MARKS READY: the new title drops its draft prefix",
    );
    // the title prefix stands in when the reply has no boolean
    const { draft: _d, ...noFlag } = draft;
    expect(line(noFlag, { title: "Fix x" })).toBe(
      "MARKS READY: the new title drops its draft prefix",
    );
    expect(line({ ...MR, draft: undefined }, {})).toBe("unchanged (ready)");
  });

  test("GitLab MR update: a title GitLab and the folded detector may read differently is UNCERTAIN, never 'unchanged (draft)'", () => {
    const line = (reply: unknown, picked: Record<string, unknown>) =>
      fieldMap(selectGitlabMrUpdate(reply, picked))["Draft state"];
    const draft = { ...MR, title: "Draft: Fix x", draft: true };
    const uncertain = "UNCERTAIN: the new title may or may not mark this merge request as draft";
    for (const title of ["Dra​ft: x", "Draft：x", "［Draft］x", "Draft&#58; x", "WIP: x"]) {
      expect(line(draft, { title }), title).toBe(uncertain);
    }
    expect(line({ ...MR, draft: false }, { title: "WIP: x" })).toBe(uncertain);
  });

  test("GitLab MR update: title, state, target branch RETARGETS; never the description", () => {
    const f = fieldMap(selectGitlabMrUpdate(mcp(MR), { targetBranch: "release" }));
    expect(f["Title"]).toBe("Fix x");
    expect(f["State"]).toBe("opened");
    expect(f["Target branch"]).toBe("main -> release (RETARGETS)");
    expect(JSON.stringify(f)).not.toContain("PRIVATE DESCRIPTION");
    expect(fieldMap(selectGitlabMrUpdate(MR, { targetBranch: "main" }))["Target branch"]).toBe(
      "unchanged (main)",
    );
    expect(() => selectGitlabMrUpdate({ state: "opened" }, {})).toThrow();
  });

  test("the RETARGETS and MARKS READY lines reach the rendered preview", () => {
    const ghFields = selectGithubPrUpdate(PR, { base: "release" });
    const gh = renderConnectorWritePreviewLines(
      previewOf(
        "github_pr_update",
        { owner: "acme", repo: "api", pullNumber: 42, base: "release" },
        { status: "ok", fields: ghFields },
      ),
    );
    expect(gh).toContain("  Base: main -> release (RETARGETS)");
    const glFields = selectGitlabMrUpdate(
      { ...MR, title: "Draft: Fix x", draft: true },
      { title: "Fix x" },
    );
    const gl = renderConnectorWritePreviewLines(
      previewOf(
        "gitlab_mr_update",
        { projectPath: "grp/api", mergeRequestIid: 7, title: "Fix x" },
        { status: "ok", fields: glFields },
      ),
    );
    expect(gl).toContain("  Draft state: MARKS READY: the new title drops its draft prefix");
  });

  test("values are capped by excerptHead", () => {
    const long = "t".repeat(5000);
    expect(fieldMap(selectGithubPrUpdate({ title: long }, {}))["Title"]).toContain(
      "more characters not shown",
    );
    expect(fieldMap(selectGitlabMrUpdate({ title: long }, {}))["Title"]).toContain(
      "more characters not shown",
    );
  });
});

describe("C2 readers' args and guards", () => {
  test("the ref reads need string owner, repo and ref; PR create reads the base only", () => {
    const branch = rowOf("github_branch_create").before;
    expect(branch?.args({ owner: "o", repo: "r", fromRef: "main", expectedSha: SHA_A })).toEqual({
      owner: "o",
      repo: "r",
      ref: "main",
    });
    for (const bad of [{ fromRef: 7 }, { fromRef: "" }, { owner: "" }, { repo: null }]) {
      expect(
        branch?.args({ owner: "o", repo: "r", fromRef: "main", ...bad }),
        JSON.stringify(bad),
      ).toBeUndefined();
    }
    const pr = rowOf("github_pr_create").before;
    expect(pr?.argKeys).toEqual(["owner", "repo", "base"]);
    expect(pr?.also).toBeUndefined();
    expect(pr?.args({ owner: "o", repo: "r", base: "main" })).toEqual({
      owner: "o",
      repo: "r",
      ref: "main",
    });
    expect(pr?.args({ owner: "o", repo: "r", base: 3 })).toBeUndefined();
  });

  test("an invalid pullNumber or mergeRequestIid yields no read (digit strings are fine)", () => {
    const gh = rowOf("github_pr_update").before;
    const gl = rowOf("gitlab_mr_update").before;
    expect(gh?.args({ owner: "o", repo: "r", pullNumber: "42" })).toEqual({
      owner: "o",
      repo: "r",
      pullNumber: 42,
    });
    expect(gl?.args({ projectPath: "g/r", mergeRequestIid: "7" })).toEqual({
      projectPath: "g/r",
      mergeRequestIid: 7,
    });
    for (const bad of [0, -1, 1.5, "4x", "", null, undefined, {}]) {
      expect(gh?.args({ owner: "o", repo: "r", pullNumber: bad }), String(bad)).toBeUndefined();
      expect(gl?.args({ projectPath: "g/r", mergeRequestIid: bad }), String(bad)).toBeUndefined();
    }
    expect(gl?.args({ projectPath: "", mergeRequestIid: 7 })).toBeUndefined();
  });

  test("an update with none of its text keys set is refused with its own fixed reason; a bare empty string counts as set", () => {
    const cases = [
      ["github_pr_update", ["title", "body", "base"], "set at least one of title, body, base"],
      [
        "gitlab_mr_update",
        ["title", "description", "targetBranch"],
        "set at least one of title, description, targetBranch",
      ],
    ] as const;
    for (const [id, keys, reason] of cases) {
      const guard = rowOf(id).before?.guard;
      if (guard === undefined) throw new Error(id);
      expect(guard.reason).toBe(reason);
      expect(guard.appliesTo({}, undefined), id).toBe(true);
      expect(guard.appliesTo({ [keys[0]]: undefined }, undefined), id).toBe(true);
      expect(guard.allows(undefined, {}, undefined, undefined), id).toBe(false);
      for (const key of keys) {
        expect(guard.appliesTo({ [key]: "x" }, undefined), `${id} ${key}`).toBe(false);
        expect(guard.appliesTo({ [key]: "" }, undefined), `${id} ${key} empty`).toBe(false);
      }
    }
  });
});

// ---- the door: the six rows offered, read, prompted and refused ------------------------------

/** What a server lists for `service`: each write with its 0.6.0 keys, each reader with its keys. */
function c2Listing(service: string, opts: { readonly omitReaders?: boolean } = {}) {
  const out: Record<string, unknown> = {};
  const entry = (keys: readonly string[]) => ({
    description: "tool",
    inputSchema: toStandardSchema({
      type: "object",
      properties: Object.fromEntries(keys.map((k) => [k, {}])),
    } as Parameters<typeof toStandardSchema>[0]),
  });
  for (const id of C2_ROWS) {
    if (serviceOf(rowOf(id).actionType) !== service) continue;
    out[mcpClientToolKey(service, id)] = entry(SCHEMA_KEYS[id]);
    const reader = READERS[id];
    if (reader !== undefined && opts.omitReaders !== true) {
      out[mcpClientToolKey(service, reader.tool)] = entry(reader.keys);
    }
  }
  return out;
}

describe("C2 through the real door", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 84);
  });
  afterEach(() => db.close());

  const ALLOWED = { capabilitiesDisabled: new Set<string>() } as unknown as EnforcedPolicy;

  async function door(opts: { readonly omitReaders?: boolean; readonly readReply?: unknown }) {
    for (const s of ["github", "gitlab"]) {
      const approved = C2_ROWS.filter((id) => serviceOf(rowOf(id).actionType) === s);
      setModelWriteEnablement(db, s, 3, 1, approved);
    }
    const src = createModelWriteToolSource({
      db,
      enforcedPolicy: () => ALLOWED,
      listServerTools: async (service) =>
        c2Listing(service, opts.omitReaders === true ? { omitReaders: true } : {}),
      toolsEpoch: () => 0,
      warn: () => {},
    });
    const prompts: string[] = [];
    const dispatched: PlannedAction[] = [];
    const exec = new ToolExecutor(
      {
        requestApproval: async (p: string) => {
          prompts.push(p);
          return { approved: true, answerSource: "human" as const };
        },
      } as ConsentChannel,
      { recordAudit: () => {} } as AuditSink,
      {
        dispatch: async (a: PlannedAction) => {
          dispatched.push(a);
          return isBeforeReadActionType(a.type) ? opts.readReply : { ok: true };
        },
      } as ConnectorDispatcher,
      undefined,
      makeEgressSink(db),
      NO_POLICY_OVERLAY,
      undefined,
      { beforeState: createBeforeStateRunner() },
    );
    const tools = await buildConnectorWriteAgentTools(
      src,
      () => exec,
      (_s, _t, d) => d,
      new Set(),
    );
    return {
      prompts,
      dispatched,
      offered: Object.keys(tools).sort((a, b) => a.localeCompare(b)),
      call: async (name: string, input: Record<string, unknown>) => {
        const t = tools[name] as
          | { execute?: (i: unknown, c: unknown) => Promise<unknown> }
          | undefined;
        if (t?.execute === undefined) throw new Error(`${name} is not offered`);
        return await t.execute(input, {});
      },
    };
  }

  const SIX = C2_ROWS.map((id) => `${serviceOf(rowOf(id).actionType)}__${id}`).sort((a, b) =>
    a.localeCompare(b),
  );

  test("a wave-3 opt-in that approved the six offers exactly them", async () => {
    expect((await door({})).offered).toEqual(SIX);
  });

  test("with the reader tools missing the rows are still offered and the prompt says Before: unavailable", async () => {
    const d = await door({ omitReaders: true });
    expect(d.offered).toEqual(SIX);
    expect(await d.call("github__github_pr_update", CLEAN.github_pr_update)).toEqual({ ok: true });
    expect(d.prompts[0]).toContain("Before: unavailable (failed)");
    expect(d.dispatched.map((a) => a.type)).toEqual(["github.pr.update"]);
  });

  test("a GitLab MR update prompt shows MARKS READY and RETARGETS end to end", async () => {
    const d = await door({
      readReply: mcp({
        title: "Draft: Fix x",
        state: "opened",
        draft: true,
        source_branch: "feat",
        target_branch: "main",
      }),
    });
    expect(
      await d.call("gitlab__gitlab_mr_update", {
        projectPath: "grp/api",
        mergeRequestIid: 7,
        title: "Fix x",
        targetBranch: "release",
      }),
    ).toEqual({ ok: true });
    expect(d.prompts[0]).toContain(
      "Draft state: MARKS READY: the new title drops its draft prefix",
    );
    expect(d.prompts[0]).toContain("Target branch: main -> release (RETARGETS)");
    expect(d.dispatched.map((a) => isBeforeReadActionType(a.type))).toEqual([true, false]);
  });

  test("an empty update is refused before the prompt and nothing is written", async () => {
    const d = await door({ readReply: mcp({ title: "t", base: { ref: "main" } }) });
    const out = await d.call("github__github_pr_update", {
      owner: "acme",
      repo: "api",
      pullNumber: 42,
    });
    expect(JSON.stringify(out)).toContain("set at least one of title, body, base");
    expect(d.prompts).toEqual([]);
    expect(d.dispatched.some((a) => !isBeforeReadActionType(a.type))).toBe(false);
  });

  test("hostile model calls are refused by the per-call recheck; nothing is dispatched or prompted", async () => {
    const d = await door({});
    const hostile: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
      [
        "github__github_pr_create",
        { ...CLEAN.github_pr_create, body: "cc @org/team" },
        BROADCAST_MENTION_REFUSAL,
      ],
      [
        "github__github_pr_create",
        { ...CLEAN.github_pr_create, title: "@org/team" },
        BROADCAST_MENTION_REFUSAL,
      ],
      [
        "github__github_pr_update",
        { owner: "o", repo: "r", pullNumber: 1, body: "![x](https://evil/p.png)" },
        REMOTE_CONTENT_REFUSAL,
      ],
      [
        "github__github_pr_create",
        { ...CLEAN.github_pr_create, body: "<img src=//h>" },
        REMOTE_CONTENT_REFUSAL,
      ],
      [
        "gitlab__gitlab_mr_create",
        { ...CLEAN.gitlab_mr_create, description: "/merge" },
        GITLAB_QUICK_ACTION_REFUSAL,
      ],
      [
        "gitlab__gitlab_mr_update",
        { projectPath: "g/r", mergeRequestIid: 2, description: "ok\n/approve" },
        GITLAB_QUICK_ACTION_REFUSAL,
      ],
      [
        "gitlab__gitlab_mr_create",
        { ...CLEAN.gitlab_mr_create, title: "@all" },
        BROADCAST_MENTION_REFUSAL,
      ],
    ];
    for (const [name, input, refusal] of hostile) {
      expect(await d.call(name, input), name).toEqual({ refused: refusal });
    }
    expect(d.prompts).toEqual([]);
    expect(d.dispatched).toEqual([]);
  });
});
