/**
 * Phase 28 AD1: the MCP act door runs on the door executor. What these tests pin is the DELTA and its
 * limits. The owner now sees the executor's own prompt with the target's current state, and the
 * proposer as an UNVERIFIED trailing block; what an outside agent can PROPOSE did not move: the 47
 * proposable types, the tool each routes to and the payload each dispatches are exactly what they
 * were before the executor was shared, no proposable type is Wave 4, and the agent origin gets no
 * delegate and no standing rule.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { KNOWLEDGE_BASE_CHILD_REFUSAL } from "../connectors/connector-writes/model-write-refusals.ts";
import {
  ACTION_PROPOSABILITY,
  PROPOSABLE_WRITE_TOOLS,
  proposableWriteTool,
} from "../connectors/proposable-actions.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { makeEgressSink } from "../egress/egress-ledger.ts";
import { isBeforeReadActionType } from "../engine/before-state.ts";
import { NO_POLICY_OVERLAY } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { buildActDeps, type CaptureActWiring } from "./capture-rpc.ts";
import type { ConsentCoordinator } from "./consent.ts";

/**
 * `PROPOSABLE_WRITE_TOOLS` as it stood on `main` BEFORE the act door moved onto the door executor
 * (generated once from that tree, 47 entries). AD1 changes no routing row; AD3b is the slice that
 * flips this table.
 */
const PRE_AD1_ROUTING: Readonly<Record<string, string>> = {
  "slack.message.post": "slack_message_post",
  "teams.message.post": "teams_message_post",
  "teams.message.postChat": "teams_message_post_chat",
  "gmail.draft.create": "gmail_draft_create",
  "gmail.draft.send": "gmail_draft_send",
  "gmail.message.send": "gmail_message_send",
  "outlook.mail.send": "outlook_mail_send",
  "fastmail.mail.send": "fastmail_mail_send",
  "imap.mail.send": "imap_mail_send",
  "protonmail.mail.send": "protonmail_mail_send",
  "apple.mail.send": "apple_mail_send",
  "apple.mail.draft.create": "apple_mail_draft_create",
  "outlook.calendar.create": "outlook_calendar_create",
  "apple.calendar.event.create": "apple_calendar_event_create",
  "linear.issue.create": "linear_issue_create",
  "linear.issue.update": "linear_issue_update",
  "linear.comment.create": "linear_comment_create",
  "jira.issue.create": "jira_issue_create",
  "jira.issue.update": "jira_issue_update",
  "jira.comment.add": "jira_comment_add",
  "github.issue.create": "github_issue_create",
  "github.branch.create": "github_branch_create",
  "github.pr.create": "github_pr_create",
  "gitlab.branch.create": "gitlab_branch_create",
  "gitlab.mr.create": "gitlab_mr_create",
  "github.issue.comment.create": "github_issue_comment_create",
  "gitlab.issue.note.create": "gitlab_issue_note_create",
  "gitlab.mr.note.create": "gitlab_mr_note_create",
  "discord.message.post": "discord_message_post",
  "github.issue.labels.add": "github_issue_labels_add",
  "github.issue.assignees.add": "github_issue_assignees_add",
  "github.issue.state.set": "github_issue_state_set",
  "gitlab.issue.create": "gitlab_issue_create",
  "gitlab.issue.labels.add": "gitlab_issue_labels_add",
  "gitlab.issue.assignees.add": "gitlab_issue_assignees_add",
  "gitlab.issue.state.set": "gitlab_issue_state_set",
  "notion.page.create": "notion_page_create",
  "notion.page.update": "notion_page_update",
  "notion.block.append": "notion_block_append",
  "notion.comment.create": "notion_comment_create",
  "confluence.page.create": "confluence_page_create",
  "confluence.page.update": "confluence_page_update",
  "confluence.comment.add": "confluence_comment_add",
  "outlook.draft.create": "outlook_draft_create",
  "confluence.page.append": "confluence_page_append",
  "google_drive.file.create": "gdrive_file_create",
  "obsidian.note.append": "obsidian_append_to_daily_note",
};

const MAIL_SENDS = [
  "gmail.draft.send",
  "gmail.message.send",
  "outlook.mail.send",
  "fastmail.mail.send",
  "imap.mail.send",
  "protonmail.mail.send",
  "apple.mail.send",
];

const PROV = {
  captureId: "cap_ad1",
  clientLabel: "agent",
  createdAt: 0,
  expiresAt: 60_000,
  summary: "why",
};

const JIRA_REPLY = {
  key: "NIM-1",
  fields: { summary: "Fix login", status: { name: "In Progress" }, issuetype: { name: "Bug" } },
};

let db: Database;
beforeEach(() => {
  db = openMigratedMemoryDb();
});
afterEach(() => {
  db.close();
});

