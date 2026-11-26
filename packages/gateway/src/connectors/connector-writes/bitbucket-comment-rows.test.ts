// The Bitbucket pull request comment row (`@nimbus-dev/connectors` PR 106): its typed preview, its
// drift keys against the installed connector's schema, its offer (Wave 2, like the GitHub and
// GitLab comments), its before-state reader, its reversibility and its door refusals.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HITL_REQUIRED } from "../../engine/executor.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type { ChatopsPolicy } from "../../policy/types.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { installedConnectorsPackageRoot } from "../testing/connector-write-registrations.ts";
import { beforeReaderProblems } from "./before-reader.ts";
import { selectBitbucketPrIdentity } from "./bitbucket-comment-rows.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow, MODEL_NEVER_OFFERED_TOOL_IDS } from "./model-offerable.ts";
import {
  messagingDestinationRefusal,
  modelWriteRefusal,
  nullOptionalFieldRefusal,
  nullRefusedOptionalKeys,
  REMOTE_CONTENT_REFUSAL,
  remoteContentScannedKeys,
  scannedTextKeys,
} from "./model-write-refusals.ts";
import {
  buildConnectorWritePreviewFrom,
  type ConnectorWritePreview,
  renderConnectorWritePreviewLines,
} from "./preview.ts";
import { REVERSIBILITY_TABLE } from "./reversibility.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

const ID = "bitbucket_pr_comment_create";
const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };

function rowOf(): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === ID);
  if (r === undefined) throw new Error(`no row ${ID}`);
  return r;
}

function previewOf(input: Record<string, unknown>): ConnectorWritePreview {
  const r = rowOf();
  const p = buildConnectorWritePreviewFrom(
    {
      type: r.actionType,
      origin: "model",
      payload: { mcpToolId: mcpClientToolKey(serviceOf(r.actionType), ID), input },
    },
    CONNECTOR_WRITE_ROWS,
    () => "personal",
  );
  if (p === undefined) throw new Error(`no preview for ${ID}`);
  return p;
}

/** Both door entry points give the same answer (the rule is in the shared check). */
function onBothDoors(input: Readonly<Record<string, unknown>>): string | undefined {
  const messaging = messagingDestinationRefusal(ID, input, { chatops: NO_CHATOPS });
  expect(modelWriteRefusal(ID, input, { chatops: NO_CHATOPS, kb: undefined })).toBe(messaging);
  return messaging;
}

const CLEAN = { repoFull: "ws/app", pullRequestId: 9, body: "LGTM" };

