import { describe, expect, test } from "bun:test";
import { ApprovalPresenter } from "./approval-presenter.ts";
import { runWithChatopsApprovalContext } from "./chatops-request-context.ts";
import type { ChatCard, ChatPlatform } from "./types.ts";

const CTX = {
  ownerEmail: "alice@acme.com",
  ownerExternalId: "ext-alice",
  originatingChannelId: "C_ORIG",
  requesterExternalId: "ext-bob",
  actionLabel: "github.pr.merge owner=acme",
};

interface Posted {
  channelId: string;
  text: string;
  card: ChatCard | undefined;
}

function build(
  opts: {
    platform?: ChatPlatform;
    post?: (p: Posted) => Promise<void>;
    onPost?: (presenter: ApprovalPresenter) => void;
  } = {},
): { presenter: ApprovalPresenter; posted: Posted[] } {
  const posted: Posted[] = [];
  const presenter: ApprovalPresenter = new ApprovalPresenter({
    post: async (channelId, text, card) => {
      const p = { channelId, text, card };
      posted.push(p);
      opts.onPost?.(presenter);
      await opts.post?.(p);
    },
    ownerChannelFor: () => "C_ALICE",
    ...(opts.platform === undefined ? {} : { platformFor: () => opts.platform }),
  });
  return { presenter, posted };
}

const request = (presenter: ApprovalPresenter, text = "github/merge acme/api#12") =>
  runWithChatopsApprovalContext(CTX, () => presenter.requestTypedApproval(text));

