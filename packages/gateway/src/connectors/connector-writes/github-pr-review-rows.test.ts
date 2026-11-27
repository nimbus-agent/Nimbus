// The GitHub pull request review row (`@nimbus-dev/connectors` 0.19.0, `github-pr-review-rows.ts`):
// its typed preview, its drift keys against the installed connector's schema, its offer (Wave 2),
// its before-state reader and head-commit guard (bound like `github_pr_merge`'s `sha`), its
// reversibility (irreversible) and its door refusals, the inline comments' bodies included.
import { describe, expect, test } from "bun:test";

import { HITL_REQUIRED } from "../../engine/executor.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type { ChatopsPolicy } from "../../policy/types.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { beforeReaderProblems } from "./before-reader.ts";
import {
  GITHUB_PR_REVIEW_ROWS,
  GITHUB_REVIEW_HEAD_GUARD,
  selectGithubPrReviewTarget,
} from "./github-pr-review-rows.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import {
  installedRegistration,
  installedToolsSource,
  objectKeysAt,
} from "./installed-schema-keys.test-helpers.ts";
import { isModelOfferableRow, MODEL_NEVER_OFFERED_TOOL_IDS } from "./model-offerable.ts";
import {
  BROADCAST_MENTION_REFUSAL,
  messagingDestinationRefusal,
  modelWriteRefusal,
  nullOptionalFieldRefusal,
  nullRefusedOptionalKeys,
  REMOTE_CONTENT_REFUSAL,
  remoteContentScannedKeys,
  scannedTextKeys,
} from "./model-write-refusals.ts";
import { nestedTextKeys, nestedTextRefuses } from "./nested-text-refusals.ts";
import {
  buildConnectorWritePreviewFrom,
  type ConnectorWritePreview,
  renderConnectorWritePreviewLines,
} from "./preview.ts";
import { REVERSIBILITY_TABLE } from "./reversibility.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

const ID = "github_pr_review_create";
const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };
const HEAD = "0123456789abcdef0123456789abcdef01234567";

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

const CLEAN = {
  owner: "o",
  repo: "r",
  pullNumber: 12,
  event: "REQUEST_CHANGES",
  body: "Please add a test",
  commitId: HEAD,
};
const COMMENT = { path: "src/a.ts", line: 4, body: "This branch is never taken" };

describe("github_pr_review_create: the row", () => {
  test("a Wave 2 mesh row under its own frozen HITL type, offerable, never on the never-offered list", () => {
    expect(GITHUB_PR_REVIEW_ROWS.map((r) => r.toolId)).toEqual([ID]);
    const r = rowOf();
    expect(r.actionType).toBe("github.pr.review.create");
    expect(serviceOf(r.actionType)).toBe("github");
    expect(r.transport).toBe("mesh");
    expect(r.wave).toBe(2);
    expect(HITL_REQUIRED.has(r.actionType)).toBe(true);
    expect(isModelOfferableRow(r)).toBe(true);
    expect(MODEL_NEVER_OFFERED_TOOL_IDS.has(ID)).toBe(false);
    expect(r.confirm).toBeUndefined();
    expect(r.bound).toBeUndefined();
  });

  test("irreversible, with the owner's reason", () => {
    const decl = REVERSIBILITY_TABLE[ID]?.decl;
    expect(decl?.class).toBe("irreversible");
    expect(rowOf().reversibility?.class).toBe("irreversible");
    expect(JSON.stringify(decl)).toContain("cannot be deleted");
  });

  test("the template keys are exactly the installed connector's schema keys", () => {
    const t = rowOf().preview;
    if (t === undefined) throw new Error(ID);
    const want = ["body", "comments", "commitId", "event", "owner", "pullNumber", "repo"];
    expect([...previewTemplateKeys(t)].sort((a, b) => a.localeCompare(b))).toEqual(want);
    const gh = installedToolsSource("github");
    expect(installedRegistration(ID, "github")).toContain("githubPrReviewCreateSchema,");
    const keys = [
      ...objectKeysAt(gh, "const repoSlugArgs = z.object("),
      ...objectKeysAt(gh, "const githubPrNumberSchema = repoSlugArgs.extend("),
      ...objectKeysAt(gh, "const githubPrReviewCreateSchema = githubPrNumberSchema.extend("),
    ];
    expect(keys.sort((a, b) => a.localeCompare(b))).toEqual(want);
    // The inline comment's own keys, and the event enum without APPROVE.
    expect(objectKeysAt(gh, "const reviewCommentSchema = z.object(")).toEqual([
      "path",
      "line",
      "side",
      "startLine",
      "body",
    ]);
    expect(gh).toContain('event: z.enum(["COMMENT", "REQUEST_CHANGES"]');
  });
});

