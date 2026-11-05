import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { toStandardSchema } from "@mastra/core/schema";

import { dbRun } from "../../db/write.ts";
import { makeEgressSink } from "../../egress/egress-ledger.ts";
import { createBeforeStateRunner, isBeforeReadActionType } from "../../engine/before-state.ts";
import { buildConnectorWriteAgentTools } from "../../engine/connector-write-agent-tools.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../../engine/executor.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type {
  ActionResult,
  AuditSink,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "../../engine/types.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import {
  offerableWritesEnabledBy,
  removeModelWriteEnablement,
  setModelWriteEnablement,
} from "./enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import { CONNECTOR_WRITE_MODEL_ACCESS_CAPABILITY } from "./model-write-capability.ts";
import {
  BROADCAST_MENTION_REFUSAL,
  CALENDAR_TEXT_REFUSAL,
  CALENDAR_TIME_REFUSAL,
  CHATOPS_CHANNEL_REFUSAL,
  GITLAB_QUICK_ACTION_REFUSAL,
  GITLAB_SCOPED_LABEL_REFUSAL,
  KNOWLEDGE_BASE_CHILD_REFUSAL,
  KNOWLEDGE_BASE_REFUSAL,
  LINEAR_ASSIGNEE_REFUSAL,
  nullOptionalFieldRefusal,
  type TribalKbConfig,
} from "./model-write-refusals.ts";
import { createModelWriteToolSource, type ModelWriteSourceDeps } from "./model-write-source.ts";
import { previewTemplateKeys, row, withPreview } from "./types.ts";

// SYNTHETIC templated rows for the offer filters, so the wave and approved-set filters can be shown
// over rows a test controls. The real B1 rows go through the real door at the end of this file.
const T = { target: "{name}", summary: "s", fields: [] };
const SYNC = withPreview(row("argocd_app_sync", "argocd.app.sync", "write", 2), T);
const ROLLBACK = withPreview(row("argocd_app_rollback", "argocd.app.rollback", "write", 3), T);
const BARE = row("argocd_app_delete", "argocd.app.delete", "write", 2); // no template: not offerable
const WAVE4 = withPreview(row("argocd_app_prune", "argocd.app.prune", "write", 4), T);
const REFRESH = withPreview(row("tableau_refresh", "tableau.refresh", "write", 2), T);
const ROWS = [SYNC, ROLLBACK, BARE, WAVE4, REFRESH];
/** Every argocd tool id: approving all of them isolates the wave/offerability checks. */
const ALL_ARGOCD = [SYNC, ROLLBACK, BARE, WAVE4].map((r) => r.toolId);

const ALLOWED = { capabilitiesDisabled: new Set<string>() } as unknown as EnforcedPolicy;
const LOCKED = {
  capabilitiesDisabled: new Set<string>([CONNECTOR_WRITE_MODEL_ACCESS_CAPABILITY]),
} as unknown as EnforcedPolicy;

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 84);
});
afterEach(() => db.close());

function source(enforcedPolicy: ModelWriteSourceDeps["enforcedPolicy"]) {
  return createModelWriteToolSource({
    db,
    enforcedPolicy,
    listServerTools: async () => undefined,
    toolsEpoch: () => 0,
    warn: () => {},
    rows: ROWS,
  });
}

const ids = (rs: readonly { toolId: string }[]) => rs.map((r) => r.toolId);

