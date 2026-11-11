// Phase 10 SA2: the Gmail thread archive row (spec § 6.5): its typed preview, its before-state reader
// over `gmail_thread_read`, its place in the act door's tables, and the scope gate.
import { describe, expect, test } from "bun:test";

import { HITL_REQUIRED } from "../../engine/executor.ts";
import { ACTION_PROPOSABILITY, PROPOSABLE_WRITE_TOOLS } from "../proposable-actions.ts";
import { enableWritesPromptLines } from "./enable-prompt.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { selectGmailThreadArchive } from "./mail-calendar.ts";
import { isModelOfferableRow, MODEL_NEVER_OFFERED_TOOL_IDS } from "./model-offerable.ts";
import { buildConnectorWritePreview, renderConnectorWritePreviewLines } from "./preview.ts";
import { SCOPE_GATED_WRITES, scopeGatedReason } from "./scope-gated.ts";

const ROW = CONNECTOR_WRITE_ROWS.find((r) => r.toolId === "gmail_thread_archive");

function thread(messages: unknown[], id = "18c0ffee"): unknown {
  return { id, messages };
}
function msg(labelIds: string[] | undefined, subject?: string): unknown {
  return {
    id: "m",
    ...(labelIds === undefined ? {} : { labelIds }),
    payload: {
      headers: [
        { name: "From", value: "a@example.com" },
        ...(subject === undefined ? [] : [{ name: "SUBJECT", value: subject }]),
      ],
    },
  };
}

describe("the row", () => {
  test("wave 2, mesh, templated, with a gmail_thread_read reader, offered to the model", () => {
    expect(ROW?.actionType).toBe("gmail.thread.archive");
    expect(ROW?.wave).toBe(2);
    expect(ROW?.transport).toBe("mesh");
    expect(ROW?.preview?.target).toBe("{threadId}");
    expect(ROW?.before?.tool).toBe("gmail_thread_read");
    expect(ROW !== undefined && isModelOfferableRow(ROW)).toBe(true);
    expect(MODEL_NEVER_OFFERED_TOOL_IDS.has("gmail_thread_archive")).toBe(false);
  });

  test("the reader reads the thread at format metadata and only for a non-empty id", () => {
    const before = ROW?.before;
    expect(before?.args({ threadId: "abc123" })).toEqual({
      threadId: "abc123",
      format: "metadata",
    });
    for (const bad of [undefined, "", 7, null]) {
      expect(before?.args({ threadId: bad })).toBeUndefined();
    }
  });

  test("in the HITL set; withheld from the act door as not_yet_offered", () => {
    expect(HITL_REQUIRED.has("gmail.thread.archive")).toBe(true);
    expect(ACTION_PROPOSABILITY["gmail.thread.archive"]).toEqual({
      kind: "denied",
      class: "not_yet_offered",
    });
    expect(PROPOSABLE_WRITE_TOOLS["gmail.thread.archive"]).toBeUndefined();
  });

  test("the preview names the thread and says nothing is deleted", () => {
    const preview = buildConnectorWritePreview({
      type: "gmail.thread.archive",
      payload: { mcpToolId: "gmail_thread_archive", input: { threadId: "18c0ffee" } },
    });
    const text = renderConnectorWritePreviewLines(preview as never).join("\n");
    expect(text).toContain("18c0ffee");
    expect(text).toContain("nothing is deleted");
  });
});

