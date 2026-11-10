// Phase 9.7 C1: the typed previews and before-readers of the eight Wave 3 file, pull request and
// incident rows (Drive move, rename and trash, the OneDrive move, the GitHub pull request close and
// the three PagerDuty incident writes). Each row's template keys are exactly its tool's input-schema
// keys in `@nimbus-dev/connectors` 0.6.0, checked twice: against a spelled-out constant AND against
// the keys the installed package's source declares (read as text the way `manifest.sync.test.ts`
// reads it), so a wrong constant fails and so does a connector release that renames a key.
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
import {
  selectDriveFileMove,
  selectDriveFileRename,
  selectDriveFileTrash,
  selectOnedriveItemMove,
} from "./files.ts";
import { selectPagerdutyIncident } from "./incident.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import { createModelWriteToolSource } from "./model-write-source.ts";
import {
  buildConnectorWritePreviewFrom,
  type ConnectorWritePreview,
  renderConnectorWritePreviewLines,
} from "./preview.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";
import { selectGithubPrIdentity } from "./vcs-ci.ts";

const C1_ROWS = [
  "gdrive_file_move",
  "gdrive_file_rename",
  "gdrive_file_trash",
  "onedrive_item_move",
  "github_pr_close",
  "pd_incident_acknowledge",
  "pd_incident_resolve",
  "pd_incident_escalate",
] as const;
type C1Row = (typeof C1_ROWS)[number];

/** The 0.6.0 input-schema keys of each row, spelled out from the connector source (sorted). */
const SCHEMA_KEYS: Readonly<Record<C1Row, readonly string[]>> = {
  gdrive_file_move: ["fileId", "newParentId", "removeParentId"],
  gdrive_file_rename: ["fileId", "newName"],
  gdrive_file_trash: ["fileId"],
  onedrive_item_move: ["itemId", "newName", "newParentId"],
  github_pr_close: ["owner", "pullNumber", "repo"],
  pd_incident_acknowledge: ["incidentId"],
  pd_incident_resolve: ["incidentId"],
  pd_incident_escalate: ["escalationLevel", "incidentId"],
};

/** The before-reader tool of each row and the input keys that tool's schema declares. */
const READERS: Readonly<
  Record<string, { readonly tool: string; readonly keys: readonly string[] }>
> = {
  gdrive_file_move: { tool: "gdrive_file_metadata", keys: ["fileId"] },
  gdrive_file_rename: { tool: "gdrive_file_metadata", keys: ["fileId"] },
  gdrive_file_trash: { tool: "gdrive_file_metadata", keys: ["fileId"] },
  onedrive_item_move: { tool: "onedrive_item_get", keys: ["itemId"] },
  github_pr_close: { tool: "github_pr_get", keys: ["owner", "pullNumber", "repo"] },
  pd_incident_acknowledge: { tool: "pd_incident_get", keys: ["incidentId"] },
  pd_incident_resolve: { tool: "pd_incident_get", keys: ["incidentId"] },
  pd_incident_escalate: { tool: "pd_incident_get", keys: ["incidentId"] },
};

const sources = readConnectorPackageSources(installedConnectorsPackageRoot());
const scan = scanWriteToolRegistrations(sources);
const codeByFile = new Map(sources.map((s) => [s.rel, stripComments(s.text)]));

/** The input keys the installed package declares for the WRITE tool `toolId`. */
function declaredWriteKeys(toolId: string): string[] {
  const reg = scan.registrations.find((r) => r.id === toolId);
  if (reg === undefined)
    throw new Error(`${toolId}: not a registered write in the installed package`);
  const code = codeByFile.get(reg.file) ?? "";
  const call = code.slice(reg.span[0], reg.span[1] + 1);
  return declaredInputKeys(withSchemaArgumentDeclarations(sources, code, call));
}

/** The input keys the installed package declares for the READ tool `toolId` (exactly one file registers it). */
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

const CLEAN: Readonly<Record<C1Row, Record<string, unknown>>> = {
  gdrive_file_move: { fileId: "F1", newParentId: "D2", removeParentId: "D1" },
  gdrive_file_rename: { fileId: "F1", newName: "Q3 plan.md" },
  gdrive_file_trash: { fileId: "F1" },
  onedrive_item_move: { itemId: "I1", newParentId: "P2", newName: "report.docx" },
  github_pr_close: { owner: "acme", repo: "api", pullNumber: 42 },
  pd_incident_acknowledge: { incidentId: "PABC123" },
  pd_incident_resolve: { incidentId: "PABC123" },
  pd_incident_escalate: { incidentId: "PABC123", escalationLevel: 2 },
};