describe("createModelWriteToolSource", () => {
  test("offers only offerable rows of enabled services, at or below each service's wave", () => {
    setModelWriteEnablement(db, "argocd", 2, 1, ALL_ARGOCD);
    expect(ids(source(() => ALLOWED).offerableEnabledRows())).toEqual(["argocd_app_sync"]);
    setModelWriteEnablement(db, "argocd", 4, 2, ALL_ARGOCD);
    // Wave 4 (no `before`) and the template-less row stay out; tableau is not enabled.
    expect(ids(source(() => ALLOWED).offerableEnabledRows())).toEqual([
      "argocd_app_sync",
      "argocd_app_rollback",
    ]);
  });

  test("an offerable row the owner did not approve by name is not offered", () => {
    setModelWriteEnablement(db, "argocd", 3, 1, ["argocd_app_sync"]);
    expect(ids(source(() => ALLOWED).offerableEnabledRows())).toEqual(["argocd_app_sync"]);
  });

  test("a pre-V84 opt-in (empty approved set) offers nothing until re-enabled", () => {
    const pre = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(pre, 83);
      dbRun(
        pre,
        "INSERT INTO connector_write_enablement (service, max_wave, enabled_at) VALUES ('argocd', 3, 1)",
      );
      runIndexedSchemaMigrations(pre, 84);
      const src = createModelWriteToolSource({
        db: pre,
        enforcedPolicy: () => ALLOWED,
        listServerTools: async () => undefined,
        toolsEpoch: () => 0,
        warn: () => {},
        rows: ROWS,
      });
      expect(src.offerableEnabledRows()).toEqual([]);
      expect(src.recheck(SYNC)).toBe(false);
      // Re-enabling with the rows the prompt listed offers them.
      setModelWriteEnablement(pre, "argocd", 3, 2, ["argocd_app_sync", "argocd_app_rollback"]);
      expect(ids(src.offerableEnabledRows())).toEqual(["argocd_app_sync", "argocd_app_rollback"]);
    } finally {
      pre.close();
    }
  });

  test("policy locked, no accessor, an undefined policy or a throwing accessor: nothing offered (control: allowed)", () => {
    setModelWriteEnablement(db, "argocd", 3, 1, ALL_ARGOCD);
    expect(source(() => ALLOWED).offerableEnabledRows()).toHaveLength(2);
    expect(source(() => LOCKED).offerableEnabledRows()).toEqual([]);
    expect(source(undefined).offerableEnabledRows()).toEqual([]);
    expect(source(() => undefined).offerableEnabledRows()).toEqual([]);
    expect(
      source(() => {
        throw new Error("policy unreadable");
      }).offerableEnabledRows(),
    ).toEqual([]);
  });

  test("recheck reads enablement, wave and policy live", () => {
    setModelWriteEnablement(db, "argocd", 3, 1, ALL_ARGOCD);
    let policy = ALLOWED;
    const src = source(() => policy);
    expect(src.recheck(ROLLBACK)).toBe(true);
    expect(src.recheck(BARE)).toBe(false);
    expect(src.recheck(WAVE4)).toBe(false);
    expect(src.recheck(REFRESH)).toBe(false); // tableau not enabled
    setModelWriteEnablement(db, "argocd", 2, 2, ALL_ARGOCD);
    expect(src.recheck(ROLLBACK)).toBe(false); // wave lowered below the row's
    expect(src.recheck(SYNC)).toBe(true);
    policy = LOCKED;
    expect(src.recheck(SYNC)).toBe(false);
    policy = ALLOWED;
    expect(src.recheck(SYNC)).toBe(true);
    removeModelWriteEnablement(db, "argocd");
    expect(src.recheck(SYNC)).toBe(false);
  });

  test("recheck at call time: a row listed while approved is refused once the approved set drops it", () => {
    setModelWriteEnablement(db, "argocd", 3, 1, ["argocd_app_sync", "argocd_app_rollback"]);
    const src = source(() => ALLOWED);
    expect(ids(src.offerableEnabledRows())).toContain("argocd_app_rollback");
    expect(src.recheck(ROLLBACK)).toBe(true);
    // Same wave, same service: only the approved set changes between listing and call.
    setModelWriteEnablement(db, "argocd", 3, 2, ["argocd_app_sync"]);
    expect(src.recheck(ROLLBACK)).toBe(false);
    expect(src.recheck(SYNC)).toBe(true);
  });
});