describe("selectGmailThreadArchive", () => {
  test("an inbox thread with unread mail: subject, count, unread and inbox lines", () => {
    const fields = selectGmailThreadArchive(
      thread([msg(["INBOX", "UNREAD"], "Quarterly numbers"), msg(["INBOX"]), msg(["SENT"])]),
    );
    expect(fields).toEqual([
      { label: "Subject", value: "Quarterly numbers" },
      { label: "Messages", value: "3" },
      { label: "Unread", value: "yes: 1 of 3 messages" },
      { label: "In the inbox", value: "yes: 2 of 3 messages" },
    ]);
  });

  test("a read thread is not unread; a thread with no inbox message reads already archived", () => {
    const fields = selectGmailThreadArchive(thread([msg(["CATEGORY_UPDATES"], "Receipt")]));
    expect(fields[2]).toEqual({ label: "Unread", value: "no" });
    expect(fields[3]).toEqual({ label: "In the inbox", value: "no (already archived)" });
  });

  test("no Subject header reads (no subject); a long subject is capped", () => {
    expect(selectGmailThreadArchive(thread([msg(["INBOX"])]))[0]?.value).toBe("(no subject)");
    const long = selectGmailThreadArchive(thread([msg(["INBOX"], "x".repeat(2000))]))[0]?.value;
    expect(long).toContain("more characters not shown");
  });

  test("an MCP result wrapper is unwrapped", () => {
    const wrapped = {
      content: [{ type: "text", text: JSON.stringify(thread([msg(["INBOX"], "Hi")])) }],
    };
    expect(selectGmailThreadArchive(wrapped)[0]).toEqual({ label: "Subject", value: "Hi" });
  });

  test("a reply that cannot be read throws, so the prompt says unavailable", () => {
    expect(() => selectGmailThreadArchive(thread([]))).toThrow();
    expect(() => selectGmailThreadArchive({ id: "x" })).toThrow();
    expect(() => selectGmailThreadArchive({ messages: [msg(["INBOX"])] })).toThrow();
    expect(() => selectGmailThreadArchive(thread([msg(undefined, "s")]))).toThrow(/no labels/);
    expect(() => selectGmailThreadArchive("nope")).toThrow();
  });

  test("a message with no headers list has no subject but still reads", () => {
    const fields = selectGmailThreadArchive(thread([{ id: "m", labelIds: ["INBOX"] }]));
    expect(fields[0]?.value).toBe("(no subject)");
  });
});

describe("scopeGatedReason", () => {
  const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
  test("the table gates exactly the archive row", () => {
    expect(Object.keys(SCOPE_GATED_WRITES)).toEqual(["gmail_thread_archive"]);
  });
  test("modify or the full-mailbox scope lifts the gate; anything else keeps it", () => {
    expect(scopeGatedReason("gmail_thread_archive", { gmail: `a ${MODIFY}` })).toBeUndefined();
    expect(scopeGatedReason("gmail_thread_archive", { gmail: "https://mail.google.com/" })).toBe(
      undefined,
    );
    for (const gmail of [undefined, "", "https://www.googleapis.com/auth/gmail.readonly"]) {
      expect(scopeGatedReason("gmail_thread_archive", { gmail })).toBe(
        "re-authorise Gmail to grant gmail.modify",
      );
    }
  });
  test("no map, a service the map lacks, or an ungated tool make no claim", () => {
    expect(scopeGatedReason("gmail_thread_archive", undefined)).toBeUndefined();
    expect(scopeGatedReason("gmail_thread_archive", {})).toBeUndefined();
    expect(scopeGatedReason("gmail_draft_create", { gmail: undefined })).toBeUndefined();
    expect(scopeGatedReason("constructor", { gmail: undefined })).toBeUndefined();
  });
});

describe("the enable prompt line for a scope-gated write", () => {
  const base = {
    toolId: "gmail_thread_archive",
    actionType: "gmail.thread.archive",
    wave: 2,
    offerable: false,
    state: "not_offerable",
  };
  test("a reason replaces the marker", () => {
    const lines = enableWritesPromptLines({
      service: "gmail",
      maxWave: 2,
      writes: [{ ...base, reason: "re-authorise Gmail to grant gmail.modify" }],
    });
    expect(lines?.[2]).toBe(
      "  gmail_thread_archive  gmail.thread.archive  wave 2  (not offered yet: re-authorise Gmail to grant gmail.modify)",
    );
  });
  test("a reason on an offerable write, or a non-string reason, is malformed", () => {
    expect(
      enableWritesPromptLines({
        service: "gmail",
        maxWave: 2,
        writes: [{ ...base, offerable: true, state: "newly_offerable", reason: "x" }],
      }),
    ).toBeUndefined();
    expect(
      enableWritesPromptLines({ service: "gmail", maxWave: 2, writes: [{ ...base, reason: 5 }] }),
    ).toBeUndefined();
  });
});
