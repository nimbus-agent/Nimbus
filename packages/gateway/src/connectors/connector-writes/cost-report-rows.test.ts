import { describe, expect, test } from "bun:test";

import type { ChatopsPolicy } from "../../policy/types.ts";
import { COST_REPORT_POST_TOOL_IDS, costReportDoorRefusal } from "./cost-report-rows.ts";

const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };
const CHATOPS: ChatopsPolicy = {
  channels: new Map([
    ["C0CHATOPS", { namespace: "project:pay", unmapped: "refuse" as const, notify: [] }],
  ]),
  ownership: new Map(),
};

describe("costReportDoorRefusal", () => {
  test("names each kind's write row in this directory only (static D20)", () => {
    expect(COST_REPORT_POST_TOOL_IDS).toEqual({
      slack: "slack_message_post",
      teams: "teams_message_post",
      gmail: "gmail_draft_create",
      outlook: "outlook_draft_create",
    });
  });

  test("a clean post to an ordinary channel or a draft passes", () => {
    expect(
      costReportDoorRefusal(
        {
          kind: "slack",
          to: "C0123ABC",
          format: "markdown",
          body: "Cost: 1.00 USD",
          subject: null,
        },
        NO_CHATOPS,
      ),
    ).toBeNull();
    expect(
      costReportDoorRefusal(
        { kind: "outlook", to: ["a@b.co"], format: "html", body: "<p>x</p>", subject: "S" },
        undefined,
      ),
    ).toBeNull();
    expect(
      costReportDoorRefusal(
        { kind: "gmail", to: ["a@b.co"], format: "text", body: "x", subject: "S" },
        undefined,
      ),
    ).toBeNull();
  });

  test("a ChatOps channel, or no readable ChatOps policy, refuses a Slack or Teams post", () => {
    expect(
      costReportDoorRefusal(
        { kind: "slack", to: "C0CHATOPS", format: "text", body: "x", subject: null },
        CHATOPS,
      ),
    ).toBe("the destination is a ChatOps channel, which only answers ChatOps commands");
    expect(
      costReportDoorRefusal(
        { kind: "slack", to: "C0123ABC", format: "text", body: "x", subject: null },
        undefined,
      ),
    ).toBe(
      "the ChatOps policy could not be read, so no Slack or Teams post can be checked against its channels",
    );
    expect(
      costReportDoorRefusal(
        {
          kind: "teams",
          to: { team: "t", channel: "c" },
          format: "text",
          body: "x",
          subject: null,
        },
        undefined,
      ),
    ).toContain("ChatOps policy could not be read");
  });

  test("a broadcast mention and remote content in the body are refused in report wording", () => {
    expect(
      costReportDoorRefusal(
        { kind: "slack", to: "C0123ABC", format: "text", body: "<!here> x", subject: null },
        NO_CHATOPS,
      ),
    ).toBe("the body notifies a whole channel, group or team (a broadcast mention)");
    expect(
      costReportDoorRefusal(
        {
          kind: "teams",
          to: { team: "t", channel: "c" },
          format: "html",
          body: '<img src="https://x/a.png">',
          subject: null,
        },
        NO_CHATOPS,
      ),
    ).toBe(
      "the body loads remote content (an external image, embed, frame or stylesheet) when it is opened",
    );
    // A Teams `text` body is posted as text: an <img> there is not html.
    expect(
      costReportDoorRefusal(
        {
          kind: "teams",
          to: { team: "t", channel: "c" },
          format: "text",
          body: '<img src="https://x/a.png">',
          subject: null,
        },
        NO_CHATOPS,
      ),
    ).toBeNull();
  });
});
