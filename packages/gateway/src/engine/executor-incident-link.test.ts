// Phase 10 IC4: the incident link on an action (spec § 5.4, I20, I29, static D46(e)). The link is a join
// key the executor records first in the audit row and in the egress summary; a linked action is the local
// owner's own (never delegated, never standing-approved, never an outside origin), and the gate records the
// exact prompt the owner was shown, for a LINKED action only (OR-IC4-2).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  SYNTH_PREPARE_IDS,
  SYNTH_REPLY,
  synthBoundRow,
} from "../connectors/connector-writes/bound-fixtures.test-helpers.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  baseScenario,
  ruleCounters,
} from "../connectors/connector-writes/standing-scenarios.test-helpers.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { BeforeStateRunner } from "./before-state.ts";
import type { RemoteApprovalOutcome } from "./delegated-approval.ts";
import { DelegationStore } from "./delegation-store.ts";
import {
  type ExecutorDelegationDep,
  NO_POLICY_OVERLAY,
  ToolExecutor,
  type WriteTable,
} from "./executor.ts";
import { IncidentLinkError } from "./incident-link.ts";
import type {
  ConfirmedApprovalRequest,
  ConfirmedApprovalResult,
  ConsentChannel,
  PlannedAction,
} from "./types.ts";

const LINK = Object.freeze({ id: "inc_0123456789abcdef", version: 2 });
const OTHER_LINK = Object.freeze({ id: "inc_fedcba9876543210", version: 7 });
const PREFIX = '{"incident":{"id":"inc_0123456789abcdef","version":2}';

const MERGE_TEXT = "github/merge acme/api#42";
const MERGE: PlannedAction = {
  type: "github.pr.merge",
  payload: { mcpToolId: "github_pr_merge", input: { owner: "acme", repo: "api", pullNumber: 42 } },
};
const PLAIN: PlannedAction = { type: "email.send", payload: { to: "a@b.c" } };
const NOT_HITL: PlannedAction = { type: "search.run", payload: { q: "x" } };

type Audit = { actionType: string; hitlStatus: string; actionJson: string };

interface Harness {
  readonly exec: ToolExecutor;
  readonly prompts: string[];
  readonly confirmed: ConfirmedApprovalRequest[];
  readonly audits: Audit[];
  readonly egress: EgressEntry[];
  readonly dispatched: PlannedAction[];
}

interface Options {
  readonly approve?: boolean;
  readonly typed?: string;
  readonly delegation?: ExecutorDelegationDep;
  readonly runner?: BeforeStateRunner;
  readonly table?: WriteTable;
  readonly standing?: ConstructorParameters<typeof ToolExecutor>[7];
  readonly onPrepare?: () => unknown;
}

function harness(o: Options = {}): Harness {
  const prompts: string[] = [];
  const confirmed: ConfirmedApprovalRequest[] = [];
  const audits: Audit[] = [];
  const egress: EgressEntry[] = [];
  const dispatched: PlannedAction[] = [];
  const consent: ConsentChannel = {
    requestApproval: async (prompt) => {
      prompts.push(prompt);
      return { approved: o.approve ?? true, answerSource: "human" as const };
    },
    requestConfirmedApproval: async (req): Promise<ConfirmedApprovalResult> => {
      confirmed.push(req);
      return {
        approved: o.approve ?? true,
        typed: o.typed ?? MERGE_TEXT,
        answerSource: "human" as const,
      };
    },
  };
  const sink: EgressSink = { append: (e) => egress.push(e) };
  const exec = new ToolExecutor(
    consent,
    {
      recordAudit: (e) =>
        audits.push({
          actionType: e.actionType,
          hitlStatus: e.hitlStatus,
          actionJson: e.actionJson,
        }),
    },
    {
      dispatch: async (a) => {
        dispatched.push(a);
        if (a.type.endsWith(".write.prepare")) return SYNTH_REPLY;
        return { ok: true };
      },
    },
    o.delegation,
    sink,
    NO_POLICY_OVERLAY,
    undefined,
    o.standing ?? { beforeState: o.runner, userMcpWriteGrants: () => [] },
    o.table,
  );
  return { exec, prompts, confirmed, audits, egress, dispatched };
}

const linked = (
  a: PlannedAction,
  link: NonNullable<PlannedAction["incident"]> = LINK,
): PlannedAction => ({
  ...a,
  incident: link,
});

const rowOf = (h: Harness, i = h.audits.length - 1): string => h.audits[i]?.actionJson ?? "";