interface Harness {
  readonly act: ReturnType<typeof buildActDeps>;
  readonly dispatched: PlannedAction[];
  readonly prompts: Array<{ prompt: string; details: Record<string, unknown> | undefined }>;
}

function harness(
  opts: {
    readonly reply?: (a: PlannedAction) => unknown;
    readonly kb?: CaptureActWiring["getTribalKbConfig"];
    readonly approve?: boolean;
  } = {},
): Harness {
  const dispatched: PlannedAction[] = [];
  const prompts: Harness["prompts"] = [];
  const coord = {
    requestConsent: (_c: string, req: { prompt: string; details?: Record<string, unknown> }) => {
      prompts.push({ prompt: req.prompt, details: req.details });
      return Promise.resolve({ approved: opts.approve ?? true, answerSource: "human" as const });
    },
  } as unknown as ConsentCoordinator;
  const w: CaptureActWiring = {
    dispatcher: {
      dispatch: (a) => {
        dispatched.push(a);
        if (opts.reply !== undefined) return Promise.resolve(opts.reply(a));
        return isBeforeReadActionType(a.type)
          ? Promise.reject(new Error("no read in this fixture"))
          : Promise.resolve({ url: "https://x" });
      },
    },
    egressSink: makeEgressSink(db),
    audit: { recordAudit: (e) => appendAuditEntry(db, e) },
    policyHitl: NO_POLICY_OVERLAY,
    getTribalKbConfig: opts.kb ?? (() => undefined),
  };
  return { act: buildActDeps(w, coord, "c-cli"), dispatched, prompts };
}

describe("the legacy baseline (the deprecation window of AD3a-2a): the 47 proposable types are the 47 they were", () => {
  const proposable = Object.entries(ACTION_PROPOSABILITY)
    .filter(([, v]) => v.kind === "proposable")
    .map(([t]) => t);

  test("the proposable set and the routing table are exactly the pre-AD1 snapshot", () => {
    expect(proposable.sort()).toEqual(Object.keys(PRE_AD1_ROUTING).sort());
    expect(proposable).toHaveLength(47);
    expect({ ...PROPOSABLE_WRITE_TOOLS }).toEqual(PRE_AD1_ROUTING);
    // The seven mail sends stay proposable in AD1 (AD3b is the slice that refuses them).
    for (const t of MAIL_SENDS) expect(ACTION_PROPOSABILITY[t]?.kind, t).toBe("proposable");
  });

  test("no baseline type is Wave 4 (a Wave 4 row is reachable only on the approved basis, I58)", () => {
    for (const t of proposable) {
      for (const row of CONNECTOR_WRITE_ROWS.filter((r) => r.actionType === t)) {
        expect(row.wave, t).toBeLessThan(4);
        expect(row.bound, t).toBeUndefined();
      }
    }
  });

  test("the denied and not-yet-offered types are still not proposable", () => {
    for (const t of ["github.pr.merge", "jira.issue.transition", "iac.terraform.apply"]) {
      expect(ACTION_PROPOSABILITY[t]?.kind, t).not.toBe("proposable");
    }
  });

  test("for every proposable type: the dispatched tool and payload are the routing table's and the input, byte for byte", async () => {
    for (const [type, tool] of Object.entries(PRE_AD1_ROUTING)) {
      const h = harness();
      const input = { marker: `in-${type}` };
      const out = await h.act.execute(type, input, PROV);
      expect(out.status, type).toBe("ok");
      const writes = h.dispatched.filter((a) => !isBeforeReadActionType(a.type));
      expect(writes, type).toHaveLength(1);
      expect(writes[0]?.type, type).toBe(type);
      expect(writes[0]?.payload, type).toEqual({ mcpToolId: tool, input });
      expect(proposableWriteTool(type), type).toBe(tool);
      // One approval at the owner's session, per proposal.
      expect(h.prompts, type).toHaveLength(1);
      expect(writes[0]?.origin, type).toBe("agent");
      expect(writes[0]?.proposer?.captureId, type).toMatch(/^cap_[A-Za-z0-9_-]+$/);
    }
  });

  test("an input that tries to pick the tool, the origin or the proposer is inert: the routing table decides", async () => {
    const h = harness();
    const input = {
      mcpToolId: "github_pr_merge",
      origin: "model",
      proposer: { label: "owner" },
      text: "hi",
    };
    await h.act.execute("slack.message.post", input, PROV);
    const write = h.dispatched.find((a) => a.type === "slack.message.post");
    expect(write?.payload).toEqual({ mcpToolId: "slack_message_post", input });
    expect(write?.origin).toBe("agent");
    expect(write?.proposer?.label).toBe("agent");
    expect(h.prompts[0]?.prompt).toContain("Requested by: an outside agent (unverified)");
  });
});