describe("createModelWriteToolSource: the destination refusals (F3/F4)", () => {
  const POST = withPreview(row("slack_message_post", "slack.message.post", "mesh", 2), {
    target: "{channel}",
    summary: "Post",
    fields: [],
  });
  const APPEND = withPreview(row("notion_block_append", "notion.block.append", "mesh", 2), {
    target: "{parentBlockId}",
    summary: "Append",
    fields: [],
  });
  const withChatops = {
    capabilitiesDisabled: new Set<string>(),
    chatops: {
      channels: new Map([["C0123ABCD", { namespace: "ns", unmapped: "refuse", notify: [] }]]),
      ownership: new Map(),
    },
  } as unknown as EnforcedPolicy;

  function refusingSource(
    enforcedPolicy: ModelWriteSourceDeps["enforcedPolicy"],
    getTribalKbConfig?: ModelWriteSourceDeps["getTribalKbConfig"],
  ) {
    return createModelWriteToolSource({
      db,
      enforcedPolicy,
      listServerTools: async () => undefined,
      toolsEpoch: () => 0,
      warn: () => {},
      rows: [POST, APPEND],
      ...(getTribalKbConfig === undefined ? {} : { getTribalKbConfig }),
    });
  }

  test("the ChatOps bindings are read from the live enforced policy", () => {
    let policy = withChatops;
    const src = refusingSource(() => policy);
    expect(src.refusal?.(POST, { channel: "#c0123abcd", text: "x" })).toBe(
      "the model cannot post to a channel Nimbus ChatOps listens on",
    );
    expect(src.refusal?.(POST, { channel: "C9999ZZZZ", text: "x" })).toBeUndefined();
    // A policy whose ChatOps binds no channel: nothing to refuse.
    policy = {
      capabilitiesDisabled: new Set<string>(),
      chatops: { channels: new Map(), ownership: new Map() },
    } as unknown as EnforcedPolicy;
    expect(src.refusal?.(POST, { channel: "#c0123abcd", text: "x" })).toBeUndefined();
  });

  test("an unreadable or throwing policy refuses a ChatOps-platform post", () => {
    expect(refusingSource(() => undefined).refusal?.(POST, { channel: "C9999ZZZZ" })).toBe(
      "the model cannot post to a channel Nimbus ChatOps listens on",
    );
    expect(
      refusingSource(() => {
        throw new Error("x");
      }).refusal?.(POST, { channel: "C9999ZZZZ" }),
    ).toBe("the model cannot post to a channel Nimbus ChatOps listens on");
  });

  test("a throwing policy on a non-ChatOps row propagates (the door answers generically), not the ChatOps text", () => {
    const throwing = refusingSource(() => {
      throw new Error("x");
    });
    expect(() => throwing.refusal?.(APPEND, { parentBlockId: "x" })).toThrow("x");
  });

  test("the KB config is read per call; a throw propagates (the door refuses it)", () => {
    let kbId: string | undefined = "aaaa-bbbb";
    const src = refusingSource(
      () => ALLOWED,
      () => (kbId === undefined ? undefined : { notion: { databaseId: kbId } }),
    );
    expect(src.refusal?.(APPEND, { parentBlockId: "AAAABBBB" })).toBe(
      "the model cannot write to the Nimbus knowledge base; use the capture flow",
    );
    kbId = undefined;
    expect(src.refusal?.(APPEND, { parentBlockId: "AAAABBBB" })).toBeUndefined();
    const throwing = refusingSource(
      () => ALLOWED,
      () => {
        throw new Error("config");
      },
    );
    expect(() => throwing.refusal?.(APPEND, { parentBlockId: "x" })).toThrow();
  });
});

// ---------- the real B1 rows, through the real door (no `rows` seam) ----------

/** The listing a server would hand over: every templated row's key with its template keys. */
function realListing(service: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of CONNECTOR_WRITE_ROWS) {
    if (serviceOf(r.actionType) !== service || r.preview === undefined) continue;
    const properties: Record<string, unknown> = {};
    for (const k of previewTemplateKeys(r.preview)) properties[k] = {};
    out[mcpClientToolKey(service, r.toolId)] = {
      description: r.toolId,
      inputSchema: toStandardSchema({ type: "object", properties } as Parameters<
        typeof toStandardSchema
      >[0]),
    };
    for (const tool of [r.before?.tool, r.before?.also?.tool]) {
      if (tool !== undefined) {
        out[mcpClientToolKey(service, tool)] = { description: "read", inputSchema: {} };
      }
    }
  }
  return out;
}

const REAL_SERVICES = [
  "slack",
  "teams",
  "discord",
  "github",
  "gitlab",
  "jira",
  "linear",
  "notion",
  "confluence",
  "gmail",
  "outlook",
  "apple",
  "google_drive",
  "obsidian",
];

