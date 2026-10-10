// packages/gateway/src/util/approval-pending.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CuActionConsentBroker,
  CuEnvelopeConsentBroker,
} from "../computer-use/cu-consent-broker.ts";
import { delegatedApprovalBroker } from "../engine/delegated-approval-broker.ts";
import { QuorumCoordinator } from "../engine/quorum/quorum-coordinator.ts";
import { ExecConsentBroker } from "../exec/exec-consent-broker.ts";
import { FederationConsentBroker } from "../federation/consent-broker.ts";
import { PreflightConsentBroker } from "../federation/preflight-consent-broker.ts";
import { ConsentCoordinatorImpl } from "../ipc/consent.ts";
import { setGatewayEventBroadcast } from "../ipc/gateway-events.ts";
import { ShareConsentBroker } from "../share/share-consent-broker.ts";
import {
  ToolgenConsentBroker,
  ToolgenSaveConsentBroker,
} from "../toolgen/toolgen-consent-broker.ts";
import {
  APPROVAL_PENDING_TITLE,
  type ApprovalPendingNotifier,
  approvalKindLabel,
  BROKER_METHOD_LABELS,
  GENERIC_APPROVAL_KIND_LABEL,
  notifyApprovalPending,
  setApprovalPendingNotifier,
} from "./approval-pending.ts";
import { ConsentBroker } from "./consent-broker.ts";

const SENTINEL = "SENTINEL-7f3a-do-not-leak";

/** A payload where EVERY field a gate carries holds the sentinel. */
const SENTINEL_INPUT = {
  prompt: SENTINEL,
  details: { to: SENTINEL, body: SENTINEL },
  codeBody: SENTINEL,
  body: SENTINEL,
  grants: [SENTINEL],
  capabilities: [SENTINEL],
  args: [SENTINEL],
  argv: [SENTINEL],
  payload: { x: SENTINEL },
  preview: SENTINEL,
  peerId: SENTINEL,
  namespace: SENTINEL,
  purpose: SENTINEL,
  role: SENTINEL,
  command: SENTINEL,
  url: SENTINEL,
  origin: SENTINEL,
  description: SENTINEL,
  toolId: SENTINEL,
  hosts: [SENTINEL],
};

type Toast = { title: string; body: string };

function capture(): Toast[] {
  const seen: Toast[] = [];
  setApprovalPendingNotifier((title, body) => {
    seen.push({ title, body });
  });
  return seen;
}

function assertClean(toasts: Toast[]): void {
  for (const t of toasts) {
    expect(t.title).toBe(APPROVAL_PENDING_TITLE);
    expect(t.title).not.toContain(SENTINEL);
    expect(t.body).not.toContain(SENTINEL);
  }
}

afterEach(() => {
  setApprovalPendingNotifier(undefined);
  setGatewayEventBroadcast(undefined);
});

/** Every concrete broker the test can drive, keyed by class name. */
const BROKER_CLASSES: Record<string, () => ConsentBroker<object>> = {
  CuEnvelopeConsentBroker: () => new CuEnvelopeConsentBroker() as ConsentBroker<object>,
  CuActionConsentBroker: () => new CuActionConsentBroker() as ConsentBroker<object>,
  ExecConsentBroker: () => new ExecConsentBroker() as ConsentBroker<object>,
  PreflightConsentBroker: () => new PreflightConsentBroker() as ConsentBroker<object>,
  ShareConsentBroker: () => new ShareConsentBroker() as ConsentBroker<object>,
  ToolgenConsentBroker: () => new ToolgenConsentBroker() as ConsentBroker<object>,
  ToolgenSaveConsentBroker: () => new ToolgenSaveConsentBroker() as ConsentBroker<object>,
};

