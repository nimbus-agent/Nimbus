import { describe, expect, test } from "bun:test";
import {
  CONFIRM_LABEL_MAX,
  CONFIRM_TYPED_MAX,
  clipLabel,
  confirmCardFor,
  confirmFallbackLine,
  confirmInstruction,
  escapeTeamsMarkdown,
  slackConfirmBlocks,
  slackConfirmView,
  teamsConfirmCard,
} from "./confirm-card.ts";

const INPUT = {
  requestId: "req-1",
  label: "github.pr.merge owner=acme",
  confirmText: "github/merge acme/api#12",
};

describe("slackConfirmBlocks", () => {
  test("pins the card shape: a plain_text section and two buttons carrying the request id", () => {
    expect(slackConfirmBlocks(INPUT)).toEqual([
      { type: "section", text: { type: "plain_text", text: INPUT.label } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Confirm…" },
            action_id: "nimbus_confirm_open",
            value: "req-1",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Reject" },
            action_id: "nimbus_confirm_reject",
            value: "req-1",
            style: "danger",
          },
        ],
      },
    ]);
  });
});

describe("slackConfirmView", () => {
  test("pins the modal shape and carries the confirm text verbatim", () => {
    const view = slackConfirmView(INPUT) as Record<string, unknown>;
    expect(view).toEqual({
      type: "modal",
      callback_id: "nimbus_confirm",
      private_metadata: "req-1",
      title: { type: "plain_text", text: "Confirm action" },
      submit: { type: "plain_text", text: "Approve" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "section",
          text: {
            type: "plain_text",
            text: `${INPUT.label}\nTo approve, type exactly: github/merge acme/api#12`,
          },
        },
        {
          type: "input",
          block_id: "confirm",
          label: { type: "plain_text", text: "Confirmation" },
          element: { type: "plain_text_input", action_id: "typed", max_length: 512 },
        },
      ],
    });
    expect(((view["title"] as { text: string }).text ?? "").length).toBeLessThanOrEqual(24);
  });

  test("a long label is clipped but the confirm text is never clipped or rewritten", () => {
    const confirmText = "x".repeat(CONFIRM_TYPED_MAX);
    const view = JSON.stringify(
      slackConfirmView({ requestId: "r", label: "L".repeat(5000), confirmText }),
    );
    expect(view).toContain(confirmText);
    expect(view).toContain("…");
    expect(view).not.toContain("L".repeat(CONFIRM_LABEL_MAX + 1));
  });
});

describe("teamsConfirmCard", () => {
  test("pins the Adaptive Card 1.4 shape", () => {
    expect(teamsConfirmCard(INPUT)).toEqual({
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          { type: "TextBlock", text: "github.pr.merge owner=acme", wrap: true },
          {
            type: "TextBlock",
            text: "To approve, type exactly: github/merge acme/api#12".replace("#", "\\#"),
            wrap: true,
          },
          { type: "Input.Text", id: "typed", label: "Confirmation", maxLength: 512 },
        ],
        actions: [
          {
            type: "Action.Submit",
            title: "Approve",
            data: { nimbusConfirm: "req-1", verdict: "approve" },
          },
          {
            type: "Action.Submit",
            title: "Reject",
            data: { nimbusConfirm: "req-1", verdict: "reject" },
          },
        ],
      },
    });
  });

  test("escapes every Markdown metacharacter with a backslash", () => {
    expect(escapeTeamsMarkdown("*_~`[]()#")).toBe("\\*\\_\\~\\`\\[\\]\\(\\)\\#");
    expect(escapeTeamsMarkdown("plain text 1/2")).toBe("plain text 1/2");
    // A backslash is escaped too, so `\\*` cannot turn into an escaped backslash and live emphasis.
    expect(escapeTeamsMarkdown("a\\*b")).toBe("a\\\\\\*b");
  });
});

describe("helpers", () => {
  test("clipLabel leaves a short label and clips a long one to the cap with an ellipsis", () => {
    expect(clipLabel("short")).toBe("short");
    const clipped = clipLabel("a".repeat(CONFIRM_LABEL_MAX + 10));
    expect(clipped).toHaveLength(CONFIRM_LABEL_MAX);
    expect(clipped.endsWith("…")).toBe(true);
  });

  test("the instruction and fallback lines carry the confirm text verbatim", () => {
    expect(confirmInstruction("k8s/apply prod/deploy/web")).toBe(
      "To approve, type exactly: k8s/apply prod/deploy/web",
    );
    expect(confirmFallbackLine("t")).toBe(
      "To approve, type exactly: t in the form opened by Confirm.",
    );
  });

  test("confirmCardFor builds the platform's own card", () => {
    expect(confirmCardFor("slack", INPUT).slackBlocks).toBeDefined();
    expect(confirmCardFor("slack", INPUT).teamsAttachment).toBeUndefined();
    expect(confirmCardFor("teams", INPUT).teamsAttachment).toBeDefined();
    expect(confirmCardFor("teams", INPUT).slackBlocks).toBeUndefined();
  });
});