function chatopsPolicy(channels: readonly string[]): EnforcedPolicy {
  return {
    capabilitiesDisabled: new Set<string>(),
    chatops: {
      channels: new Map(
        channels.map((c) => [c, { namespace: "ns", unmapped: "refuse", notify: [] }]),
      ),
      ownership: new Map(),
    },
  } as unknown as EnforcedPolicy;
}

/** ChatOps bound to Slack C0123ABCD and Teams 19:abc@thread.tacv2. */
const BOUND = chatopsPolicy(["C0123ABCD", "19:abc@thread.tacv2"]);

interface RealDoor {
  call(name: string, input: Record<string, unknown>): Promise<unknown>;
  readonly executed: PlannedAction[];
  readonly offered: readonly string[];
}

async function realDoor(
  policy: () => EnforcedPolicy | undefined,
  kb?: TribalKbConfig,
  realExecutor?: Pick<ToolExecutor, "execute">,
): Promise<RealDoor> {
  for (const s of REAL_SERVICES) {
    setModelWriteEnablement(
      db,
      s,
      2,
      1,
      offerableWritesEnabledBy(s, 2).map((r) => r.toolId),
    );
  }
  const src = createModelWriteToolSource({
    db,
    enforcedPolicy: policy,
    listServerTools: async (service) => realListing(service),
    toolsEpoch: () => 0,
    warn: () => {},
    getTribalKbConfig: () => kb,
  });
  const executed: PlannedAction[] = [];
  const executor = {
    execute: async (a: PlannedAction): Promise<ActionResult> => {
      executed.push(a);
      return { status: "ok", result: { sent: true } };
    },
  };
  const tools = await buildConnectorWriteAgentTools(
    src,
    () => realExecutor ?? executor,
    (_s, _t, d) => d,
    new Set(),
  );
  return {
    executed,
    offered: Object.keys(tools).sort((a, b) => a.localeCompare(b)),
    call: async (name, input) => {
      const t = tools[name] as
        | { execute?: (i: unknown, c: unknown) => Promise<unknown> }
        | undefined;
      if (t?.execute === undefined) throw new Error(`${name} is not offered`);
      return await t.execute(input, {});
    },
  };
}