describe("github_pr_review_create: the typed preview", () => {
  test("golden lines: a pinned REQUEST_CHANGES review with no inline comments", () => {
    const p = previewOf(CLEAN);
    expect(renderConnectorWritePreviewLines(p)).toEqual([
      "Service: github",
      "Credential: personal",
      "Target:  o/r#12",
      "Submit a REQUEST_CHANGES review on GitHub pull request o/r#12; a submitted review cannot be deleted",
      "",
      '  Event (COMMENT, or REQUEST_CHANGES: blocks merging under a required-review rule until dismissed): "REQUEST_CHANGES"',
      '  Review: "Please add a test"',
      "  Inline comments on the diff (path, line, side, startLine, body): (not set: no inline comments)",
      `  Head commit the review is pinned to (must be the pull request's current head): "${HEAD}"`,
    ]);
    expect(p.otherFields).toEqual([]);
  });

  test("the inline comments are shown in full, each body verbatim", () => {
    const p = previewOf({
      ...CLEAN,
      comments: [COMMENT, { ...COMMENT, side: "LEFT", startLine: 2 }],
    });
    const shown = p.fields.find((f) => f.label.startsWith("Inline comments"))?.value ?? "";
    expect(shown).toContain('"path":"src/a.ts"');
    expect(shown).toContain('"body":"This branch is never taken"');
    expect(shown).toContain('"side":"LEFT"');
    expect(shown).toContain('"startLine":2');
    expect(p.otherFields).toEqual([]);
  });

  test("an unpinned review says it is refused", () => {
    const { commitId: _, ...unpinned } = CLEAN;
    expect(previewOf(unpinned).fields.find((f) => f.label.startsWith("Head commit"))?.value).toBe(
      "(not set: refused, the review must name the head commit)",
    );
  });

  test("no field is markdown or secret: the owner sees the exact characters", () => {
    for (const f of rowOf().preview?.fields ?? []) expect(f.kind, f.key).toBe("text");
  });
});

describe("github_pr_review_create: the before-state reader and the head binding", () => {
  const PR = {
    title: "Add cache",
    state: "open",
    head: { ref: "feat/cache", sha: HEAD },
    base: { ref: "main" },
    body: "DESCRIPTION-MUST-NOT-SHOW",
  };
  const mcp = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
  const guard = GITHUB_REVIEW_HEAD_GUARD;

  test("reads github_pr_get with exactly the repository and the number (the merge row's args)", () => {
    const r = rowOf();
    expect(beforeReaderProblems(r)).toEqual([]);
    expect(r.before?.tool).toBe("github_pr_get");
    expect(r.before?.args).toBe(
      CONNECTOR_WRITE_ROWS.find((x) => x.toolId === "github_pr_merge")?.before?.args,
    );
    expect(r.before?.args({ ...CLEAN, comments: [COMMENT] })).toEqual({
      owner: "o",
      repo: "r",
      pullNumber: 12,
    });
    expect(r.before?.select).toBe(selectGithubPrReviewTarget);
    expect(r.before?.guard).toBe(guard);
    expect(r.before?.argKeys).toContain("commitId");
  });

  test("shows the title, the state and the head commit, never the description", () => {
    const fields = selectGithubPrReviewTarget(mcp(PR));
    expect(fields).toEqual([
      { label: "Title", value: "Add cache" },
      { label: "State", value: "open" },
      { label: "Head commit", value: HEAD },
    ]);
    expect(JSON.stringify(fields)).not.toContain("DESCRIPTION-MUST-NOT-SHOW");
    expect(() => selectGithubPrReviewTarget(mcp({ state: "open" }))).toThrow();
  });

  test("the guard always applies and allows only a commitId equal to the head it read", () => {
    expect(guard.reason).not.toMatch(/\{\w+\}/);
    expect(guard.appliesTo({}, undefined)).toBe(true);
    const allows = (commitId: unknown, reply: unknown = mcp(PR)) =>
      guard.allows(reply, { commitId }, undefined, undefined);
    expect(allows(HEAD)).toBe(true);
    // A head pushed after the model looked: refused before the prompt.
    expect(allows("f".repeat(40))).toBe(false);
    expect(allows(undefined)).toBe(false);
    expect(allows(null)).toBe(false);
    expect(allows(HEAD.slice(0, 7))).toBe(false);
    expect(allows(HEAD.toUpperCase())).toBe(false);
    expect(allows(HEAD, mcp({ ...PR, head: {} }))).toBe(false);
    expect(() => allows(HEAD, { content: [] })).toThrow();
  });

  test("the guard is the merge's pin: same shape of check as GITHUB_MERGE_SHA_GUARD", () => {
    const merge = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === "github_pr_merge")?.before?.guard;
    if (merge === undefined) throw new Error("no merge guard");
    for (const v of [HEAD, "f".repeat(40), undefined]) {
      expect(guard.allows(mcp(PR), { commitId: v }, undefined, undefined)).toBe(
        merge.allows(mcp(PR), { sha: v }, undefined, undefined),
      );
    }
  });
});