describe("the act door now reads the target's current state (the model door's runner)", () => {
  test("a row with a reader: one gated, audited, ledgered before-read, shown in the prompt, then ONE write", async () => {
    const h = harness({
      reply: (a) => (isBeforeReadActionType(a.type) ? JIRA_REPLY : { url: "https://x" }),
    });
    const out = await h.act.execute("jira.comment.add", { issueKey: "NIM-1", body: "hello" }, PROV);
    expect(out.status).toBe("ok");
    expect(h.dispatched.map((a) => a.type)).toEqual(["jira.before.read", "jira.comment.add"]);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]?.prompt).toContain("Fix login");
    expect(h.prompts[0]?.prompt).toContain("Requested by: an outside agent (unverified)");
    // The read itself carries no origin or proposer of the agent's, and takes no prompt.
    expect(h.dispatched[0]?.origin).toBeUndefined();
    expect(h.dispatched[0]?.proposer).toBeUndefined();
    const egress = db.query("SELECT method, result_status FROM egress_ledger ORDER BY id").all();
    expect(egress).toHaveLength(2);
    const audits = db
      .query("SELECT action_type, hitl_status FROM audit_log ORDER BY id")
      .all() as Array<{ action_type: string; hitl_status: string }>;
    expect(audits).toEqual([
      { action_type: "jira.before.read", hitl_status: "not_required" },
      { action_type: "jira.comment.add", hitl_status: "approved" },
    ]);
  });

  test("the audit row of the write names the door and the capture, never the agent's words", async () => {
    const h = harness();
    await h.act.execute("slack.message.post", { text: "hi" }, { ...PROV, summary: "SENTINEL-77" });
    const row = db
      .query("SELECT action_json FROM audit_log WHERE action_type = 'slack.message.post'")
      .get() as { action_json: string };
    const action = (JSON.parse(row.action_json) as { action: Record<string, unknown> }).action;
    expect(action["origin"]).toBe("agent");
    expect(action["proposer"]).toEqual({ door: "agent", captureId: "cap_ad1" });
    expect(row.action_json).not.toContain("SENTINEL-77");
  });

  test("a before-state guard refuses the write before any prompt: rejected, no write dispatched", async () => {
    const kbDatabase = "0123abcd0123abcd0123abcd0123abcd";
    const h = harness({
      kb: () => ({ notion: { databaseId: kbDatabase } }),
      // The page's parent IS the KB database: the model door's guard (and so this door's) refuses.
      reply: (a) =>
        isBeforeReadActionType(a.type)
          ? {
              page: { parent: { type: "database_id", database_id: kbDatabase }, properties: {} },
              blockChildren: { results: [] },
            }
          : { url: "https://x" },
    });
    const out = await h.act.execute(
      "notion.page.update",
      { pageId: "ffffffffffffffffffffffffffffffff", propertiesJson: "{}" },
      PROV,
    );
    expect(out).toEqual({
      status: "rejected",
      reason: "the model cannot change a page in the Nimbus knowledge base; use the capture flow",
      code: "ERR_ACTION_GUARD_REFUSED",
    });
    expect(h.prompts).toEqual([]);
    expect(h.dispatched.map((a) => a.type)).toEqual(["notion.before.read"]);
    const rejected = db
      .query(
        "SELECT hitl_status, action_json FROM audit_log WHERE action_type = 'notion.page.update'",
      )
      .get() as { hitl_status: string; action_json: string };
    expect(rejected.hitl_status).toBe("rejected");
    expect(rejected.action_json).toContain(KNOWLEDGE_BASE_CHILD_REFUSAL);
  });

  test("a KB accessor that throws refuses a KB-capable page update (fail closed), on this door too", async () => {
    const h = harness({
      kb: () => {
        throw new Error("tribal config unreadable");
      },
      reply: (a) =>
        isBeforeReadActionType(a.type)
          ? { page: { parent: { type: "page_id", page_id: "p" } }, blockChildren: { results: [] } }
          : { url: "https://x" },
    });
    const out = await h.act.execute(
      "notion.page.update",
      { pageId: "ffffffffffffffffffffffffffffffff", propertiesJson: "{}" },
      PROV,
    );
    expect(out).toEqual({
      status: "rejected",
      reason: "the model cannot change a page in the Nimbus knowledge base; use the capture flow",
      code: "ERR_ACTION_GUARD_REFUSED",
    });
    expect(h.prompts).toEqual([]);
    expect(h.dispatched.some((a) => a.type === "notion.page.update")).toBe(false);
  });

  test("a declined prompt dispatches only the read", async () => {
    const h = harness({
      approve: false,
      reply: (a) => (isBeforeReadActionType(a.type) ? JIRA_REPLY : { url: "https://x" }),
    });
    expect(
      (await h.act.execute("jira.comment.add", { issueKey: "NIM-1", body: "x" }, PROV)).status,
    ).toBe("rejected");
    expect(h.dispatched.map((a) => a.type)).toEqual(["jira.before.read"]);
  });
});
