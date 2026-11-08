// packages/gateway/src/engine/executor-commit.test.ts
// Phase 9.7 D1c: the two multi-file commit writes through the REAL production table (no write-table
// seam): the first production bound rows meeting the D0b mechanism (I54). A fake dispatcher stands in
// for the connector; everything the executor does around it is real.
import { describe, expect, test } from "bun:test";
import type { EgressSink } from "../egress/egress-ledger.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { commitFilesDigest } from "./audit-files.ts";
import {
  BOUND_VIA_GATE_REASON,
  CONFIRM_MISMATCH_REASON,
  NO_POLICY_OVERLAY,
  ToolExecutor,
} from "./executor.ts";
import { PREPARE_REFUSALS } from "./prepare-step.ts";
import type { ConfirmedApprovalRequest, PlannedAction } from "./types.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const FILES = [
  { path: "src/a.ts", content: "export const a = 2;\n" },
  { path: "docs/new.md", content: "# New\n" },
];
const GH_INPUT = { owner: "acme", repo: "api", branch: "feat/x", message: "Fix", files: FILES };
const GL_INPUT = { projectPath: "grp/app", branch: "feat/x", message: "Fix", files: FILES };

const GH_REPLY = {
  headSha: HEAD,
  files: [
    { path: "src/a.ts", exists: true, mode: "100644", oldSha: "b".repeat(40), oldContent: "old\n" },
    { path: "docs/new.md", exists: false, mode: "100644" },
  ],
};
const GL_REPLY = {
  headSha: HEAD,
  files: [
    {
      path: "src/a.ts",
      exists: true,
      lastCommitId: "c".repeat(40),
      executable: false,
      oldContent: "old\n",
    },
    { path: "docs/new.md", exists: false },
  ],
};

const ROWS = {
  github: {
    type: "github.file.commit",
    tool: "github_github_file_commit",
    input: GH_INPUT,
    reply: GH_REPLY,
    confirm: "github/commit acme/api@feat/x",
    prepareType: "github.write.prepare",
  },
  gitlab: {
    type: "gitlab.commit.create",
    tool: "gitlab_gitlab_commit_create",
    input: GL_INPUT,
    reply: GL_REPLY,
    confirm: "gitlab/commit grp/app@feat/x",
    prepareType: "gitlab.write.prepare",
  },
} as const;

type Which = keyof typeof ROWS;

function actionOf(which: Which, input: Record<string, unknown> = ROWS[which].input): PlannedAction {
  return {
    type: ROWS[which].type,
    origin: "model",
    payload: { mcpToolId: ROWS[which].tool, input },
  };
}

interface Opts {
  readonly which?: Which;
  readonly approve?: boolean;
  readonly typed?: string;
  readonly prepareReply?: () => unknown;
  readonly prepareThrows?: boolean;
}

function harness(o: Opts = {}) {
  const which = o.which ?? "github";
  const log: string[] = [];
  const prompts: string[] = [];
  const confirmed: ConfirmedApprovalRequest[] = [];
  const audits: Array<{ actionType: string; hitlStatus: string; actionJson: string }> = [];
  const egress: EgressEntry[] = [];
  const dispatched: PlannedAction[] = [];
  const sink: EgressSink = {
    append: (e) => {
      egress.push(e);
      log.push(`egress:${e.destination}:${e.resultStatus}`);
    },
  };
  const exec = new ToolExecutor(
    {
      requestApproval: async (prompt: string) => {
        prompts.push(prompt);
        log.push("prompt");
        return o.approve ?? true;
      },
      requestConfirmedApproval: async (req: ConfirmedApprovalRequest) => {
        confirmed.push(req);
        prompts.push(req.prompt);
        log.push("prompt:confirmed");
        return { approved: o.approve ?? true, typed: o.typed ?? ROWS[which].confirm };
      },
    },
    {
      recordAudit: (e) => {
        audits.push({
          actionType: e.actionType,
          hitlStatus: e.hitlStatus,
          actionJson: e.actionJson,
        });
        log.push(`audit:${e.actionType}:${e.hitlStatus}`);
      },
    },
    {
      dispatch: async (a) => {
        dispatched.push(a);
        log.push(`dispatch:${a.type}`);
        if (a.type.endsWith(".write.prepare")) {
          if (o.prepareThrows === true) throw new Error("secret connector message");
          return mcp(o.prepareReply === undefined ? ROWS[which].reply : o.prepareReply());
        }
        return { committed: true };
      },
    },
    undefined,
    sink,
    NO_POLICY_OVERLAY,
  );
  return { exec, log, prompts, confirmed, audits, egress, dispatched, which };
}