describe("bitbucket_pr_comment_create: the row", () => {
  test("a Wave 2 mesh row under its own frozen HITL type, offerable, never on the never-offered list", () => {
    const r = rowOf();
    expect(r.actionType).toBe("bitbucket.pr.comment.create");
    expect(serviceOf(r.actionType)).toBe("bitbucket");
    expect(r.transport).toBe("mesh");
    expect(r.wave).toBe(2);
    expect(HITL_REQUIRED.has(r.actionType)).toBe(true);
    expect(isModelOfferableRow(r)).toBe(true);
    expect(MODEL_NEVER_OFFERED_TOOL_IDS.has(ID)).toBe(false);
    expect(r.confirm).toBeUndefined();
    expect(r.bound).toBeUndefined();
  });

  test("irreversible, with a reason (owner ruling: the connector has no comment delete)", () => {
    const decl = REVERSIBILITY_TABLE[ID]?.decl;
    expect(decl?.class).toBe("irreversible");
    expect(rowOf().reversibility?.class).toBe("irreversible");
  });

  test("the template keys are exactly the installed connector's schema keys", () => {
    const t = rowOf().preview;
    if (t === undefined) throw new Error(ID);
    expect([...previewTemplateKeys(t)].sort((a, b) => a.localeCompare(b))).toEqual([
      "body",
      "line",
      "path",
      "pullRequestId",
      "repoFull",
    ]);
    // The connector's own schema: `repoFullArg` (repoFull) extended with these four keys.
    const src = readFileSync(
      join(installedConnectorsPackageRoot(), "connectors", "bitbucket", "src", "tools.ts"),
      "utf8",
    );
    expect(src).toContain(`"${ID}"`);
    const at = src.indexOf("const bitbucketPrCommentCreateSchema = repoFullArg.extend({");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("});", at));
    const keys = [...block.matchAll(/^ {4}([A-Za-z]+): z/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(["body", "line", "path", "pullRequestId"]);
  });
});

describe("bitbucket_pr_comment_create: the typed preview", () => {
  test("golden lines: a comment on the whole pull request", () => {
    const p = previewOf(CLEAN);
    expect(renderConnectorWritePreviewLines(p)).toEqual([
      "Service: bitbucket",
      "Credential: personal",
      "Target:  ws/app#9",
      "Comment on Bitbucket pull request ws/app#9",
      "",
      '  Comment: "LGTM"',
      "  File: (not set: a comment on the whole pull request)",
      "  Line (in the new version of the file): (not set: no line)",
    ]);
    expect(p.otherFields).toEqual([]);
  });

  test("an inline comment shows the file and the line", () => {
    const p = previewOf({ ...CLEAN, path: "src/a.ts", line: 12 });
    expect(p.fields.find((f) => f.label === "File")?.value).toBe('"src/a.ts"');
    expect(p.fields.find((f) => f.label === "Line (in the new version of the file)")?.value).toBe(
      "12",
    );
    expect(p.otherFields).toEqual([]);
  });

  test("no field is markdown or secret: the owner sees the exact characters", () => {
    for (const f of rowOf().preview?.fields ?? []) expect(f.kind, f.key).toBe("text");
  });
});

describe("bitbucket_pr_comment_create: door refusals (mirroring the GitHub and GitLab comments)", () => {
  test("the body is scanned for remote content, as forge Markdown, and is required", () => {
    expect(remoteContentScannedKeys(ID)).toEqual(["body"]);
    expect(onBothDoors({ ...CLEAN, body: "![x](https://h/p.png)" })).toBe(REMOTE_CONTENT_REFUSAL);
    expect(onBothDoors({ repoFull: "ws/app", pullRequestId: 9 })).toBe(REMOTE_CONTENT_REFUSAL);
    expect(onBothDoors({ ...CLEAN, body: 42 })).toBe(REMOTE_CONTENT_REFUSAL);
  });

  test("a plain comment and a plain link are allowed", () => {
    expect(onBothDoors(CLEAN)).toBeUndefined();
    expect(
      onBothDoors({ ...CLEAN, body: "see https://h/p", path: "a.ts", line: 3 }),
    ).toBeUndefined();
  });

  // Stated, not refused: BroadcastService has no Bitbucket rule (no group-mention form of Bitbucket
  // Cloud is verified here), and quick actions are GitLab's. Each mentioned user is in the preview.
  test("not scanned for broadcast mentions or quick actions (stated bound)", () => {
    expect(scannedTextKeys(ID)).toEqual([]);
    expect(onBothDoors({ ...CLEAN, body: "@all /merge" })).toBeUndefined();
  });

  test("a null path or line is refused before the prompt, naming the key, not shown as unset", () => {
    expect(nullRefusedOptionalKeys(ID)).toEqual(["path", "line"]);
    for (const key of ["path", "line"]) {
      expect(onBothDoors({ ...CLEAN, [key]: null }), key).toBe(nullOptionalFieldRefusal(key));
      expect(onBothDoors({ ...CLEAN, [key]: undefined }), key).toBeUndefined();
    }
    // The body is required, so a null body stays the remote-content refusal, not this one.
    expect(onBothDoors({ ...CLEAN, body: null })).toBe(REMOTE_CONTENT_REFUSAL);
  });
});

describe("bitbucket_pr_comment_create: the before-state reader (like the GitLab MR comment)", () => {
  const PR = {
    title: "Add cache",
    state: "OPEN",
    source: { branch: { name: "feat/cache" }, commit: { hash: "abc123" } },
    destination: { branch: { name: "main" } },
    description: "DESCRIPTION-MUST-NOT-SHOW",
  };
  const mcp = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

  test("reads bitbucket_pr_get with exactly the repository and the id (the merge row's reader)", () => {
    const r = rowOf();
    expect(beforeReaderProblems(r)).toEqual([]);
    expect(r.before?.tool).toBe("bitbucket_pr_get");
    expect(r.before?.args).toBe(
      CONNECTOR_WRITE_ROWS.find((x) => x.toolId === "bitbucket_pr_merge")?.before?.args,
    );
    expect(r.before?.args({ ...CLEAN, path: "a.ts", line: 3 })).toEqual({
      repoFull: "ws/app",
      pullRequestId: 9,
    });
    expect(r.before?.args({ repoFull: "ws/app", pullRequestId: 0, body: "x" })).toBeUndefined();
    expect(r.before?.select).toBe(selectBitbucketPrIdentity);
  });

  test("shows the title, the state and the branches, never the description", () => {
    const fields = selectBitbucketPrIdentity(mcp(PR));
    expect(fields).toEqual([
      { label: "Title", value: "Add cache" },
      { label: "State", value: "OPEN" },
      { label: "Branches", value: "feat/cache -> main" },
    ]);
    expect(JSON.stringify(fields)).not.toContain("DESCRIPTION-MUST-NOT-SHOW");
  });

  test("absent optional fields are omitted; a reply without a title throws (unavailable)", () => {
    expect(selectBitbucketPrIdentity(mcp({ title: "t", source: PR.source }))).toEqual([
      { label: "Title", value: "t" },
    ]);
    expect(() => selectBitbucketPrIdentity(mcp({ state: "OPEN" }))).toThrow();
  });
});