describe("the real messaging rows through the real door (plan Task 3)", () => {
  const chatopsRefused = { refused: CHATOPS_CHANNEL_REFUSAL };

  test("every B1-B4b row is offered on an approved wave-2 opt-in", async () => {
    const door = await realDoor(() => BOUND);
    expect(door.offered).toEqual(
      CONNECTOR_WRITE_ROWS.filter(isModelOfferableRow)
        .map((r) => `${serviceOf(r.actionType)}__${r.toolId}`)
        .sort((a, b) => a.localeCompare(b)),
    );
    expect(door.offered).toHaveLength(38);
  });

  test("Slack: the bound channel by id and any channel NAME are refused, the DM too; nothing executed", async () => {
    const door = await realDoor(() => BOUND);
    for (const channel of ["C0123ABCD", "#general", "c0123abcd"]) {
      expect(
        await door.call("slack__slack_message_post", { channel, text: "hi" }),
        channel,
      ).toEqual(chatopsRefused);
    }
    expect(
      await door.call("slack__slack_message_post_dm", { user_ids: "U0123ABCD", text: "hi" }),
    ).toEqual(chatopsRefused);
    expect(door.executed).toEqual([]);
  });

  test("Teams: the bound thread percent-encoded is refused; another chat thread is sent once", async () => {
    const door = await realDoor(() => BOUND);
    expect(
      await door.call("teams__teams_message_post", {
        teamId: "t",
        channelId: "19%3Aabc%40thread.tacv2",
        body: "hi",
      }),
    ).toEqual(chatopsRefused);
    expect(door.executed).toEqual([]);
    expect(
      await door.call("teams__teams_message_post_chat", {
        chatId: "19:other@thread.v2",
        body: "hi",
      }),
    ).toEqual({ sent: true });
    expect(door.executed.map((a) => a.type)).toEqual(["teams.message.postChat"]);
  });

  test("a policy that turns unreadable after the offer refuses the call; nothing is executed", async () => {
    let policy: EnforcedPolicy | undefined = BOUND;
    const door = await realDoor(() => policy);
    policy = undefined;
    // The recheck fails first (no readable policy, no model access): nothing is executed.
    expect(
      await door.call("teams__teams_message_post_chat", { chatId: "19:x@thread.v2", body: "hi" }),
    ).toHaveProperty("refused");
    expect(door.executed).toEqual([]);
  });

  test("the KB: a Notion comment on the KB database (hyphenated or URL) and a Confluence comment on the KB parent are refused", async () => {
    const kbCfg: TribalKbConfig = {
      notion: { databaseId: "1a2b3c4d5e6f7a8b9c0d112233445566" },
      confluence: { spaceKey: "KB", parentPageId: "98765" },
    };
    const door = await realDoor(() => BOUND, kbCfg);
    const kbRefused = { refused: KNOWLEDGE_BASE_REFUSAL };
    for (const pageId of [
      "1a2b3c4d-5e6f-7a8b-9c0d-112233445566",
      "https://www.notion.so/KB-1a2b3c4d5e6f7a8b9c0d112233445566",
    ]) {
      expect(
        await door.call("notion__notion_comment_create", { pageId, text: "x" }),
        pageId,
      ).toEqual(kbRefused);
    }
    expect(
      await door.call("confluence__confluence_comment_add", { pageId: "98765", storageHtml: "x" }),
    ).toEqual(kbRefused);
    expect(door.executed).toEqual([]);
    expect(
      await door.call("confluence__confluence_comment_add", { pageId: "12345", storageHtml: "x" }),
    ).toEqual({ sent: true });
    expect(door.executed).toHaveLength(1);
  });

  test("B3: a page write to the KB destination is refused before anything is executed", async () => {
    const kbCfg: TribalKbConfig = {
      notion: { databaseId: "0123abcd0123abcd0123abcd0123abcd" },
      confluence: { spaceKey: "KB", parentPageId: "4242" },
    };
    const door = await realDoor(() => BOUND, kbCfg);
    const kbRefused = { refused: KNOWLEDGE_BASE_REFUSAL };
    expect(
      await door.call("confluence__confluence_page_append", { pageId: "4242", storageHtml: "x" }),
    ).toEqual(kbRefused);
    expect(
      await door.call("notion__notion_block_append", {
        parentBlockId: "https://www.notion.so/Team-KB-0123abcd0123abcd0123abcd0123abcd",
        childrenJson: "[]",
      }),
    ).toEqual(kbRefused);
    expect(door.executed).toEqual([]);
    expect(
      await door.call("notion__notion_page_update", {
        pageId: "ffffffffffffffffffffffffffffffff",
        propertiesJson: "{}",
      }),
    ).toEqual({ sent: true });
    expect(door.executed).toHaveLength(1);
  });
});

describe("the broadcast-mention refusal on the real rows through the real door (OR1)", () => {
  const broadcast = { refused: BROADCAST_MENTION_REFUSAL };
  const CASES: ReadonlyArray<[string, Record<string, unknown>, string]> = [
    ["slack__slack_message_post", { channel: "C9999ZZZZ" }, "text"],
    ["github__github_issue_comment_create", { owner: "o", repo: "r", issueNumber: 42 }, "body"],
    ["gitlab__gitlab_mr_note_create", { projectPath: "g/r", mergeRequestIid: 9 }, "body"],
  ];
  const LOUD: Readonly<Record<string, string>> = {
    slack__slack_message_post: "hi <!here>",
    github__github_issue_comment_create: "cc @nimbus-agent/core",
    gitlab__gitlab_mr_note_create: "@all",
  };

  test("a broadcast is refused with the fixed text before anything is executed", async () => {
    const door = await realDoor(() => BOUND);
    for (const [name, base, key] of CASES) {
      expect(await door.call(name, { ...base, [key]: LOUD[name] }), name).toEqual(broadcast);
    }
    expect(door.executed).toEqual([]);
  });

  test("the same rows with a user mention are executed once each", async () => {
    const door = await realDoor(() => BOUND);
    for (const [name, base, key] of CASES) {
      expect(await door.call(name, { ...base, [key]: "thanks @alice" }), name).toEqual({
        sent: true,
      });
    }
    expect(door.executed.map((a) => a.type)).toEqual([
      "slack.message.post",
      "github.issue.comment.create",
      "gitlab.mr.note.create",
    ]);
  });
});