const GOLDEN: Readonly<Record<C1Row, readonly string[]>> = {
  gdrive_file_move: [
    "Service: google_drive",
    "Credential: personal",
    "Target:  F1",
    "Move Google Drive file F1 into folder D2",
    "",
    '  File id: "F1"',
    '  New folder id: "D2"',
    '  Folder to remove it from: "D1"',
  ],
  gdrive_file_rename: [
    "Service: google_drive",
    "Credential: personal",
    "Target:  F1",
    "Rename Google Drive file F1",
    "",
    '  File id: "F1"',
    '  New name: "Q3 plan.md"',
  ],
  gdrive_file_trash: [
    "Service: google_drive",
    "Credential: personal",
    "Target:  F1",
    "Move Google Drive file F1 to the Drive trash (it can be restored from the trash for 30 days)",
    "",
    '  File id: "F1"',
  ],
  onedrive_item_move: [
    "Service: onedrive",
    "Credential: personal",
    "Target:  I1",
    "Move OneDrive item I1 into folder P2",
    "",
    '  Item id: "I1"',
    '  New folder id: "P2"',
    '  New name: "report.docx"',
  ],
  github_pr_close: [
    "Service: github",
    "Credential: personal",
    "Target:  acme/api#42",
    "Close GitHub pull request acme/api#42 without merging",
    "",
    '  owner: "acme"',
    '  repo: "api"',
    "  Pull request number: 42",
  ],
  pd_incident_acknowledge: [
    "Service: pagerduty",
    "Credential: personal",
    "Target:  PABC123",
    "Acknowledge PagerDuty incident PABC123 (it cannot be un-acknowledged through Nimbus)",
    "",
    '  Incident id: "PABC123"',
  ],
  pd_incident_resolve: [
    "Service: pagerduty",
    "Credential: personal",
    "Target:  PABC123",
    "Resolve PagerDuty incident PABC123 (it cannot be reopened through Nimbus)",
    "",
    '  Incident id: "PABC123"',
  ],
  pd_incident_escalate: [
    "Service: pagerduty",
    "Credential: personal",
    "Target:  PABC123",
    "Escalate PagerDuty incident PABC123 to level 2 (it cannot be de-escalated through Nimbus)",
    "",
    '  Incident id: "PABC123"',
    "  Escalation level (1 to 20): 2",
  ],
};

function rowOf(toolId: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
}

function previewOf(toolId: C1Row, input: Record<string, unknown>): ConnectorWritePreview {
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
  return p;
}

function fieldValue(p: ConnectorWritePreview, label: string): string | undefined {
  return p.fields.find((f) => f.label === label)?.value;
}

const sortedKeys = (keys: Iterable<string>): string[] =>
  [...keys].sort((a, b) => a.localeCompare(b));

