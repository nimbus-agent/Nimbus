import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { toStandardSchema } from "@mastra/core/schema";

import { dbRun } from "../../db/write.ts";
import { buildConnectorWriteAgentTools } from "../../engine/connector-write-agent-tools.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type { ActionResult, PlannedAction } from "../../engine/types.ts";
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
  CHATOPS_CHANNEL_REFUSAL,
  KNOWLEDGE_BASE_REFUSAL,
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
    if (r.before !== undefined) {
      out[mcpClientToolKey(service, r.before.tool)] = { description: "read", inputSchema: {} };
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
    () => executor,
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

  test("every B1 row is offered on an approved wave-2 opt-in", async () => {
    const door = await realDoor(() => BOUND);
    expect(door.offered).toEqual(
      CONNECTOR_WRITE_ROWS.filter(isModelOfferableRow)
        .map((r) => `${serviceOf(r.actionType)}__${r.toolId}`)
        .sort((a, b) => a.localeCompare(b)),
    );
    expect(door.offered).toHaveLength(12);
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
});