describe("ApprovalPresenter: a type-to-confirm card", () => {
  test("registers the entry BEFORE the post, so a submit that races the post still resolves", async () => {
    let kindAtPost: string | undefined;
    let resolvedEarly = false;
    const { presenter } = build({
      onPost: (p) => {
        kindAtPost = p.pendingKind(p.lastRequestId());
        resolvedEarly = p.resolveConfirmSubmit({
          requestId: p.lastRequestId(),
          approverExternalId: "ext-alice",
          approved: true,
          typed: "github/merge acme/api#12",
        });
      },
    });
    const outcome = await request(presenter);
    expect(kindAtPost).toBe("confirm");
    expect(resolvedEarly).toBe(true);
    expect(outcome).toEqual({
      kind: "answered",
      peerId: "ext-alice",
      approved: true,
      typed: "github/merge acme/api#12",
    });
  });

  test("posts a Slack card with blocks and the fixed fallback line; Teams gets an attachment", async () => {
    const slack = build({ platform: "slack" });
    const p1 = request(slack.presenter);
    expect(slack.posted[0]?.card?.slackBlocks).toBeDefined();
    expect(slack.posted[0]?.text).toContain(
      "To approve, type exactly: github/merge acme/api#12 in the form opened by Confirm.",
    );
    slack.presenter.resolveClick({
      requestId: slack.presenter.lastRequestId(),
      approverExternalId: "ext-alice",
      approved: false,
    });
    await p1;

    const teams = build({ platform: "teams" });
    const p2 = request(teams.presenter);
    expect(teams.posted[0]?.card?.teamsAttachment).toBeDefined();
    expect(teams.posted[0]?.card?.slackBlocks).toBeUndefined();
    teams.presenter.resolveClick({
      requestId: teams.presenter.lastRequestId(),
      approverExternalId: "ext-alice",
      approved: false,
    });
    await p2;
  });

  test("an unknown platform defaults to Slack", async () => {
    const { presenter, posted } = build();
    const p = request(presenter);
    expect(posted[0]?.card?.slackBlocks).toBeDefined();
    presenter.resolveClick({
      requestId: presenter.lastRequestId(),
      approverExternalId: "ext-alice",
      approved: false,
    });
    await p;
  });

  test("open: the owner gets the channel, label and confirm text; a non-owner and an unknown id get nothing", async () => {
    const { presenter } = build();
    const p = request(presenter);
    const requestId = presenter.lastRequestId();
    expect(presenter.resolveConfirmOpen({ requestId, clickerExternalId: "ext-alice" })).toEqual({
      channelId: "C_ALICE",
      label: CTX.actionLabel,
      confirmText: "github/merge acme/api#12",
    });
    expect(
      presenter.resolveConfirmOpen({ requestId, clickerExternalId: "ext-bob" }),
    ).toBeUndefined();
    expect(
      presenter.resolveConfirmOpen({ requestId: "nope", clickerExternalId: "ext-alice" }),
    ).toBeUndefined();
    presenter.resolveClick({ requestId, approverExternalId: "ext-alice", approved: false });
    await p;
  });

  test("open on a plain card returns nothing", async () => {
    const { presenter } = build();
    const p = runWithChatopsApprovalContext(CTX, () => presenter.requestApproval());
    const requestId = presenter.lastRequestId();
    expect(presenter.pendingKind(requestId)).toBe("plain");
    expect(
      presenter.resolveConfirmOpen({ requestId, clickerExternalId: "ext-alice" }),
    ).toBeUndefined();
    expect(
      presenter.resolveConfirmSubmit({
        requestId,
        approverExternalId: "ext-alice",
        approved: true,
        typed: "x",
      }),
    ).toBe(false);
    presenter.resolveClick({ requestId, approverExternalId: "ext-alice", approved: true });
    await p;
  });

  test("a non-owner submit does not spend the card; the owner's correct submit then resolves it", async () => {
    const { presenter } = build();
    const p = request(presenter);
    const requestId = presenter.lastRequestId();
    expect(
      presenter.resolveConfirmSubmit({
        requestId,
        approverExternalId: "ext-bob",
        approved: true,
        typed: "x",
      }),
    ).toBe(false);
    expect(presenter.pendingKind(requestId)).toBe("confirm");
    expect(
      presenter.resolveConfirmSubmit({
        requestId,
        approverExternalId: "ext-alice",
        approved: true,
        typed: "github/merge acme/api#12",
      }),
    ).toBe(true);
    expect(await p).toMatchObject({ approved: true, typed: "github/merge acme/api#12" });
    expect(presenter.pendingKind(requestId)).toBeUndefined();
  });

  test("a reject submit resolves approved false with no typed text; a replay finds nothing", async () => {
    const { presenter } = build();
    const p = request(presenter);
    const requestId = presenter.lastRequestId();
    expect(
      presenter.resolveConfirmSubmit({
        requestId,
        approverExternalId: "ext-alice",
        approved: false,
        typed: "ignored",
      }),
    ).toBe(true);
    expect(await p).toEqual({ kind: "answered", peerId: "ext-alice", approved: false });
    expect(
      presenter.resolveConfirmSubmit({
        requestId,
        approverExternalId: "ext-alice",
        approved: false,
        typed: "",
      }),
    ).toBe(false);
  });

  test.each([
    ["a non-string", 42],
    ["undefined", undefined],
    ["an over-cap string", "a".repeat(513)],
  ])(
    "%s typed value reaches the executor as an empty string (a mismatch there), approved stays true",
    async (_n, typed) => {
      const { presenter } = build();
      const p = request(presenter);
      presenter.resolveConfirmSubmit({
        requestId: presenter.lastRequestId(),
        approverExternalId: "ext-alice",
        approved: true,
        typed,
      });
      expect(await p).toEqual({ kind: "answered", peerId: "ext-alice", approved: true, typed: "" });
    },
  );

  test("the typed text is passed through untouched (no trim, no case change)", async () => {
    const { presenter } = build();
    const p = request(presenter);
    presenter.resolveConfirmSubmit({
      requestId: presenter.lastRequestId(),
      approverExternalId: "ext-alice",
      approved: true,
      typed: "  Github/Merge  ",
    });
    expect(await p).toMatchObject({ typed: "  Github/Merge  " });
  });

  test("a text approve never resolves a confirm card; a non-owner reject does not spend it; the owner's reject does", async () => {
    const { presenter } = build();
    const p = request(presenter);
    const requestId = presenter.lastRequestId();
    expect(
      presenter.resolveClick({ requestId, approverExternalId: "ext-alice", approved: true }),
    ).toBe(false);
    expect(
      presenter.resolveClick({ requestId, approverExternalId: "ext-bob", approved: false }),
    ).toBe(false);
    expect(presenter.pendingKind(requestId)).toBe("confirm");
    expect(
      presenter.resolveClick({ requestId, approverExternalId: "ext-alice", approved: false }),
    ).toBe(true);
    expect(await p).toEqual({ kind: "answered", peerId: "ext-alice", approved: false });
  });

  test("a confirm text over the form cap posts no card and times out (not delegated)", async () => {
    const { presenter, posted } = build();
    const outcome = await request(presenter, "x".repeat(513));
    expect(outcome).toEqual({ kind: "timeout" });
    expect(posted).toEqual([]);
  });

  test("no context or no owner channel times out without a post", async () => {
    const { presenter, posted } = build();
    expect(await presenter.requestTypedApproval("t")).toEqual({ kind: "timeout" });
    const none = new ApprovalPresenter({ post: async () => {}, ownerChannelFor: () => undefined });
    expect(await runWithChatopsApprovalContext(CTX, () => none.requestTypedApproval("t"))).toEqual({
      kind: "timeout",
    });
    expect(posted).toEqual([]);
  });

  test("a failed post deletes the entry and rethrows", async () => {
    const { presenter } = build({
      post: async () => {
        throw new Error("ledger append failed");
      },
    });
    await expect(request(presenter)).rejects.toThrow("ledger append failed");
    const requestId = presenter.lastRequestId();
    expect(presenter.pendingKind(requestId)).toBeUndefined();
    expect(
      presenter.resolveConfirmSubmit({
        requestId,
        approverExternalId: "ext-alice",
        approved: true,
        typed: "x",
      }),
    ).toBe(false);
  });
});