describe("C1 typed previews: the eight Wave 3 file, pull request and incident rows", () => {
  test("the eight rows are mesh, wave 3, templated, offerable and each has a before-reader", () => {
    expect(C1_ROWS).toHaveLength(8);
    for (const id of C1_ROWS) {
      const r = rowOf(id);
      expect(r.transport, id).toBe("mesh");
      expect(r.wave, id).toBe(3);
      expect(r.preview, id).toBeDefined();
      expect(r.before, id).toBeDefined();
      expect(r.registeredAs, id).toBeUndefined();
      expect(isModelOfferableRow(r), id).toBe(true);
    }
  });

  for (const id of C1_ROWS) {
    test(`golden lines: ${id}`, () => {
      const p = previewOf(id, CLEAN[id]);
      expect(renderConnectorWritePreviewLines(p)).toEqual([...GOLDEN[id]]);
      expect(p.otherFields).toEqual([]);
    });
  }

  test("the template keys equal the spelled-out 0.6.0 schema keys", () => {
    for (const id of C1_ROWS) {
      const t = rowOf(id).preview;
      if (t === undefined) throw new Error(id);
      expect(sortedKeys(previewTemplateKeys(t)), id).toEqual([...SCHEMA_KEYS[id]]);
    }
  });

  test("the spelled-out keys equal what the installed package source declares (not circular)", () => {
    for (const id of C1_ROWS) {
      const declared = declaredWriteKeys(id);
      expect(declared.length, `${id}: the schema shape was not recognised`).toBeGreaterThan(0);
      expect(declared, id).toEqual([...SCHEMA_KEYS[id]]);
      const t = rowOf(id).preview;
      if (t === undefined) throw new Error(id);
      expect(sortedKeys(previewTemplateKeys(t)), id).toEqual(declared);
    }
  });

  test("the key reader can fail: a key the schema lacks, or a schema it cannot read, is caught", () => {
    expect(declaredWriteKeys("pd_incident_escalate")).not.toEqual(["incidentId"]);
    expect(declaredWriteKeys("pd_incident_acknowledge")).not.toContain("escalationLevel");
    expect(declaredInputKeys("const x = { a: 1 };")).toEqual([]);
    expect(() => declaredWriteKeys("not_a_registered_tool")).toThrow(/not a registered write/);
  });

  test("the before-reader tools are registered tools of the installed package, and read the keys they declare", () => {
    for (const id of C1_ROWS) {
      const reader = rowOf(id).before;
      const want = READERS[id];
      if (reader === undefined || want === undefined) throw new Error(id);
      expect(reader.tool, id).toBe(want.tool);
      // The installed schema of the read tool: a rename in a later connector release fails here.
      expect(declaredReadKeys(reader.tool), id).toEqual([...want.keys]);
      // The keys the reader's `args` produces are exactly that schema's keys.
      const produced = [reader, ...(reader.also === undefined ? [] : [reader.also])].map((read) => {
        const out = read.args(CLEAN[id]);
        return sortedKeys(Object.keys(out ?? {}));
      });
      for (const keys of produced) expect(keys, id).toEqual([...want.keys]);
    }
  });

  test("the escalate template is its own: the level is required, acknowledge and resolve carry none", () => {
    expect(rowOf("pd_incident_escalate").preview?.summary).toContain("{escalationLevel}");
    expect(rowOf("pd_incident_acknowledge").preview?.summary).not.toContain("{escalationLevel}");
    expect(rowOf("pd_incident_resolve").preview?.summary).not.toContain("{escalationLevel}");
    // Without a level the preview says so rather than inventing one.
    const p = previewOf("pd_incident_escalate", { incidentId: "PABC123" });
    expect(renderConnectorWritePreviewLines(p).join("\n")).toContain("level (not set)");
  });

  test("the Drive move preview states the hidden removal of the first folder", () => {
    const p = previewOf("gdrive_file_move", { fileId: "F1", newParentId: "D2" });
    expect(fieldValue(p, "Folder to remove it from")).toBe(
      "(not set: the connector removes the file's FIRST current folder)",
    );
  });

  test("the OneDrive move preview says an unset new name keeps the name", () => {
    const p = previewOf("onedrive_item_move", { itemId: "I1", newParentId: "P2" });
    expect(fieldValue(p, "New name")).toBe("(not set: keeps its name)");
  });

  test("an extra key is reported under Other fields, not dropped", () => {
    const p = previewOf("gdrive_file_rename", { ...CLEAN.gdrive_file_rename, extra: "x" });
    expect(p.otherFields.map((f) => f.key)).toEqual(["extra"]);
  });

  test("no field is markdown or secret: the owner sees the exact characters", () => {
    for (const id of C1_ROWS) {
      for (const f of rowOf(id).preview?.fields ?? [])
        expect(f.kind, `${id}.${f.key}`).toBe("text");
    }
  });
});

// ---- the selectors, with realistic replies ---------------------------------------------------

const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fieldMap = (fields: readonly { label: string; value: string }[]): Record<string, string> =>
  Object.fromEntries(fields.map((f) => [f.label, f.value]));