describe("github_pr_review_create: door refusals (the review body and every inline comment body)", () => {
  test("the body is scanned for broadcast mentions and remote content, and is required", () => {
    expect(scannedTextKeys(ID)).toEqual(["body"]);
    expect(remoteContentScannedKeys(ID)).toEqual(["body"]);
    expect(nestedTextKeys(ID)).toEqual(["comments[].body"]);
    expect(onBothDoors(CLEAN)).toBeUndefined();
    expect(onBothDoors({ ...CLEAN, body: "cc @acme/core" })).toBe(BROADCAST_MENTION_REFUSAL);
    expect(onBothDoors({ ...CLEAN, body: "![x](https://h/p.png)" })).toBe(REMOTE_CONTENT_REFUSAL);
    const { body: _, ...noBody } = CLEAN;
    expect(onBothDoors(noBody)).toBe(BROADCAST_MENTION_REFUSAL);
  });

  test("each inline comment's body is scanned the same way", () => {
    const withComment = (body: unknown) => ({
      ...CLEAN,
      comments: [COMMENT, { ...COMMENT, body }],
    });
    expect(onBothDoors(withComment("see https://h/p"))).toBeUndefined();
    expect(onBothDoors(withComment("ping @acme/core"))).toBe(BROADCAST_MENTION_REFUSAL);
    expect(onBothDoors(withComment("![x](https://h/p.png)"))).toBe(REMOTE_CONTENT_REFUSAL);
    expect(onBothDoors(withComment('<img src="https://h/p.gif">'))).toBe(REMOTE_CONTENT_REFUSAL);
  });

  test("a shape the scan cannot read is refused (fail closed)", () => {
    expect(onBothDoors({ ...CLEAN, comments: "not a list" })).toBe(BROADCAST_MENTION_REFUSAL);
    expect(onBothDoors({ ...CLEAN, comments: [null] })).toBe(BROADCAST_MENTION_REFUSAL);
    expect(onBothDoors({ ...CLEAN, comments: [[COMMENT]] })).toBe(BROADCAST_MENTION_REFUSAL);
    expect(onBothDoors({ ...CLEAN, comments: [{ path: "a.ts", line: 1 }] })).toBe(
      BROADCAST_MENTION_REFUSAL,
    );
    expect(onBothDoors({ ...CLEAN, comments: [{ ...COMMENT, body: 7 }] })).toBe(
      BROADCAST_MENTION_REFUSAL,
    );
    expect(onBothDoors({ ...CLEAN, comments: [] })).toBeUndefined();
  });

  test("nestedTextRefuses: only its row, absent and null lists skipped, an inherited text refused", () => {
    const never = () => false;
    expect(nestedTextRefuses("github_issue_update", { comments: "x" }, never)).toBe(false);
    expect(nestedTextRefuses(ID, {}, never)).toBe(false);
    expect(nestedTextRefuses(ID, { comments: null }, never)).toBe(false);
    const inherited = Object.create({ body: "x" }) as Record<string, unknown>;
    expect(nestedTextRefuses(ID, { comments: [inherited] }, never)).toBe(true);
    expect(nestedTextRefuses(ID, { comments: [{ body: "x" }] }, never)).toBe(false);
    expect(nestedTextRefuses(ID, { comments: [{ body: "x" }] }, (t) => t === "x")).toBe(true);
    expect(nestedTextKeys("toString")).toEqual([]);
  });

  test("a null comments or commitId is refused before the prompt, naming the key", () => {
    expect(nullRefusedOptionalKeys(ID)).toEqual(["comments", "commitId"]);
    for (const key of ["comments", "commitId"]) {
      expect(onBothDoors({ ...CLEAN, [key]: null }), key).toBe(nullOptionalFieldRefusal(key));
      expect(onBothDoors({ ...CLEAN, [key]: undefined }), key).toBeUndefined();
    }
  });
});
