import { describe, expect, test } from "bun:test";
import {
  checkChatopsReplySurfaceInvariant,
  checkChatopsUnwrappedPost,
} from "../../../../scripts/structure-audit/check-nimbus-invariants.ts";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { egressRows, freshEgressDb, read } from "../../test/helpers/security-invariants.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";

describe("Phase 9.7 D0c — typed confirmation over ChatOps (I20, I23, I29, D17, D41)", () => {
  const MERGE = {
    type: "github.pr.merge",
    payload: { mcpToolId: "github_pr_merge", input: { owner: "a", repo: "b", pullNumber: 7 } },
  };
  const TEXT = "github/merge a/b#7";

  /**
   * The ChatOps delegation wiring exactly as `chatops-boot.ts` builds it: the executor's
   * `requestRemoteConfirmed` is the presenter's `requestTypedApproval`, the owner is the sole
   * delegate, and an answer arrives through the presenter's submit methods.
   */
  async function wired() {
    const { NO_POLICY_OVERLAY, ToolExecutor } = await import("../engine/executor.ts");
    const { ApprovalPresenter } = await import("../chatops/approval-presenter.ts");
    const { runWithChatopsApprovalContext } = await import("../chatops/chatops-request-context.ts");
    const dispatched: string[] = [];
    const posted: string[] = [];
    const presenter: InstanceType<typeof ApprovalPresenter> = new ApprovalPresenter({
      post: async (_c, text) => {
        posted.push(text);
      },
      ownerChannelFor: () => "C1",
    });
    const exec = new ToolExecutor(
      { requestApproval: async () => ({ approved: false, answerSource: "human" as const }) },
      { recordAudit: () => {} },
      {
        dispatch: async (a) => {
          dispatched.push(a.type);
          return {};
        },
      },
      {
        store: {
          activeDelegateFor: (_k, _v, peer) => peer === "ext-alice",
          activeDelegateePeer: () => "ext-alice",
        },
        isOperatorValid: () => true,
        requestRemote: () => presenter.requestApproval(),
        requestRemoteConfirmed: (_t, confirmText) => presenter.requestTypedApproval(confirmText),
      },
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    const run = (): ReturnType<typeof exec.execute> =>
      runWithChatopsApprovalContext(
        {
          ownerEmail: "alice@acme.com",
          ownerExternalId: "ext-alice",
          originatingChannelId: "C1",
          requesterExternalId: "ext-bob",
          actionLabel: "github.pr.merge",
        },
        () => exec.execute(MERGE),
      );
    return { presenter, run, dispatched, posted };
  }

  test("I20: a ChatOps delegate approves a Wave 4 write only with the exact typed value, and only the owner's form answer spends the card", async () => {
    // Exact text from the owner: dispatched.
    const ok = await wired();
    const p1 = ok.run();
    await new Promise((r) => setTimeout(r, 5));
    const id1 = ok.presenter.lastRequestId();
    expect(ok.presenter.pendingKind(id1)).toBe("confirm");
    // A channel text `approve` never approves the card and never spends it.
    expect(
      ok.presenter.resolveClick({
        requestId: id1,
        approverExternalId: "ext-alice",
        approved: true,
      }),
    ).toBe(false);
    // A non-owner's submit, even with the exact text, does not spend it.
    expect(
      ok.presenter.resolveConfirmSubmit({
        requestId: id1,
        approverExternalId: "ext-bob",
        approved: true,
        typed: TEXT,
      }),
    ).toBe(false);
    expect(ok.presenter.pendingKind(id1)).toBe("confirm");
    ok.presenter.resolveConfirmSubmit({
      requestId: id1,
      approverExternalId: "ext-alice",
      approved: true,
      typed: TEXT,
    });
    expect((await p1).status).toBe("ok");
    expect(ok.dispatched).toEqual(["github.pr.merge"]);

    // Wrong, padded, non-string and over-cap values are all mismatches decided by the executor.
    for (const typed of [`${TEXT} `, TEXT.toUpperCase(), 7, "x".repeat(513), undefined]) {
      const bad = await wired();
      const p = bad.run();
      await new Promise((r) => setTimeout(r, 5));
      bad.presenter.resolveConfirmSubmit({
        requestId: bad.presenter.lastRequestId(),
        approverExternalId: "ext-alice",
        approved: true,
        typed,
      });
      expect((await p).status, String(typed)).toBe("rejected");
      expect(bad.dispatched).toEqual([]);
    }
  });

  test("I20: the presenter never compares the typed text (D41) and the card text is display only", async () => {
    const presenter = stripComments(
      await read("packages/gateway/src/chatops/approval-presenter.ts"),
    );
    expect(presenter).not.toMatch(/\.typed\s*[!=]==/);
    expect(presenter).not.toMatch(/[!=]==\s*[\w.]*confirmText/);
    expect(presenter).not.toMatch(/\.trim\(|toLowerCase|normalizeChatText/);
    const boot = await read("packages/gateway/src/chatops/chatops-boot.ts");
    expect(boot).toContain("requestRemoteConfirmed: (_actionType, confirmText) =>");
    expect(boot).toContain("presenter.requestTypedApproval(confirmText)");
  });

  test("I29: the confirmation modal open appends a chatops.confirmModal row BEFORE the open, and a failed append aborts it", async () => {
    const { buildLedgeredConfirmModal } = await import("../egress/chatops-egress.ts");
    const db = freshEgressDb();
    const order: string[] = [];
    const open = buildLedgeredConfirmModal(
      db,
      async () => {
        order.push(`open:${egressRows(db).length}`);
      },
      Buffer.alloc(32, 3).toString("base64"),
    );
    await open("C1", "trig", { type: "modal" });
    expect(order).toEqual(["open:1"]);
    const method = db.query("SELECT method FROM egress_ledger").all() as { method: string }[];
    expect(method).toEqual([{ method: "chatops.confirmModal" }]);
    db.exec("DROP TABLE egress_ledger");
    let opened = false;
    const broken = buildLedgeredConfirmModal(
      db,
      async () => {
        opened = true;
      },
      Buffer.alloc(32, 3).toString("base64"),
    );
    await expect(broken("C1", "trig", {})).rejects.toThrow();
    expect(opened).toBe(false);
    db.close();
  });

  test("D17: slack_views_open is named only in the transport, and buildConnectorViewsOpen only inside buildLedgeredConfirmModal", () => {
    const boot = "packages/gateway/src/chatops/chatops-boot.ts";
    expect(
      checkChatopsReplySurfaceInvariant([
        { relPath: boot, contents: 'run("slack_views_open", {});\n' },
      ]),
    ).toHaveLength(1);
    expect(
      checkChatopsUnwrappedPost([
        { relPath: boot, contents: "const open = buildConnectorViewsOpen(runTool);\n" },
      ]),
    ).toHaveLength(1);
    expect(
      checkChatopsUnwrappedPost([
        {
          relPath: boot,
          contents:
            "const m = buildLedgeredConfirmModal(db, buildConnectorViewsOpen(runTool), s);\n",
        },
      ]),
    ).toEqual([]);
  });
});