describe("C1 selectors", () => {
  const DRIVE_FILE = {
    id: "F1",
    name: "Q3 plan.md",
    mimeType: "text/markdown",
    shared: true,
    trashed: false,
    parents: ["D1", "D9"],
    owners: [{ emailAddress: "me@example.com" }, { emailAddress: "you@example.com" }],
  };
  const DRIVE_FOLDER = {
    id: "D2",
    name: "Archive",
    mimeType: "application/vnd.google-apps.folder",
    shared: false,
  };

  test("Drive rename and trash: name, type, shared, owner, trash; the trash warns who loses access", () => {
    const rename = fieldMap(selectDriveFileRename(mcp(DRIVE_FILE)));
    expect(rename).toEqual({
      "Current name": "Q3 plan.md",
      Type: "text/markdown",
      Shared: "yes",
      Owner: "me@example.com and 1 more",
    });
    const trash = fieldMap(selectDriveFileTrash(DRIVE_FILE));
    expect(trash["Shared"]).toBe(
      "yes: everyone it is shared with loses access until it is restored",
    );
    expect(fieldMap(selectDriveFileTrash({ name: "x", trashed: true }))["In trash"]).toBe("yes");
    expect(
      fieldMap(selectDriveFileRename({ name: "d", mimeType: DRIVE_FOLDER.mimeType }))["Type"],
    ).toBe("folder");
  });

  test("Drive move: the file, its folders, and the destination (a non-folder and a shared folder are flagged)", () => {
    const f = fieldMap(selectDriveFileMove(mcp(DRIVE_FILE), undefined, mcp(DRIVE_FOLDER)));
    expect(f["Folders"]).toBe("D1, D9");
    expect(f["Destination folder"]).toBe("Archive");
    expect(f["Destination type"]).toBe("folder");
    expect(f["Destination shared"]).toBe("no");
    const bad = fieldMap(
      selectDriveFileMove(DRIVE_FILE, undefined, {
        name: "n.txt",
        mimeType: "text/plain",
        shared: true,
      }),
    );
    expect(bad["Destination type"]).toBe("not a folder (text/plain): Drive will refuse the move");
    expect(bad["Destination shared"]).toBe(
      "yes: the moved file becomes visible to everyone this folder is shared with",
    );
    // No parents in the reply: the Folders field is omitted, never shown empty.
    expect(
      fieldMap(selectDriveFileMove({ name: "x" }, undefined, DRIVE_FOLDER))["Folders"],
    ).toBeUndefined();
  });

  test("Drive: a reply with no name throws (the prompt reads unavailable), values are capped", () => {
    expect(() => selectDriveFileRename({ mimeType: "x" })).toThrow();
    expect(() => selectDriveFileMove(DRIVE_FILE, undefined, { mimeType: "x" })).toThrow();
    expect(() => selectDriveFileTrash("not an object")).toThrow();
    const long = "n".repeat(5000);
    expect(fieldMap(selectDriveFileRename({ name: long }))["Current name"]).toContain(
      "more characters not shown",
    );
  });

  test("OneDrive move: the item, its parent, whether it is shared, and the destination", () => {
    const item = {
      name: "report.docx",
      file: { mimeType: "application/msword" },
      parentReference: { id: "P1", path: "/drive/root:/Docs" },
      shared: { scope: "users" },
    };
    const f = fieldMap(
      selectOnedriveItemMove(mcp(item), undefined, mcp({ name: "Archive", folder: {} })),
    );
    expect(f).toEqual({
      Name: "report.docx",
      Type: "file",
      Parent: "/drive/root:/Docs",
      Shared: "yes: others can open it",
      "Destination folder": "Archive",
      "Destination type": "folder",
    });
    const bare = fieldMap(
      selectOnedriveItemMove({ name: "a", folder: {}, parentReference: { id: "P1" } }, undefined, {
        name: "b",
      }),
    );
    expect(bare["Type"]).toBe("folder");
    expect(bare["Parent"]).toBe("P1");
    expect(bare["Shared"]).toBe("no");
    expect(bare["Destination type"]).toBe("not a folder: OneDrive will refuse the move");
    expect(fieldMap(selectOnedriveItemMove({ name: "z" }, undefined, { name: "b" }))["Type"]).toBe(
      "item",
    );
    expect(() => selectOnedriveItemMove({ file: {} }, undefined, { name: "b" })).toThrow();
    expect(() => selectOnedriveItemMove({ name: "a" }, undefined, {})).toThrow();
  });

  test("GitHub pull request close: title, state, branches, draft, author; never the body", () => {
    const pr = {
      title: "Add retries",
      body: "PRIVATE BODY TEXT",
      state: "open",
      merged: false,
      draft: false,
      head: { ref: "feat/retries" },
      base: { ref: "main" },
      user: { login: "octocat" },
    };
    const f = fieldMap(selectGithubPrIdentity(mcp(pr)));
    expect(f).toEqual({
      Title: "Add retries",
      State: "open",
      Branches: "feat/retries -> main",
      Draft: "no",
      Author: "octocat",
    });
    expect(JSON.stringify(f)).not.toContain("PRIVATE BODY");
    expect(fieldMap(selectGithubPrIdentity({ ...pr, state: "closed" }))["State"]).toBe(
      "closed: it is already closed",
    );
    expect(
      fieldMap(selectGithubPrIdentity({ ...pr, state: "closed", merged: true }))["State"],
    ).toBe("merged: closing it does nothing");
    expect(fieldMap(selectGithubPrIdentity({ title: "t", draft: true }))).toEqual({
      Title: "t",
      Draft: "yes",
    });
    expect(() => selectGithubPrIdentity({ state: "open" })).toThrow();
  });

  test("PagerDuty incident: unwrapped from {incident}, summaries only, a no-op status is shown", () => {
    const inc = {
      incident: {
        id: "PABC123",
        title: "Disk full on db-1",
        status: "resolved",
        urgency: "high",
        service: { id: "S1", summary: "Payments DB" },
        assignments: [{ assignee: { summary: "Ada" } }, { assignee: { summary: "Bob" } }, { x: 1 }],
        escalation_policy: { summary: "Default" },
        escalation_level: 2,
        priority: { summary: "P1" },
      },
    };
    expect(fieldMap(selectPagerdutyIncident(mcp(inc)))).toEqual({
      Title: "Disk full on db-1",
      Status: "resolved",
      Urgency: "high",
      Service: "Payments DB",
      "Assigned to": "Ada, Bob",
      "Escalation policy": "Default",
      "Escalation level": "2",
      Priority: "P1",
    });
    expect(
      fieldMap(selectPagerdutyIncident({ incident: { summary: "S", assignments: [] } })),
    ).toEqual({ Title: "S", "Assigned to": "(nobody)" });
    expect(() => selectPagerdutyIncident({ id: "x", title: "t" })).toThrow();
    expect(() => selectPagerdutyIncident({ incident: [] })).toThrow();
    expect(() => selectPagerdutyIncident({ incident: { status: "triggered" } })).toThrow();
  });

  test("each reader's args builds its read from the input, and refuses an id that is not a string", () => {
    for (const id of ["gdrive_file_move", "gdrive_file_rename", "gdrive_file_trash"] as const) {
      expect(rowOf(id).before?.args({ fileId: "" })).toBeUndefined();
      expect(rowOf(id).before?.args({ fileId: 7 })).toBeUndefined();
      expect(rowOf(id).before?.args({ fileId: "F1" })).toEqual({ fileId: "F1" });
    }
    const move = rowOf("gdrive_file_move").before;
    expect(move?.also?.args({ newParentId: "D2" })).toEqual({ fileId: "D2" });
    expect(move?.also?.args({ newParentId: null })).toBeUndefined();
    const pr = rowOf("github_pr_close").before;
    expect(pr?.args({ owner: "acme", repo: "api", pullNumber: 42 })).toEqual({
      owner: "acme",
      repo: "api",
      pullNumber: 42,
    });
    expect(pr?.args({ owner: "acme", repo: "api", pullNumber: "42" })).toEqual({
      owner: "acme",
      repo: "api",
      pullNumber: 42,
    });
    for (const bad of [0, -1, 1.5, "4x", "", "0", null, undefined, Number.NaN, {}, [42]]) {
      expect(
        pr?.args({ owner: "acme", repo: "api", pullNumber: bad }),
        String(bad),
      ).toBeUndefined();
    }
    for (const bad of [7, "", null, undefined, {}, ["a"]]) {
      expect(pr?.args({ owner: bad, repo: "api", pullNumber: 42 }), String(bad)).toBeUndefined();
      expect(pr?.args({ owner: "acme", repo: bad, pullNumber: 42 }), String(bad)).toBeUndefined();
    }
    const od = rowOf("onedrive_item_move").before;
    expect(od?.args({ itemId: "I1" })).toEqual({ itemId: "I1" });
    expect(od?.also?.args({ newParentId: "P2" })).toEqual({ itemId: "P2" });
    expect(od?.args({ itemId: undefined })).toBeUndefined();
    const pd = rowOf("pd_incident_resolve").before;
    expect(pd?.args({ incidentId: "PABC123" })).toEqual({ incidentId: "PABC123" });
    expect(pd?.args({ incidentId: 5 })).toBeUndefined();
    expect(rowOf("github_pr_close").before?.args(CLEAN.github_pr_close)).toEqual(
      CLEAN.github_pr_close,
    );
  });
});

