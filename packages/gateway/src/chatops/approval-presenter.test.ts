import { describe, expect, test } from "bun:test";
import { ApprovalPresenter } from "./approval-presenter.ts";
import { runWithChatopsApprovalContext } from "./chatops-request-context.ts";

describe("ApprovalPresenter + request context", () => {
  test("posts a card to the owner and resolves with the clicker identity", async () => {
    const posts: { channelId: string; text: string }[] = [];
    const presenter = new ApprovalPresenter({
      post: async (channelId, text) => {
        posts.push({ channelId, text });
      },
      ownerChannelFor: (email) => (email === "alice@acme.com" ? "C_ALICE" : undefined),
    });
    const ctx = {
      ownerEmail: "alice@acme.com",
      ownerExternalId: "ext-alice",
      originatingChannelId: "C_ORIG",
      requesterExternalId: "ext-bob",
      actionLabel: "deployment.rollback service=payment-service",
    };
    const p = runWithChatopsApprovalContext(ctx, () => presenter.requestApproval());
    // Simulate Alice clicking Approve.
    presenter.resolveClick({
      requestId: presenter.lastRequestId(),
      approverExternalId: "ext-alice",
      approved: true,
    });
    const outcome = await p;
    expect(outcome).toEqual({ kind: "answered", peerId: "ext-alice", approved: true });
    expect(posts[0]?.channelId).toBe("C_ALICE");
  });

  test("no owner channel → resolves as timeout (executor falls back to local owner)", async () => {
    const presenter = new ApprovalPresenter({
      post: async () => {},
      ownerChannelFor: () => undefined,
    });
    const ctx = {
      ownerEmail: "nobody@acme.com",
      ownerExternalId: "ext-x",
      originatingChannelId: "C_ORIG",
      requesterExternalId: "ext-bob",
      actionLabel: "x",
    };
    const outcome = await runWithChatopsApprovalContext(ctx, () => presenter.requestApproval());
    expect(outcome.kind).toBe("timeout");
  });

  test("no approval context in scope → resolves as timeout (no post)", async () => {
    const posts: unknown[] = [];
    const presenter = new ApprovalPresenter({
      post: async () => {
        posts.push(1);
      },
      ownerChannelFor: () => "C_ANY",
    });
    // Called outside any runWithChatopsApprovalContext → getChatopsApprovalContext() is undefined.
    const outcome = await presenter.requestApproval();
    expect(outcome).toEqual({ kind: "timeout" });
    expect(posts).toEqual([]);
  });

  test("resolveClick for an unknown requestId returns false", () => {
    const presenter = new ApprovalPresenter({
      post: async () => {},
      ownerChannelFor: () => "C_ANY",
    });
    expect(
      presenter.resolveClick({
        requestId: "no-such-id",
        approverExternalId: "ext-alice",
        approved: true,
      }),
    ).toBe(false);
  });
});