describe("GitLab quick actions on the real rows through the real door", () => {
  test("a note that would /close or /merge is refused before anything is executed", async () => {
    const door = await realDoor(() => BOUND);
    const refused = { refused: GITLAB_QUICK_ACTION_REFUSAL };
    expect(
      await door.call("gitlab__gitlab_issue_note_create", {
        projectPath: "g/r",
        issueIid: 7,
        body: "done\r\n/close",
      }),
    ).toEqual(refused);
    expect(
      await door.call("gitlab__gitlab_mr_note_create", {
        projectPath: "g/r",
        mergeRequestIid: 9,
        body: "  /merge",
      }),
    ).toEqual(refused);
    expect(door.executed).toEqual([]);
    expect(
      await door.call("gitlab__gitlab_mr_note_create", {
        projectPath: "g/r",
        mergeRequestIid: 9,
        body: "approve and/or merge when green",
      }),
    ).toEqual({ sent: true });
    expect(door.executed).toHaveLength(1);
  });
});

describe("B2: the issue-write refusals on the real rows through the real door (plan Task 4)", () => {
  test("a quick action, a team mention and a scoped label are refused before anything is executed", async () => {
    const door = await realDoor(() => BOUND);
    expect(
      await door.call("gitlab__gitlab_issue_create", {
        projectPath: "g/r",
        title: "Bug",
        description: "fix\n/close",
      }),
    ).toEqual({ refused: GITLAB_QUICK_ACTION_REFUSAL });
    expect(
      await door.call("github__github_issue_create", {
        owner: "o",
        repo: "r",
        title: "ping @org/core",
      }),
    ).toEqual({ refused: BROADCAST_MENTION_REFUSAL });
    expect(
      await door.call("gitlab__gitlab_issue_labels_add", {
        projectPath: "g/r",
        issueIid: 7,
        labels: ["prio::high"],
      }),
    ).toEqual({ refused: GITLAB_SCOPED_LABEL_REFUSAL });
    expect(door.executed).toEqual([]);
  });

  test("the clean inputs are executed once each", async () => {
    const door = await realDoor(() => BOUND);
    for (const [name, input] of [
      [
        "gitlab__gitlab_issue_create",
        { projectPath: "g/r", title: "/api is down", labels: ["a:b"] },
      ],
      ["github__github_issue_create", { owner: "o", repo: "r", title: "thanks @alice" }],
      [
        "gitlab__gitlab_issue_labels_add",
        { projectPath: "g/r", issueIid: 7, labels: ["prio:high"] },
      ],
    ] as const) {
      expect(await door.call(name, input), name).toEqual({ sent: true });
    }
    expect(door.executed.map((a) => a.type)).toEqual([
      "gitlab.issue.create",
      "github.issue.create",
      "gitlab.issue.labels.add",
    ]);
  });
});