// ---- the door: the eight rows offered, read and prompted ------------------------------------

/** What a server lists for `service`: each write with its 0.6.0 keys, each reader with its keys. */
function c1Listing(
  service: string,
  opts: { readonly omitReaders?: boolean } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entry = (keys: readonly string[]) => ({
    description: "tool",
    inputSchema: toStandardSchema({
      type: "object",
      properties: Object.fromEntries(keys.map((k) => [k, {}])),
    } as Parameters<typeof toStandardSchema>[0]),
  });
  for (const id of C1_ROWS) {
    const r = rowOf(id);
    if (serviceOf(r.actionType) !== service) continue;
    out[mcpClientToolKey(service, id)] = entry(SCHEMA_KEYS[id]);
    const reader = READERS[id];
    if (reader !== undefined && opts.omitReaders !== true) {
      out[mcpClientToolKey(service, reader.tool)] = entry(reader.keys);
    }
  }
  return out;
}

const C1_SERVICES = ["google_drive", "onedrive", "github", "pagerduty"] as const;

describe("C1 through the real door", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 84);
  });
  afterEach(() => db.close());

  const ALLOWED = { capabilitiesDisabled: new Set<string>() } as unknown as EnforcedPolicy;

  async function door(opts: {
    readonly omitReaders?: boolean;
    readonly unconfigured?: readonly string[];
    readonly readReply?: unknown;
  }) {
    for (const s of C1_SERVICES) {
      const approved = C1_ROWS.filter((id) => serviceOf(rowOf(id).actionType) === s);
      setModelWriteEnablement(db, s, 3, 1, approved);
    }
    const src = createModelWriteToolSource({
      db,
      enforcedPolicy: () => ALLOWED,
      listServerTools: async (service) =>
        opts.unconfigured?.includes(service) === true
          ? undefined
          : c1Listing(service, opts.omitReaders === undefined ? {} : { omitReaders: true }),
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
      createBeforeStateRunner(),
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

  const EIGHT = C1_ROWS.map((id) => `${serviceOf(rowOf(id).actionType)}__${id}`).sort((a, b) =>
    a.localeCompare(b),
  );

  test("a wave-3 opt-in that approved the eight offers exactly them", async () => {
    expect((await door({})).offered).toEqual(EIGHT);
  });

  test("with the reader tools missing from the listing the rows are still offered, and the prompt says Before: unavailable", async () => {
    const d = await door({ omitReaders: true });
    expect(d.offered).toEqual(EIGHT);
    expect(await d.call("google_drive__gdrive_file_rename", CLEAN.gdrive_file_rename)).toEqual({
      ok: true,
    });
    expect(d.prompts[0]).toContain("Before: unavailable (failed)");
    expect(d.dispatched.map((a) => a.type)).toEqual(["google_drive.file.rename"]);
  });

  test("with the reader listed the prompt shows the current state and the read ran first", async () => {
    const d = await door({ readReply: mcp({ name: "Old name.md", mimeType: "text/markdown" }) });
    expect(await d.call("google_drive__gdrive_file_rename", CLEAN.gdrive_file_rename)).toEqual({
      ok: true,
    });
    expect(d.prompts[0]).toContain("Old name.md");
    expect(d.dispatched.map((a) => isBeforeReadActionType(a.type))).toEqual([true, false]);
  });

  test("a service the mesh will not list (unconfigured) offers none of its rows", async () => {
    const d = await door({ unconfigured: ["pagerduty", "onedrive"] });
    expect(d.offered).toEqual(
      EIGHT.filter((n) => !n.startsWith("pagerduty__") && !n.startsWith("onedrive__")),
    );
    expect(d.offered).toHaveLength(4);
  });
});