/** Scan the gateway source for `class X extends ConsentBroker<...>` + its `super("method")`. */
function scanBrokerSubclasses(): Array<{ cls: string; method: string; file: string }> {
  const root = join(import.meta.dir, "..");
  const out: Array<{ cls: string; method: string; file: string }> = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
        continue;
      }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
      const src = readFileSync(p, "utf8");
      const re = /class\s+(\w+)\s+extends\s+ConsentBroker\s*</g;
      for (let m = re.exec(src); m !== null; m = re.exec(src)) {
        const rest = src.slice(m.index);
        const sup = /super\(\s*"([^"]+)"\s*\)/.exec(rest);
        out.push({ cls: m[1] ?? "", method: sup?.[1] ?? '<no super("...")>', file: p });
      }
    }
  };
  walk(root);
  return out;
}

describe("approvalKindLabel", () => {
  test("every known broker method has a non-generic label; unknown methods get the generic one", () => {
    for (const [method, label] of Object.entries(BROKER_METHOD_LABELS)) {
      expect(approvalKindLabel({ source: "broker", method })).toBe(label);
      expect(label).not.toBe(GENERIC_APPROVAL_KIND_LABEL);
    }
    expect(approvalKindLabel({ source: "broker", method: "new.thingRequest" })).toBe(
      GENERIC_APPROVAL_KIND_LABEL,
    );
  });

  test("an action-type id is used as-is; absent or non-id-shaped text collapses to the generic label", () => {
    expect(approvalKindLabel({ source: "executor", actionType: "slack.message.post" })).toBe(
      "slack.message.post",
    );
    expect(approvalKindLabel({ source: "executor", actionType: "mcp_foo.do_thing" })).toBe(
      "mcp_foo.do_thing",
    );
    for (const bad of [
      undefined,
      "",
      `send "${SENTINEL}" to ceo@example.com`,
      "a b",
      "x\nInjected line",
      "slack.message.post‮gnp.exe",
      "a".repeat(200),
    ]) {
      expect(approvalKindLabel({ source: "executor", actionType: bad })).toBe(
        GENERIC_APPROVAL_KIND_LABEL,
      );
    }
  });
});

describe("notifyApprovalPending", () => {
  test("no notifier set → nothing happens (and no throw)", () => {
    expect(() =>
      notifyApprovalPending({ source: "broker", method: "exec.approvalRequest" }),
    ).not.toThrow();
  });

  test("a sync-throwing notifier is swallowed", () => {
    let calls = 0;
    setApprovalPendingNotifier(() => {
      calls++;
      throw new Error("toast backend exploded");
    });
    expect(() => notifyApprovalPending({ source: "executor", actionType: "a.b" })).not.toThrow();
    expect(calls).toBe(1);
  });

  test("a rejecting notifier is swallowed (no unhandled rejection)", async () => {
    let calls = 0;
    const rejecting: ApprovalPendingNotifier = () => {
      calls++;
      return Promise.reject(new Error("toast backend unavailable"));
    };
    setApprovalPendingNotifier(rejecting);
    notifyApprovalPending({ source: "executor", actionType: "a.b" });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(1);
  });
});