describe("B4a: the calendar refusals on the real rows through the real door (plan R6)", () => {
  test("an Outlook time with an offset and an iCloud CR in the title are refused; nothing executed", async () => {
    const door = await realDoor(() => BOUND);
    expect(
      await door.call("outlook__outlook_calendar_create", {
        subject: "Review",
        startDateTime: "2026-11-05T10:00:00+02:00",
        endDateTime: "2026-11-05T11:00:00",
      }),
    ).toEqual({ refused: CALENDAR_TIME_REFUSAL });
    expect(
      await door.call("apple__apple_calendar_event_create", {
        summary: "Review\rATTENDEE:mailto:x@evil.example",
        start: "20261105T100000Z",
        end: "20261105T110000Z",
      }),
    ).toEqual({ refused: CALENDAR_TEXT_REFUSAL });
    expect(door.executed).toEqual([]);
  });

  test("clean Outlook and iCloud creates are executed once each", async () => {
    const door = await realDoor(() => BOUND);
    expect(
      await door.call("outlook__outlook_calendar_create", {
        subject: "Review",
        startDateTime: "2026-11-05T10:00:00",
        endDateTime: "2026-11-05T11:00:00",
        timeZone: "Europe/Paris",
        attendees: "a@x.com, b@y.com",
      }),
    ).toEqual({ sent: true });
    expect(
      await door.call("apple__apple_calendar_event_create", {
        summary: "Review",
        start: "20261105T100000Z",
        end: "20261105T110000Z",
        attendees: ["a@x.com"],
      }),
    ).toEqual({ sent: true });
    expect(door.executed.map((a) => a.type)).toEqual([
      "outlook.calendar.create",
      "apple.calendar.event.create",
    ]);
  });

  test("a null optional field is refused (Drive parentId, Outlook timeZone), nothing executed; omitted is executed once", async () => {
    const door = await realDoor(() => BOUND);
    expect(
      await door.call("google_drive__gdrive_file_create", { name: "n.txt", parentId: null }),
    ).toEqual({ refused: nullOptionalFieldRefusal("parentId") });
    expect(
      await door.call("outlook__outlook_calendar_create", {
        subject: "Review",
        startDateTime: "2026-11-05T10:00",
        endDateTime: "2026-11-05T11:00",
        timeZone: null,
      }),
    ).toEqual({ refused: nullOptionalFieldRefusal("timeZone") });
    expect(door.executed).toEqual([]);
    expect(await door.call("google_drive__gdrive_file_create", { name: "n.txt" })).toEqual({
      sent: true,
    });
    expect(door.executed.map((a) => a.type)).toEqual(["google_drive.file.create"]);
  });
});

describe("B2: the Linear assignee guard through the production door executor (OR-B2-3)", () => {
  const LINEAR_ID = "8f2b0a1c-0000-4000-8000-000000000001";
  const reply = (assignee: unknown) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ issue: { id: LINEAR_ID, title: "Flaky test", assignee } }),
      },
    ],
  });

  /** The door's real executor shape: a before-state runner over the production rows. */
  function doorExecutor(readReply: unknown, approve: boolean) {
    const prompts: string[] = [];
    const dispatched: PlannedAction[] = [];
    const consent: ConsentChannel = {
      requestApproval: async (prompt) => {
        prompts.push(prompt);
        return approve;
      },
    };
    const audit: AuditSink = { recordAudit: () => {} };
    const connectors: ConnectorDispatcher = {
      dispatch: async (a) => {
        dispatched.push(a);
        return isBeforeReadActionType(a.type) ? readReply : { updated: true };
      },
    };
    const exec = new ToolExecutor(
      consent,
      audit,
      connectors,
      undefined,
      makeEgressSink(db),
      NO_POLICY_OVERLAY,
      undefined,
      createBeforeStateRunner(),
    );
    const egress = () =>
      (
        db.query("SELECT method, result_status FROM egress_ledger ORDER BY id").all() as Array<{
          method: string;
          result_status: string;
        }>
      ).map((r) => [r.method, r.result_status]);
    return { exec, prompts, dispatched, egress };
  }

  const write = { issueId: LINEAR_ID, assigneeId: "user-1" };

  test("assigned: refused with the fixed text, no prompt, no write dispatched, the write's egress row blocked", async () => {
    const h = doorExecutor(reply({ id: "u", displayName: "Carol" }), true);
    const door = await realDoor(() => BOUND, undefined, h.exec);
    expect(await door.call("linear__linear_issue_update", write)).toEqual({
      refused: LINEAR_ASSIGNEE_REFUSAL,
    });
    expect(h.prompts).toEqual([]);
    expect(h.dispatched.map((a) => a.type)).toEqual(["linear.before.read"]);
    expect(h.egress()).toEqual([
      ["linear.before.read", "authorized"],
      ["linear.issue.update", "blocked"],
    ]);
  });

  test("unassigned (assignee: null): the prompt, and on approval one write dispatch", async () => {
    const h = doorExecutor(reply(null), true);
    const door = await realDoor(() => BOUND, undefined, h.exec);
    expect(await door.call("linear__linear_issue_update", write)).toEqual({ updated: true });
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("Assignee: (none)");
    expect(h.dispatched.map((a) => a.type)).toEqual(["linear.before.read", "linear.issue.update"]);
    expect(h.egress()).toEqual([
      ["linear.before.read", "authorized"],
      ["linear.issue.update", "authorized"],
    ]);
  });

  test("an update without assigneeId is never refused by the guard, even on an assigned issue", async () => {
    const h = doorExecutor(reply({ id: "u", displayName: "Carol" }), true);
    const door = await realDoor(() => BOUND, undefined, h.exec);
    expect(
      await door.call("linear__linear_issue_update", { issueId: LINEAR_ID, title: "x" }),
    ).toEqual({ updated: true });
    expect(h.prompts).toHaveLength(1);
  });
});