const writesOf = (h: { dispatched: PlannedAction[] }) =>
  h.dispatched.filter((a) => !a.type.endsWith(".write.prepare"));

function inputOf(a: PlannedAction | undefined): Record<string, unknown> {
  const nested = a?.payload?.["input"];
  return (nested ?? a?.payload) as Record<string, unknown>;
}

for (const which of ["github", "gitlab"] as const) {
  describe(`${ROWS[which].type} through the real table`, () => {
    test("prepares, shows the whole diff, takes the typed text, and dispatches with the gateway's head", async () => {
      const h = harness({ which });
      const r = await h.exec.execute(actionOf(which));
      expect(r).toEqual({ status: "ok", result: { committed: true } });
      const sent = writesOf(h);
      expect(sent).toHaveLength(1);
      expect(inputOf(sent[0])).toEqual({ ...ROWS[which].input, expectedHeadSha: HEAD });
      // The owner's prompt: the diff, the head as a prepared fact, and the typed-confirm line.
      expect(h.confirmed).toHaveLength(1);
      expect(h.prompts[0]).toContain("-old");
      expect(h.prompts[0]).toContain("+export const a = 2;");
      expect(h.prompts[0]).toContain("End of diff: 2 files, +2 -1");
      expect(h.prompts[0]).toContain(`Branch head: ${HEAD}`);
      expect(h.confirmed[0]?.confirmText).toBe(ROWS[which].confirm);
    });

    test("a prepare read is audited and ledgered BEFORE the write's own rows (I29), as <service>.write.prepare", async () => {
      const h = harness({ which });
      await h.exec.execute(actionOf(which));
      const service = which;
      expect(h.log).toEqual([
        `audit:${ROWS[which].prepareType}:not_required`,
        `egress:${service}:authorized`,
        `dispatch:${ROWS[which].prepareType}`,
        "prompt:confirmed",
        `audit:${ROWS[which].type}:approved`,
        `egress:${service}:authorized`,
        `dispatch:${ROWS[which].type}`,
      ]);
      const prepare = h.dispatched[0];
      expect(prepare?.type).toBe(ROWS[which].prepareType);
      // The prepare tool is sent the write's own keys and nothing else (no message, no head).
      const sentKeys = Object.keys(inputOf(prepare)).sort();
      expect(sentKeys).toEqual(
        which === "github"
          ? ["branch", "files", "owner", "repo"]
          : ["branch", "files", "projectPath"],
      );
    });

    test("a caller-supplied expectedHeadSha is refused before any read or prompt: at the input and at the root", async () => {
      for (const a of [
        actionOf(which, { ...ROWS[which].input, expectedHeadSha: "f".repeat(40) }),
        {
          ...actionOf(which),
          payload: {
            expectedHeadSha: "f".repeat(40),
            mcpToolId: ROWS[which].tool,
            input: ROWS[which].input,
          },
        } as PlannedAction,
      ]) {
        const h = harness({ which });
        const r = await h.exec.execute(a);
        expect(r.status).toBe("rejected");
        if (r.status === "rejected") expect(r.reason).toBe(PREPARE_REFUSALS.callerBound);
        expect(h.dispatched).toEqual([]);
        expect(h.prompts).toEqual([]);
        expect(h.egress.filter((e) => e.resultStatus === "authorized")).toEqual([]);
      }
    });

    test("an input over a commit limit is refused before any read or prompt (fixed reason)", async () => {
      const tooMany = Array.from({ length: 21 }, (_, i) => ({
        path: `f${String(i)}`,
        content: "x",
      }));
      const h = harness({ which });
      const r = await h.exec.execute(actionOf(which, { ...ROWS[which].input, files: tooMany }));
      expect(r.status).toBe("rejected");
      expect(h.dispatched).toEqual([]);
      expect(h.prompts).toEqual([]);
    });

    test("a failing, forged or unpairable prepare reply refuses with a fixed reason and no prompt", async () => {
      const cases: Array<[string, Opts, string]> = [
        ["a throw", { prepareThrows: true }, PREPARE_REFUSALS.failed],
        [
          "no head",
          { prepareReply: () => ({ files: ROWS[which].reply.files }) },
          PREPARE_REFUSALS.unbound,
        ],
        [
          "a short head",
          { prepareReply: () => ({ ...ROWS[which].reply, headSha: "abc" }) },
          PREPARE_REFUSALS.unbound,
        ],
        ["no files", { prepareReply: () => ({ headSha: HEAD }) }, PREPARE_REFUSALS.unshowable],
        [
          "a foreign path",
          {
            prepareReply: () => ({
              headSha: HEAD,
              files: [{ path: "other", exists: false, mode: "100644" }],
            }),
          },
          PREPARE_REFUSALS.unshowable,
        ],
        [
          "an oversize reply",
          { prepareReply: () => ({ ...ROWS[which].reply, pad: "x".repeat(262_144) }) },
          PREPARE_REFUSALS.replyTooLarge,
        ],
      ];
      for (const [name, o, reason] of cases) {
        const h = harness({ which, ...o });
        const r = await h.exec.execute(actionOf(which));
        expect(r.status, name).toBe("rejected");
        if (r.status === "rejected") {
          expect(r.reason, name).toBe(reason);
          expect(r.reason, name).not.toContain("secret");
        }
        expect(h.prompts, name).toEqual([]);
        expect(writesOf(h), name).toEqual([]);
      }
    });

    test("a reply that forges a diff cannot change what the owner sees", async () => {
      const h = harness({
        which,
        prepareReply: () => ({
          ...ROWS[which].reply,
          diff: "+++ FORGED",
          preview: "FORGED",
          hunks: ["FORGED"],
        }),
      });
      await h.exec.execute(actionOf(which));
      expect(h.prompts[0]).not.toContain("FORGED");
      expect(h.prompts[0]).toContain("+export const a = 2;");
    });

    test("a declined prompt dispatches no write; a mismatched typed text dispatches none", async () => {
      const declined = harness({ which, approve: false });
      expect((await declined.exec.execute(actionOf(which))).status).toBe("rejected");
      expect(writesOf(declined)).toEqual([]);
      const wrong = harness({ which, typed: "commit nothing" });
      const r = await wrong.exec.execute(actionOf(which));
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") expect(r.reason).toBe(CONFIRM_MISMATCH_REASON);
      expect(writesOf(wrong)).toEqual([]);
      // The prepare read ran in both cases and was ledgered.
      expect(declined.egress.filter((e) => e.resultStatus === "authorized")).toHaveLength(1);
    });

    test("the public gate() refuses the row: only execute() can bind it", async () => {
      const h = harness({ which });
      const r = await h.exec.gate(actionOf(which));
      expect(r).toEqual({ status: "rejected", reason: BOUND_VIA_GATE_REASON });
      expect(h.dispatched).toEqual([]);
    });

    test("an all-unchanged commit is refused as nothing to commit", async () => {
      const same = harness({
        which,
        prepareReply: () => ({
          ...ROWS[which].reply,
          files: [
            { ...ROWS[which].reply.files[0], oldContent: "export const a = 2;\n" },
            {
              ...ROWS[which].reply.files[1],
              exists: true,
              oldContent: "# New\n",
              executable: false,
              mode: "100644",
            },
          ],
        }),
      });
      const r = await same.exec.execute(actionOf(which));
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") expect(r.reason).toBe(PREPARE_REFUSALS.nothingToCommit);
      expect(same.prompts).toEqual([]);
    });

    test("the audit row of a 31 KiB commit holds its file count and size, never the file text, and parses", async () => {
      const files = [{ path: "big.txt", content: "line of text\n".repeat(2400) }];
      const reply = {
        headSha: HEAD,
        files: [
          which === "github"
            ? { path: "big.txt", exists: true, mode: "100644", oldContent: "small\n" }
            : { path: "big.txt", exists: true, executable: false, oldContent: "small\n" },
        ],
      };
      const h = harness({ which, prepareReply: () => reply });
      const r = await h.exec.execute(actionOf(which, { ...ROWS[which].input, files }));
      expect(r.status).toBe("ok");
      const json = h.audits.at(-1)?.actionJson ?? "";
      expect(json).not.toContain("line of text");
      expect(json.length).toBeLessThan(4096);
      const audit = JSON.parse(json) as { action: { payload: { input: Record<string, unknown> } } };
      expect(audit.action.payload.input["files"]).toEqual({ count: 1, contentBytes: 31_200 });
    });

    test("the audit row of a 32 KiB commit stays within the audit cap, carries the digests, and holds no file text", async () => {
      const big = "line of text\n".repeat(2400); // about 31 KiB
      const files = [{ path: "big.txt", content: big }];
      const input = { ...ROWS[which].input, files, message: "m".repeat(5000) };
      const reply = {
        headSha: HEAD,
        files: [
          which === "github"
            ? { path: "big.txt", exists: true, mode: "100644", oldContent: "small\n" }
            : { path: "big.txt", exists: true, executable: false, oldContent: "small\n" },
        ],
      };
      const h = harness({ which, prepareReply: () => reply });
      const r = await h.exec.execute(actionOf(which, input));
      expect(r.status).toBe("ok");
      const last = h.audits.at(-1);
      expect(last?.actionType).toBe(ROWS[which].type);
      const json = last?.actionJson ?? "";
      // The cap cuts at 4096 characters and appends a short marker; a 5000-character message makes
      // the row hit it, so the digests must already be in the row's first characters.
      expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(4096 + 15);
      expect(json.startsWith('{"boundValuesSha256":"')).toBe(true);
      expect(json.slice(0, 400)).toMatch(
        /"boundValuesSha256":"[0-9a-f]{64}","diffSha256":"[0-9a-f]{64}","filesSha256":"[0-9a-f]{64}","action":/,
      );
      expect(last?.actionJson).not.toContain("line of text");
      expect(last?.actionJson).not.toContain(HEAD);
      // filesSha256 covers the EXACT files dispatched, in order, length-prefixed.
      const sent = inputOf(writesOf(h)[0])["files"] as Array<{ path: string; content: string }>;
      expect(json).toContain(`"filesSha256":"${commitFilesDigest({ files: sent })}"`);
    });

    test("neither the ledger rows nor the audit rows hold file text, for the prepare read and the write", async () => {
      const secret = "UNIQUE-FILE-TEXT-MARKER";
      const files = [{ path: "src/a.ts", content: `const x = "${secret}";\n` }];
      const reply = {
        headSha: HEAD,
        files: [
          which === "github"
            ? { path: "src/a.ts", exists: true, mode: "100644", oldContent: "old\n" }
            : { path: "src/a.ts", exists: true, executable: false, oldContent: "old\n" },
        ],
      };
      const h = harness({ which, prepareReply: () => reply });
      const r = await h.exec.execute(actionOf(which, { ...ROWS[which].input, files }));
      expect(r.status).toBe("ok");
      // two ledger rows: the prepare read and the write
      expect(h.egress.map((e) => e.method)).toEqual([`${which}.write.prepare`, ROWS[which].type]);
      for (const e of h.egress) {
        expect(e.payloadSummary, e.method).not.toContain(secret);
        expect(e.payloadSummary, e.method).toContain('"contentBytes"');
      }
      for (const a of h.audits) expect(a.actionJson, a.actionType).not.toContain(secret);
    });
  });
}