describe("seam: ConsentCoordinatorImpl (executor HITL)", () => {
  test("exactly one hop per request, none on respond; text names the action type and nothing else", async () => {
    const toasts = capture();
    const c = new ConsentCoordinatorImpl(() => () => {});
    const p = c.requestConsent("client-a", {
      requestId: "r1",
      prompt: SENTINEL,
      details: SENTINEL_INPUT,
      actionType: "slack.message.post",
    });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.body).toContain("slack.message.post");
    assertClean(toasts);
    expect(c.handleRespond("client-a", { requestId: "r1", approved: true })).toBeNull();
    expect(await p).toBe(true);
    expect(toasts).toHaveLength(1);
  });

  test("no hop on disconnect or rejectAll; missing actionType → generic label", async () => {
    const toasts = capture();
    const c = new ConsentCoordinatorImpl(() => () => {});
    const p1 = c.requestConsent("client-a", { requestId: "r1", prompt: SENTINEL });
    const p2 = c.requestConsent("client-b", { requestId: "r2", prompt: SENTINEL });
    expect(toasts).toHaveLength(2);
    expect(toasts[0]?.body).toContain(GENERIC_APPROVAL_KIND_LABEL);
    c.onClientDisconnect("client-a");
    c.rejectAllPending("shutdown", "shutdown");
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
    expect(toasts).toHaveLength(2);
    assertClean(toasts);
  });

  test("no session → rejects without a hop (nothing is pending)", async () => {
    const toasts = capture();
    const c = new ConsentCoordinatorImpl(() => undefined);
    await expect(
      c.requestConsent("ghost", { requestId: "r1", prompt: SENTINEL, actionType: "a.b" }),
    ).rejects.toThrow();
    expect(toasts).toHaveLength(0);
  });

  test("a throwing / rejecting notifier does not change the consent outcome", async () => {
    for (const fn of [
      (): void => {
        throw new Error("boom");
      },
      (): Promise<void> => Promise.reject(new Error("boom")),
    ] satisfies ApprovalPendingNotifier[]) {
      setApprovalPendingNotifier(fn);
      const unicast: unknown[] = [];
      const c = new ConsentCoordinatorImpl(() => (n) => unicast.push(n));
      const p = c.requestConsent("client-a", { requestId: "r1", prompt: "x", actionType: "a.b" });
      expect(unicast).toHaveLength(1);
      expect(c.pendingCount()).toBe(1);
      c.handleRespond("client-a", { requestId: "r1", approved: false });
      expect(await p).toBe(false);
    }
  });
});

describe("seam: ConsentBroker base (every subclass)", () => {
  test("the scanned subclass set equals the set this test drives, and every method has a label", () => {
    const scanned = scanBrokerSubclasses();
    expect(scanned.map((s) => s.cls).sort()).toEqual(Object.keys(BROKER_CLASSES).sort());
    for (const s of scanned) {
      // A new broker must add its method to BROKER_METHOD_LABELS (and to BROKER_CLASSES above).
      expect({ cls: s.cls, method: s.method, labelled: s.method in BROKER_METHOD_LABELS }).toEqual({
        cls: s.cls,
        method: s.method,
        labelled: true,
      });
    }
  });

  for (const [cls, make] of Object.entries(BROKER_CLASSES)) {
    test(`${cls}: one hop per request, none on respond or timeout, no payload text`, async () => {
      const toasts = capture();
      const broadcasts: Array<{ method: string }> = [];
      const b = make();
      b.setBroadcast((method) => broadcasts.push({ method }));

      const p = b.request(SENTINEL_INPUT, 60_000);
      expect(toasts).toHaveLength(1);
      const method = broadcasts[0]?.method ?? "";
      expect(toasts[0]?.body).toContain(BROKER_METHOD_LABELS[method] ?? "<unlabelled>");
      const id = b.pendingIds()[0] ?? "";
      expect(b.respond(id, true)).toBe(true);
      expect(await p).toBe(true);

      const timedOut = b.request(SENTINEL_INPUT, 1);
      expect(toasts).toHaveLength(2);
      expect(await timedOut).toBe(false);
      expect(toasts).toHaveLength(2);
      assertClean(toasts);
      b.clear();
    });
  }

  test("the base class with an unknown method uses the generic label", () => {
    const toasts = capture();
    const b = new ConsentBroker<{ prompt: string }>("brand.newRequest");
    void b.request({ prompt: SENTINEL }, 60_000);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.body).toContain(GENERIC_APPROVAL_KIND_LABEL);
    assertClean(toasts);
    b.clear();
  });

  test("a throwing / rejecting notifier does not change the broker outcome", async () => {
    for (const fn of [
      (): void => {
        throw new Error("boom");
      },
      (): Promise<void> => Promise.reject(new Error("boom")),
    ] satisfies ApprovalPendingNotifier[]) {
      setApprovalPendingNotifier(fn);
      const b = new ExecConsentBroker();
      let broadcasts = 0;
      b.setBroadcast(() => {
        broadcasts++;
      });
      const p = b.request(SENTINEL_INPUT as never, 60_000);
      expect(broadcasts).toBe(1);
      expect(b.respond(b.pendingIds()[0] ?? "", true)).toBe(true);
      expect(await p).toBe(true);
    }
  });
});