describe("2.4 a linked action is the owner's own (refused before any row)", () => {
  const outside: [string, Partial<PlannedAction>][] = [
    ["origin model", { origin: "model" }],
    ["origin agent", { origin: "agent" }],
    [
      "a proposer",
      {
        proposer: {
          door: "agent",
          captureId: "cap_0123456789abcdef0123456789abcdef",
          label: null,
          labelSource: "declared",
          summary: "s",
          createdAt: 0,
          expiresAt: 1,
        },
      },
    ],
    [
      "a workflow provenance",
      {
        provenance: {
          kind: "owner_workflow",
          workflowId: "w",
          workflowSha256: "0".repeat(64),
          stepIndex: 0,
          runId: "r",
          trigger: "owner_cli",
          fieldSources: {},
        },
      },
    ],
  ];
  for (const [name, extra] of outside) {
    test(`a linked action carrying ${name} throws before any audit row, egress row or dispatch`, async () => {
      const h = harness();
      await expect(h.exec.execute({ ...linked(PLAIN), ...extra })).rejects.toThrow(
        IncidentLinkError,
      );
      await expect(h.exec.gate({ ...linked(PLAIN), ...extra })).rejects.toThrow(IncidentLinkError);
      expect(h.audits).toHaveLength(0);
      expect(h.egress).toHaveLength(0);
      expect(h.dispatched).toHaveLength(0);
      expect(h.prompts).toHaveLength(0);
    });
  }

  test("a malformed link throws before any row", async () => {
    const h = harness();
    for (const bad of [
      { id: "nope", version: 1 },
      { id: LINK.id, version: 0 },
      { id: LINK.id, version: 1, extra: 1 },
    ]) {
      await expect(
        h.exec.execute({
          ...PLAIN,
          incident: bad as unknown as NonNullable<PlannedAction["incident"]>,
        }),
      ).rejects.toThrow(IncidentLinkError);
    }
    expect(h.audits).toHaveLength(0);
    expect(h.egress).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("2.5 a linked action is never delegated (I20)", () => {
  function delegated(): { dep: ExecutorDelegationDep; asked: { n: number } } {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const store = new DelegationStore(db);
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "action_type",
      scopeValue: "email.send",
      expiresAt: 9e15,
      nowMs: 1,
    });
    const asked = { n: 0 };
    const dep: ExecutorDelegationDep = {
      store,
      isOperatorValid: () => true,
      requestRemote: async (): Promise<RemoteApprovalOutcome> => {
        asked.n += 1;
        return { kind: "answered", peerId: "peer:bob", approved: true };
      },
    };
    return { dep, asked };
  }

  test("control: an UNLINKED action with the same delegate is delegated", async () => {
    const d = delegated();
    const h = harness({ delegation: d.dep });
    await h.exec.execute(PLAIN);
    expect(d.asked.n).toBe(1);
    expect(h.prompts).toHaveLength(0);
  });

  test("a linked action with a delegate that would approve still prompts the local owner; the delegate is never asked", async () => {
    const d = delegated();
    const h = harness({ delegation: d.dep });
    const r = await h.exec.execute(linked(PLAIN));
    expect(r.status).toBe("ok");
    expect(d.asked.n).toBe(0);
    expect(h.prompts).toHaveLength(1);
  });
});

describe("2.6 a linked action never matches a standing rule (I55)", () => {
  test("a live standing-rule dependency set is consulted but never reaches a rule, a refusal or a claim", async () => {
    const calls = { policy: 0, refusal: 0 };
    const h = harness({
      standing: {
        // A bare in-memory database: a rule lookup (step 6) or a claim (step 9) would throw on the missing tables.
        standingRules: {
          db: new Database(":memory:"),
          policyAllows: () => {
            calls.policy += 1;
            return true;
          },
          refusal: () => {
            calls.refusal += 1;
            return undefined;
          },
        },
        userMcpWriteGrants: () => [],
      },
    });
    const r = await h.exec.execute(linked(PLAIN));
    expect(r.status).toBe("ok");
    expect(calls.policy).toBe(1);
    expect(calls.refusal).toBe(0);
    expect(h.prompts).toHaveLength(1);
    expect(h.audits.at(-1)?.hitlStatus).toBe("approved");
    expect(rowOf(h)).not.toContain("standingRule");
  });
});

describe("2.6b a linked action that ALSO matches a live standing rule is refused, never standing-approved (I55)", () => {
  test("control: the same action without the link IS standing-approved; with the link nothing is recorded and nothing is claimed", async () => {
    const control = baseScenario();
    const hc = harness({ standing: { standingRules: control.deps, userMcpWriteGrants: () => [] } });
    const ok = await hc.exec.execute(control.action);
    expect(ok.status).toBe("ok");
    expect(hc.audits.at(-1)?.hitlStatus).toBe("standing_approved");
    expect(hc.prompts).toHaveLength(0);

    const s = baseScenario();
    const h = harness({ standing: { standingRules: s.deps, userMcpWriteGrants: () => [] } });
    await expect(h.exec.execute({ ...s.action, incident: LINK })).rejects.toThrow(
      IncidentLinkError,
    );
    expect(h.audits).toHaveLength(0);
    expect(h.egress).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(ruleCounters(s)).toEqual({ used: 0, fires: 0 });
  });
});

describe("2.7 the link is the action's own top-level field only", () => {
  test("a payload-nested `incident` key is no link and changes nothing about the gate", async () => {
    const h = harness();
    await h.exec.execute({ type: "email.send", payload: { to: "a@b.c", incident: LINK } });
    expect(rowOf(h).startsWith('{"incident"')).toBe(false);
    expect(h.egress[0]?.payloadSummary.startsWith('{"incident"')).toBe(false);
    // the payload's own key stays inside `action` for the unlinked action
    expect(rowOf(h)).toContain('"payload":{"to":"a@b.c","incident":{"id"');
  });
});

describe("4.4 an `incident` inside a tool's input is the tool's own argument, never the link", () => {
  test("it reaches the connector unchanged and the row has no link", async () => {
    const h = harness();
    const action: PlannedAction = {
      type: "search.run",
      payload: { mcpToolId: "search_run", input: { incident: LINK, q: "x" } },
    };
    await h.exec.execute(action);
    expect(h.dispatched[0]?.payload).toEqual(action.payload);
    expect(h.dispatched[0]?.incident).toBeUndefined();
    expect(rowOf(h).startsWith('{"incident"')).toBe(false);
    expect(h.egress[0]?.payloadSummary.startsWith(PREFIX)).toBe(false);
  });
});

describe("3.1 the audit row starts with the link, whatever the verdict", () => {
  test("approved, rejected and not_required rows all start at offset 0", async () => {
    const approved = harness();
    await approved.exec.execute(linked(PLAIN));
    expect(rowOf(approved).startsWith(PREFIX)).toBe(true);
    const rejected = harness({ approve: false });
    await rejected.exec.execute(linked(PLAIN));
    expect(rejected.audits.at(-1)?.hitlStatus).toBe("rejected");
    expect(rowOf(rejected).startsWith(PREFIX)).toBe(true);
    const plain = harness();
    await plain.exec.execute(linked(NOT_HITL));
    expect(plain.audits.at(-1)?.hitlStatus).toBe("not_required");
    expect(rowOf(plain).startsWith(PREFIX)).toBe(true);
    // a not-prompted row has no prompt keys
    expect(rowOf(plain)).not.toContain("promptSha256");
  });

  test("3.4 the link appears exactly once in the stored row", async () => {
    const h = harness();
    await h.exec.execute(linked(PLAIN));
    expect(rowOf(h).split("inc_0123456789abcdef")).toHaveLength(2);
    expect(rowOf(h)).toContain('"action":{"type":"email.send"');
  });
});

describe("3.2 / 2.7 a sub-step carries the parent's link and no prompt keys", () => {
  /** A before-state runner that makes one gated, dispatched read for any action (the real runner's shape). */
  const readOnce: BeforeStateRunner = {
    rows: CONNECTOR_WRITE_ROWS,
    read: async (_action, ops) => {
      const read: PlannedAction = {
        type: "email.before.read",
        payload: { mcpToolId: "email_get" },
      };
      const g = await ops.gate(read);
      if (g === "proceed") await ops.dispatch(read);
      return undefined;
    },
  };

  test("a before-state read of a linked write carries the same link and no prompt keys; of an unlinked write, none", async () => {
    const h = harness({ runner: readOnce });
    // the runner only runs for rows with a preview; use a templated write
    await h.exec.execute(
      linked({
        type: "jira.issue.create",
        payload: { mcpToolId: "jira_issue_create", input: { projectKey: "ENG", summary: "s" } },
      }),
    );
    const reads = h.audits.filter((a) => a.actionType === "email.before.read");
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(r.actionJson.startsWith(`${PREFIX},"subStep":true,"action"`)).toBe(true);
      expect(r.actionJson).not.toContain("promptSha256");
    }
    const u = harness({ runner: readOnce });
    await u.exec.execute({
      type: "jira.issue.create",
      payload: { mcpToolId: "jira_issue_create", input: { projectKey: "ENG", summary: "s" } },
    });
    for (const a of u.audits) expect(a.actionJson.startsWith('{"incident"')).toBe(false);
  });

  test("a prepare read of a linked bound write carries the link; the write's own row has the prompt keys", async () => {
    const table: WriteTable = { rows: [synthBoundRow(3)], prepareToolIds: SYNTH_PREPARE_IDS };
    const h = harness({ table, typed: "iac/prod" });
    const action: PlannedAction = {
      type: "iac.terraform.apply",
      payload: { mcpToolId: "iac_synth_apply", input: { dir: "prod" } },
    };
    const r = await h.exec.execute(linked(action));
    expect(r.status).toBe("ok");
    const prepare = h.audits.filter((a) => a.actionType.endsWith(".write.prepare"));
    expect(prepare.length).toBeGreaterThan(0);
    for (const p of prepare) {
      expect(p.actionJson.startsWith(`${PREFIX},"subStep":true,"action"`)).toBe(true);
      expect(p.actionJson).not.toContain("promptSha256");
    }
    const write = h.audits.find((a) => a.actionType === "iac.terraform.apply");
    expect(write?.actionJson.startsWith(PREFIX)).toBe(true);
    // the write's own row is a gate row: no sub-step marker
    expect(write?.actionJson).not.toContain('"subStep"');
    expect(write?.actionJson).toContain('"promptSha256"');
    // the ledger rows of the sub-steps carry the link too
    const ledger = h.egress.filter((e) => e.method.endsWith(".write.prepare"));
    expect(ledger.length).toBeGreaterThan(0);
    for (const e of ledger) expect(e.payloadSummary.startsWith('{"incident"')).toBe(true);
  });
});

describe("3.7 the prompt the owner was shown is what the row hashes", () => {
  const sha = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");
  const parse = (h: Harness): Record<string, unknown> =>
    JSON.parse(rowOf(h)) as Record<string, unknown>;

  test("a plain approval: promptSha256 is the SHA-256 of the string the channel received", async () => {
    const h = harness();
    await h.exec.execute(linked(PLAIN));
    const row = parse(h);
    expect(row["promptSha256"]).toBe(sha(h.prompts[0] ?? ""));
    expect(row["prompt"]).toBe(h.prompts[0]);
    expect("promptCut" in row).toBe(false);
  });

  test("a Wave 4 row: the hash includes the typed-confirm line the channel received", async () => {
    const h = harness();
    await h.exec.execute(linked(MERGE));
    const shown = h.confirmed[0]?.prompt ?? "";
    expect(shown).toContain(MERGE_TEXT);
    expect(shown.endsWith(`type exactly: ${MERGE_TEXT}`) || shown.includes(MERGE_TEXT)).toBe(true);
    const row = parse(h);
    expect(row["promptSha256"]).toBe(sha(shown));
    expect(String(row["prompt"])).toContain(MERGE_TEXT);
    expect(row["confirm"]).toBe("matched");
  });

  test("a denied prompt still records what was shown", async () => {
    const h = harness({ approve: false });
    await h.exec.execute(linked(PLAIN));
    expect(parse(h)["promptSha256"]).toBe(sha(h.prompts[0] ?? ""));
  });

  test("an UNLINKED Wave 4 action: the channel gets the same bytes as before, and the row has no prompt keys", async () => {
    const h = harness();
    await h.exec.execute(MERGE);
    const shown = h.confirmed[0]?.prompt ?? "";
    expect(shown.split("\n\n").at(-1)).toContain(MERGE_TEXT);
    expect(rowOf(h)).not.toContain("promptSha256");
    expect(rowOf(h)).not.toContain('"prompt"');
  });
});

describe("3.3 an unlinked action's rows are byte-identical to before", () => {
  test("golden rows for a plain, a workflow and an agent-door-shaped action", async () => {
    const plain = harness();
    await plain.exec.execute(PLAIN);
    expect(rowOf(plain)).toBe(
      '{"action":{"type":"email.send","payload":{"to":"a@b.c"}},"answerSource":"human"}',
    );
    expect(plain.egress[0]?.payloadSummary).toBe('{"to":"a@b.c"}');
    const wf = harness();
    await wf.exec.execute({
      type: "email.send",
      payload: { to: "a@b.c" },
      provenance: {
        kind: "owner_workflow",
        workflowId: "w",
        workflowSha256: "0".repeat(64),
        stepIndex: 1,
        runId: "r",
        trigger: "owner_cli",
        fieldSources: {},
      },
    });
    expect(rowOf(wf)).toBe(
      '{"action":{"type":"email.send","provenance":{"kind":"owner_workflow","workflowId":"w","workflowSha256":"0000000000000000000000000000000000000000000000000000000000000000","stepIndex":1,"runId":"r","trigger":"owner_cli"},"payload":{"to":"a@b.c"}},"answerSource":"human"}',
    );
    const model = harness();
    await model.exec.execute({ ...PLAIN, origin: "model" });
    expect(rowOf(model)).toBe(
      '{"action":{"type":"email.send","payload":{"to":"a@b.c"},"origin":"model"},"answerSource":"human"}',
    );
    const w4 = harness();
    await w4.exec.execute(MERGE);
    expect(rowOf(w4)).toBe(
      '{"action":{"type":"github.pr.merge","payload":{"mcpToolId":"github_pr_merge","input":{"owner":"acme","repo":"api","pullNumber":42}}},"answerSource":"human","confirm":"matched"}',
    );
  });
});

describe("3.5 the stored prompt is capped by its ESCAPED length, so the link and the hash are never cut", () => {
  const rowFor = async (body: string): Promise<{ row: string; shown: string }> => {
    const h = harness();
    await h.exec.execute(linked({ type: "email.send", payload: { body } }));
    return { row: rowOf(h), shown: h.prompts[0] ?? "" };
  };

  test("a 3,000 character prompt is cut, flagged, and the action tail (not the keys before it) is what the row cap cuts", async () => {
    const { row } = await rowFor("x".repeat(3000));
    expect(row.startsWith(PREFIX)).toBe(true);
    expect(row).toContain('"promptCut":true');
    const idx = row.indexOf('"prompt":"');
    expect(row.indexOf('"promptSha256"')).toBeGreaterThan(0);
    expect(idx).toBeGreaterThan(row.indexOf('"promptSha256"'));
    // the 4,096-character row cap cut the TAIL (the action's payload), never the keys before it
    expect(row.endsWith("…[truncated]")).toBe(true);
    expect(row.indexOf('"action":{"type":"email.send"')).toBeGreaterThan(idx);
  });

  test("a prompt of 1,000 control characters is cut by ESCAPED length and the row still holds the action type", async () => {
    const { row } = await rowFor("\u0001".repeat(1000));
    expect(row.startsWith(PREFIX)).toBe(true);
    expect(row).toContain('"promptCut":true');
    expect(row.length).toBeLessThanOrEqual(4096 + "…[truncated]".length);
    expect(row).toContain('"promptSha256"');
  });

  test("a 1,200 character multibyte prompt is not cut", async () => {
    const { row } = await rowFor("é".repeat(400));
    expect(row).not.toContain("promptCut");
  });
});

describe("3.8 redaction of the stored prompt", () => {
  test("a credential-shaped substring is stored as [REDACTED] while the hash is of the shown text; link keys survive", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const h = harness();
    await h.exec.execute(linked({ type: "email.send", payload: { note: secret } }));
    const row = JSON.parse(rowOf(h)) as Record<string, unknown>;
    expect(String(row["prompt"])).toContain("[REDACTED]");
    expect(String(row["prompt"])).not.toContain(secret);
    expect(row["promptSha256"]).toBe(
      new Bun.CryptoHasher("sha256").update(h.prompts[0] ?? "").digest("hex"),
    );
    expect(row["incident"]).toEqual({ id: LINK.id, version: LINK.version });
    expect(String(h.prompts[0])).toContain(secret);
  });
});

describe("3.9 the egress summary head", () => {
  test("a linked action's summary starts with the link", async () => {
    const h = harness();
    await h.exec.execute(linked(PLAIN));
    expect(h.egress[0]?.payloadSummary.startsWith(PREFIX)).toBe(true);
  });

  test("a payload `incident` key cannot replace the head's link (round-1 finding 2) and is absent from the summary", async () => {
    const h = harness();
    await h.exec.execute(
      linked({
        type: "email.send",
        payload: { incident: { id: "inc_spoofed", version: 99 }, to: "a@b.c" },
      }),
    );
    const s = h.egress[0]?.payloadSummary ?? "";
    expect(s.startsWith(PREFIX)).toBe(true);
    expect(s).not.toContain("inc_spoofed");
    expect(s).not.toContain("99");
  });

  test("two different links are two different heads", async () => {
    const a = harness();
    await a.exec.execute(linked(PLAIN, OTHER_LINK));
    expect(
      a.egress[0]?.payloadSummary.startsWith(
        '{"incident":{"id":"inc_fedcba9876543210","version":7}',
      ),
    ).toBe(true);
  });
});