describe("B3: the KB-child guard through the production door executor (OR-B3-3)", () => {
  const KB_CFG: TribalKbConfig = {
    notion: { databaseId: "0123abcd0123abcd0123abcd0123abcd" },
    confluence: { spaceKey: "KB", parentPageId: "4242" },
  };
  const pageReply = (parent: unknown) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          page: { parent, properties: { Name: { type: "title", title: [{ plain_text: "Doc" }] } } },
          blockChildren: { results: [], has_more: false },
        }),
      },
    ],
  });

  /** The door's real executor: the production rows, the runner fed the KB config. */
  function doorExecutor(readReply: unknown, kb: TribalKbConfig | undefined) {
    const prompts: string[] = [];
    const dispatched: PlannedAction[] = [];
    const consent: ConsentChannel = {
      requestApproval: async (prompt) => {
        prompts.push(prompt);
        return true;
      },
    };
    const audit: AuditSink = { recordAudit: () => {} };
    const connectors: ConnectorDispatcher = {
      dispatch: async (a) => {
        dispatched.push(a);
        return isBeforeReadActionType(a.type) ? readReply : { updated: true };
      },
    };
    const exec = new ToolExecutor(
      consent,
      audit,
      connectors,
      undefined,
      makeEgressSink(db),
      NO_POLICY_OVERLAY,
      undefined,
      createBeforeStateRunner({ guardContext: () => ({ kb }) }),
    );
    const egress = () =>
      (
        db.query("SELECT method, result_status FROM egress_ledger ORDER BY id").all() as Array<{
          method: string;
          result_status: string;
        }>
      ).map((r) => [r.method, r.result_status]);
    return { exec, prompts, dispatched, egress };
  }

  const write = { pageId: "ffffffffffffffffffffffffffffffff", propertiesJson: "{}" };

  test("a page in the KB database: refused with the fixed text, no prompt, no write, the write's egress row blocked", async () => {
    const h = doorExecutor(
      pageReply({ type: "database_id", database_id: "0123ABCD-0123-abcd-0123-abcd0123abcd" }),
      KB_CFG,
    );
    const door = await realDoor(() => BOUND, KB_CFG, h.exec);
    expect(await door.call("notion__notion_page_update", write)).toEqual({
      refused: KNOWLEDGE_BASE_CHILD_REFUSAL,
    });
    expect(h.prompts).toEqual([]);
    expect(h.dispatched.map((a) => a.type)).toEqual(["notion.before.read"]);
    expect(h.egress()).toEqual([
      ["notion.before.read", "authorized"],
      ["notion.page.update", "blocked"],
    ]);
  });

  test("a page outside the KB: the prompt, and on approval one write dispatch", async () => {
    const h = doorExecutor(pageReply({ type: "page_id", page_id: "p" }), KB_CFG);
    const door = await realDoor(() => BOUND, KB_CFG, h.exec);
    expect(await door.call("notion__notion_page_update", write)).toEqual({ updated: true });
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("Title: Doc");
    expect(h.dispatched.map((a) => a.type)).toEqual(["notion.before.read", "notion.page.update"]);
  });

  test("no Notion KB: never refused by the guard, even for a page in a database", async () => {
    const h = doorExecutor(
      pageReply({ type: "database_id", database_id: "0123abcd0123abcd0123abcd0123abcd" }),
      undefined,
    );
    const door = await realDoor(() => BOUND, undefined, h.exec);
    expect(await door.call("notion__notion_page_update", write)).toEqual({ updated: true });
    expect(h.prompts).toHaveLength(1);
  });
});
