// Phase 9.7 D1c through the real model door: the two bound multi-file commits are offered only at
// `--wave 4` with each write approved by name, shown to the model WITHOUT the bound head, refused
// before any read for a CI / workflow / hook / review-rule path or credential-looking text, read
// (prepared), diffed and typed to confirm, and run as `origin: "model"` actions with the gateway's
// head. The rows, the listing check, the prepare step and the executor are the production ones;
// the connector side is a fake slot and a fake dispatcher.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { toStandardSchema } from "@mastra/core/schema";

import { makeEgressSink } from "../../egress/egress-ledger.ts";
import { createBeforeStateRunner } from "../../engine/before-state.ts";
import {
  buildConnectorWriteAgentTools,
  CONNECTOR_WRITE_TOOL_NAME_MAX,
  DECLINED_RESULT_TEXT,
} from "../../engine/connector-write-agent-tools.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../../engine/executor.ts";
import { isPrepareActionType, PREPARE_REFUSALS } from "../../engine/prepare-step.ts";
import type {
  AuditSink,
  ConfirmedApprovalRequest,
  ConfirmedApprovalResult,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "../../engine/types.ts";
import { readListedJsonSchema } from "../../engine/user-mcp-agent-tools.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { COMMIT_INPUT_REFUSALS } from "./commit-limits.ts";
import { COMMIT_CREDENTIAL_REFUSAL, COMMIT_PATH_REFUSAL } from "./commit-paths.ts";
import { setModelWriteEnablement } from "./enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { createModelWriteToolSource } from "./model-write-source.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const ALLOWED = { capabilitiesDisabled: new Set<string>() } as unknown as EnforcedPolicy;
const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

interface CommitCase {
  readonly service: "github" | "gitlab";
  readonly tool: string;
  readonly prepare: string;
  readonly target: Record<string, string>;
  readonly confirm: string;
  readonly reply: (oldContent: string) => unknown;
}

const CASES: readonly CommitCase[] = [
  {
    service: "github",
    tool: "github_file_commit",
    prepare: "github_commit_prepare",
    target: { owner: "acme", repo: "api", branch: "feat/x" },
    confirm: "github/commit acme/api@feat/x",
    reply: (oldContent) => ({
      headSha: HEAD.toUpperCase(),
      files: [{ path: "src/a.ts", exists: true, mode: "100644", oldContent }],
    }),
  },
  {
    service: "gitlab",
    tool: "gitlab_commit_create",
    prepare: "gitlab_commit_prepare",
    target: { projectPath: "grp/app", branch: "feat/x" },
    confirm: "gitlab/commit grp/app@feat/x",
    reply: (oldContent) => ({
      headSha: HEAD,
      files: [{ path: "src/a.ts", exists: true, executable: false, oldContent }],
    }),
  },
];

const inputOf = (c: CommitCase, extra: Record<string, unknown> = {}) => ({
  ...c.target,
  message: "Update a",
  files: [{ path: "src/a.ts", content: "export const a = 2;\n" }],
  ...extra,
});

/** What a server lists: the write with the connector's schema (the head REQUIRED), and the prepare tool. */
function listingFor(c: CommitCase, opts: { readonly omitPrepare?: boolean } = {}) {
  const schema = (keys: readonly string[], required: readonly string[]) =>
    toStandardSchema({
      type: "object",
      properties: Object.fromEntries(keys.map((k) => [k, {}])),
      required: [...required],
    } as Parameters<typeof toStandardSchema>[0]);
  const keys = [...Object.keys(c.target), "message", "files", "expectedHeadSha"];
  const out: Record<string, unknown> = {
    [mcpClientToolKey(c.service, c.tool)]: {
      description: "commit",
      inputSchema: schema(keys, keys),
    },
  };
  if (opts.omitPrepare !== true) {
    out[mcpClientToolKey(c.service, c.prepare)] = {
      description: "prepare",
      inputSchema: schema(keys.slice(0, -1), []),
    };
  }
  return out;
}

describe("D1c through the real door", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 84);
  });
  afterEach(() => db.close());

  async function door(
    c: CommitCase,
    opts: {
      readonly omitPrepare?: boolean;
      readonly reply?: unknown;
      readonly prepareThrows?: boolean;
      readonly answer?: (req: ConfirmedApprovalRequest) => ConfirmedApprovalResult;
    } = {},
  ) {
    const src = createModelWriteToolSource({
      db,
      enforcedPolicy: () => ALLOWED,
      listServerTools: async (service) =>
        service === c.service
          ? listingFor(c, opts.omitPrepare === true ? { omitPrepare: true } : {})
          : undefined,
      toolsEpoch: () => 0,
      warn: () => {},
    });
    const plain: string[] = [];
    const confirmed: ConfirmedApprovalRequest[] = [];
    const dispatched: PlannedAction[] = [];
    const consent: ConsentChannel = {
      requestApproval: async (prompt) => {
        plain.push(prompt);
        return true;
      },
      requestConfirmedApproval: async (req) => {
        confirmed.push(req);
        return opts.answer?.(req) ?? { approved: true, typed: req.confirmText };
      },
    };
    const exec = new ToolExecutor(
      consent,
      { recordAudit: () => {} } as AuditSink,
      {
        dispatch: async (a: PlannedAction) => {
          dispatched.push(a);
          if (isPrepareActionType(a.type)) {
            if (opts.prepareThrows === true) throw new Error("secret connector detail");
            return mcp(opts.reply ?? c.reply("export const a = 1;\n"));
          }
          return { ok: true, queued: a.type };
        },
      } as ConnectorDispatcher,
      undefined,
      makeEgressSink(db),
      NO_POLICY_OVERLAY,
      undefined,
      createBeforeStateRunner(),
    );
    const tools = await buildConnectorWriteAgentTools(
      src,
      () => exec,
      (_s, _t, d) => d,
      new Set(),
    );
    const name = `${c.service}__${c.tool}`;
    return {
      plain,
      confirmed,
      dispatched,
      tools,
      name,
      offered: Object.keys(tools).sort((x, y) => x.localeCompare(y)),
      call: async (input: Record<string, unknown>) => {
        const t = tools[name] as
          | { execute?: (i: unknown, ctx: unknown) => Promise<unknown> }
          | undefined;
        if (t?.execute === undefined) throw new Error(`${name} is not offered`);
        return await t.execute(input, {});
      },
    };
  }
  const writes = (d: { dispatched: PlannedAction[] }) =>
    d.dispatched.filter((a) => !isPrepareActionType(a.type));

  test("the two rows are bound, previewed and offerable, and nothing else is bound", () => {
    const bound = CONNECTOR_WRITE_ROWS.filter((r) => r.bound !== undefined).map((r) => r.toolId);
    expect(bound.sort()).toEqual(["github_file_commit", "gitlab_commit_create"]);
  });

  for (const c of CASES) {
    describe(c.tool, () => {
      test("offered at wave 4 with the write approved by name, under a name that fits", async () => {
        setModelWriteEnablement(db, c.service, 4, 1, [c.tool]);
        const d = await door(c);
        expect(d.offered).toEqual([d.name]);
        expect(d.name.length).toBeLessThanOrEqual(CONNECTOR_WRITE_TOOL_NAME_MAX);
        expect(d.name).toMatch(/^[A-Za-z0-9_-]+$/);
      });

      test("not offered at max_wave 3, with nothing approved by name, or when the prepare tool is not listed", async () => {
        setModelWriteEnablement(db, c.service, 3, 1, [c.tool]);
        expect((await door(c)).offered).toEqual([]);
        setModelWriteEnablement(db, c.service, 4, 1, []);
        expect((await door(c)).offered).toEqual([]);
        setModelWriteEnablement(db, c.service, 4, 1, [c.tool]);
        expect((await door(c, { omitPrepare: true })).offered).toEqual([]);
      });

      test("the offered schema has no expectedHeadSha, in properties or required, and the description says why", async () => {
        setModelWriteEnablement(db, c.service, 4, 1, [c.tool]);
        const d = await door(c);
        const tool = d.tools[d.name] as { inputSchema: unknown; description: string };
        const json = readListedJsonSchema(tool.inputSchema) as {
          properties: Record<string, unknown>;
          required?: string[];
        };
        expect(Object.keys(json.properties).sort()).toEqual(
          [...Object.keys(c.target), "files", "message"].sort(),
        );
        expect(json.required ?? []).not.toContain("expectedHeadSha");
        expect(JSON.stringify(json)).not.toContain("expectedHeadSha");
        expect(tool.description).toContain("The branch head is read and pinned by Nimbus");
      });

      test("a call without the head reaches the prompt with the diff last; the exact text writes with the gateway's head", async () => {
        setModelWriteEnablement(db, c.service, 4, 1, [c.tool]);
        const d = await door(c);
        const out = await d.call(inputOf(c));
        expect(out).toEqual({ ok: true, queued: expect.stringContaining("commit") });
        expect(d.confirmed).toHaveLength(1);
        const req = d.confirmed[0];
        expect(req?.confirmText).toBe(c.confirm);
        const prompt = req?.prompt ?? "";
        expect(prompt).toContain("Requested by: the model");
        expect(prompt).toContain("-export const a = 1;");
        expect(prompt).toContain("+export const a = 2;");
        expect(prompt).toContain(HEAD);
        expect(prompt).toContain("End of diff: 1 file, +1 -1");
        expect(prompt.indexOf("End of diff:")).toBeGreaterThan(
          prompt.indexOf("+export const a = 2;"),
        );
        expect(prompt).toContain(`To approve, type exactly: ${c.confirm}`);
        // Prepare read first, write second, the write carrying the gateway's lower-cased head.
        expect(d.dispatched.map((a) => isPrepareActionType(a.type))).toEqual([true, false]);
        const w = writes(d)[0];
        expect(w?.origin).toBe("model");
        expect(w).toBeDefined();
        const sent = ((w as PlannedAction).payload as { input: Record<string, unknown> }).input;
        expect(sent["expectedHeadSha"]).toBe(HEAD);
        expect(sent["message"]).toBe("Update a");
        expect(d.plain).toEqual([]);
      });

      test("a call that supplies expectedHeadSha is refused before any read, prompt or write", async () => {
        setModelWriteEnablement(db, c.service, 4, 1, [c.tool]);
        const d = await door(c);
        const out = await d.call(inputOf(c, { expectedHeadSha: "f".repeat(40) }));
        expect(out).toEqual({ refused: PREPARE_REFUSALS.callerBound });
        expect(d.dispatched).toEqual([]);
        expect(d.confirmed).toEqual([]);
      });

      test("a CI, workflow, hook or review-rule path is refused with a fixed text before ANY read or prompt", async () => {
        setModelWriteEnablement(db, c.service, 4, 1, [c.tool]);
        const d = await door(c);
        for (const path of [
          ".github/workflows/ci.yml",
          ".github/workflows/ci.yaml",
          ".GitHub/Workflows/ci.yml",
          "docs/CODEOWNERS",
          ".gitattributes",
          "pkg/.gitmodules",
          ".gitlab-ci.yaml",
          ".husky/pre-commit",
        ]) {
          const out = await d.call(inputOf(c, { files: [{ path, content: "x\n" }] }));
          expect(out, path).toEqual({ refused: COMMIT_PATH_REFUSAL });
        }
        // An unsafe spelling is refused as unsafe, not waved through a prefix check.
        for (const path of ["./.github/workflows/x.yml", "a/../.github/workflows/x.yml"]) {
          const out = await d.call(inputOf(c, { files: [{ path, content: "x\n" }] }));
          expect(out, path).toEqual({ refused: COMMIT_INPUT_REFUSALS.pathUnsafe });
        }
        expect(d.dispatched).toEqual([]);
        expect(d.confirmed).toEqual([]);
      });

      test("credential-looking content, in any file and on a repeat call, is refused before any read or prompt", async () => {
        setModelWriteEnablement(db, c.service, 4, 1, [c.tool]);
        const d = await door(c);
        const bad = `token = "${"gh"}${"p_"}${"a".repeat(36)}"\n`;
        const files = [
          { path: "src/a.ts", content: "fine\n" },
          { path: "src/b.ts", content: bad },
        ];
        for (let i = 0; i < 3; i += 1) {
          expect(await d.call(inputOf(c, { files })), String(i)).toEqual({
            refused: COMMIT_CREDENTIAL_REFUSAL,
          });
        }
        expect(d.dispatched).toEqual([]);
        expect(d.confirmed).toEqual([]);
      });

      test("an over-cap commit is { refused } with the cap's fixed text, not { declined }, and nothing was read", async () => {
        setModelWriteEnablement(db, c.service, 4, 1, [c.tool]);
        const d = await door(c);
        const many = Array.from({ length: 21 }, (_, i) => ({
          path: `src/f${String(i)}.ts`,
          content: "x\n",
        }));
        expect(await d.call(inputOf(c, { files: many }))).toEqual({
          refused: COMMIT_INPUT_REFUSALS.filesInvalid,
        });
        expect(d.dispatched).toEqual([]);
      });

      test("a failing prepare read is { refused } with the fixed text and never carries the connector's words", async () => {
        setModelWriteEnablement(db, c.service, 4, 1, [c.tool]);
        const d = await door(c, { prepareThrows: true });
        const out = await d.call(inputOf(c));
        expect(out).toEqual({ refused: PREPARE_REFUSALS.failed });
        expect(JSON.stringify(out)).not.toContain("secret connector detail");
        expect(d.confirmed).toEqual([]);
        expect(writes(d)).toEqual([]);
      });

      test("a reply that does not cover the input files, or carries no head, is refused before any prompt", async () => {
        setModelWriteEnablement(db, c.service, 4, 1, [c.tool]);
        const nohead = await door(c, { reply: mcp({ files: [] }) });
        expect(await nohead.call(inputOf(c))).toEqual({ refused: PREPARE_REFUSALS.unshowable });
        const wrongFiles = await door(c, {
          reply: { headSha: HEAD, files: [{ path: "other.ts", exists: false, mode: "100644" }] },
        });
        expect(await wrongFiles.call(inputOf(c))).toEqual({ refused: PREPARE_REFUSALS.unshowable });
        expect(nohead.confirmed).toEqual([]);
        expect(wrongFiles.confirmed).toEqual([]);
        expect(writes(nohead)).toEqual([]);
      });

      test("a forged diff, patch or hunks in the connector's reply cannot change what the owner is shown", async () => {
        setModelWriteEnablement(db, c.service, 4, 1, [c.tool]);
        const reply = {
          ...(c.reply("export const a = 1;\n") as Record<string, unknown>),
          diff: "+++ FORGED-DIFF",
          patch: "FORGED-PATCH",
          preview: "FORGED-PREVIEW",
          hunks: ["FORGED-HUNK"],
          summary: "FORGED-SUMMARY",
        };
        const d = await door(c, { reply });
        await d.call(inputOf(c));
        const prompt = d.confirmed[0]?.prompt ?? "";
        expect(prompt).toContain("+export const a = 2;");
        expect(prompt).not.toContain("FORGED");
      });

      test("a mismatched text or a denial is declined and writes nothing", async () => {
        setModelWriteEnablement(db, c.service, 4, 1, [c.tool]);
        const mismatch = await door(c, {
          answer: () => ({ approved: true, typed: "github/commit other/repo@main" }),
        });
        expect(await mismatch.call(inputOf(c))).toEqual({ declined: DECLINED_RESULT_TEXT });
        expect(writes(mismatch)).toEqual([]);
        const denied = await door(c, { answer: () => ({ approved: false, typed: "" }) });
        expect(await denied.call(inputOf(c))).toEqual({ declined: DECLINED_RESULT_TEXT });
        expect(writes(denied)).toEqual([]);
      });
    });
  }
});