describe("seam: FederationConsentBroker (inbound federated query; not a ConsentBroker subclass)", () => {
  test("one hop per request, none on respond, no peer/namespace/purpose text", async () => {
    const toasts = capture();
    const b = new FederationConsentBroker();
    const p = b.request(
      { peerId: SENTINEL, namespace: SENTINEL, purpose: SENTINEL, role: SENTINEL },
      60_000,
    );
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.body).toContain(BROKER_METHOD_LABELS["federation.consentRequest"] ?? "?");
    b.respond(b.pendingIds()[0] ?? "", false);
    expect(await p).toBe("denied");
    expect(toasts).toHaveLength(1);
    assertClean(toasts);
  });
});

describe("seam: quorum aggregator + delegated-approval broker (not ConsentBroker subclasses)", () => {
  test("QuorumCoordinator.collect: one hop per vote request, none on respond, no request text", async () => {
    const toasts = capture();
    const ids: string[] = [];
    const q = new QuorumCoordinator((id) => {
      ids.push(id);
    });
    const p = q.collect({ approvers: 1, windowMs: 60_000 });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.body).toContain(BROKER_METHOD_LABELS["federation.quorumRequest"] ?? "?");
    expect(toasts[0]?.body).not.toContain(GENERIC_APPROVAL_KIND_LABEL);
    // The request id is never in the toast either.
    expect(toasts[0]?.body).not.toContain(ids[0] ?? "<no id>");
    expect(q.respond(ids[0] ?? "", "peer-a", true)).toBe(true);
    expect((await p).outcome).toBe("approved");
    expect(toasts).toHaveLength(1);
    assertClean(toasts);
  });

  test("delegatedApprovalBroker.request: one hop, never the prompt", async () => {
    const toasts = capture();
    let id = "";
    delegatedApprovalBroker.setBroadcast((requestId) => {
      id = requestId;
    });
    try {
      const p = delegatedApprovalBroker.request(
        { prompt: `Approve delegated action: ${SENTINEL}?` },
        60_000,
      );
      expect(toasts).toHaveLength(1);
      expect(toasts[0]?.body).toContain(BROKER_METHOD_LABELS["federation.approvalRequest"] ?? "?");
      expect(delegatedApprovalBroker.respond(id, "peer-a", false)).toBe(true);
      expect(await p).toEqual({ kind: "answered", peerId: "peer-a", approved: false });
      expect(toasts).toHaveLength(1);
      assertClean(toasts);
    } finally {
      delegatedApprovalBroker.setBroadcast(() => {});
    }
  });

  test("every hand-raised broker hop in the tree names a LABELLED method (total over call sites)", () => {
    const root = join(import.meta.dir, "..");
    const methods: Array<{ file: string; method: string }> = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(p);
          continue;
        }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        const src = readFileSync(p, "utf8");
        const re = /notifyApprovalPending\(\s*\{\s*source:\s*"broker",\s*method:\s*"([^"]+)"/g;
        for (let m = re.exec(src); m !== null; m = re.exec(src)) {
          methods.push({ file: e.name, method: m[1] ?? "" });
        }
      }
    };
    walk(root);
    // Negative control: the scan sees the three literal call sites that exist today.
    expect(methods.map((m) => m.method).sort()).toEqual([
      "federation.approvalRequest",
      "federation.consentRequest",
      "federation.quorumRequest",
    ]);
    for (const m of methods) {
      expect({ ...m, labelled: m.method in BROKER_METHOD_LABELS }).toEqual({
        ...m,
        labelled: true,
      });
    }
  });
});
