// packages/gateway/src/engine/executor-k8s-rows.test.ts
// Phase 9.7 D3a: the REAL bound Kubernetes apply row through the production write table (no
// `writeTable` seam). The capabilities are a fake dispatcher member whose preflight models the
// runner's (context NUL namespace) lock and whose settle IS the production settler; the plan reply
// is BUILT FROM the installed connector's own functions. What is proven here is the gate's
// behaviour on the real row: ledger order, the gateway's hashes, the typed prompt, the lock and the
// audit record.
import { describe, expect, test } from "bun:test";
import { K8S_PREFLIGHT_REFUSALS } from "../connectors/connector-writes/k8s-limits.ts";
import { k8sPlanHash } from "../connectors/connector-writes/k8s-manifest.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import type { BoundWriteCapabilities } from "./bound-write-capabilities.ts";
import {
  CONFIRM_UNSUPPORTED_REASON,
  NO_POLICY_OVERLAY,
  PREFLIGHT_FAILED_REASON,
  ToolExecutor,
} from "./executor.ts";
import { planReply } from "./k8s-plan-reply.test-helpers.ts";
import { settleK8sManifest } from "./k8s-settle.ts";
import { PREPARE_REFUSALS } from "./prepare-step.ts";
import type {
  ActionResult,
  ConfirmedApprovalRequest,
  ConfirmedApprovalResult,
  PlannedAction,
} from "./types.ts";

type Obj = Record<string, unknown>;

const CONTEXT = "prod-east";
const NS = "shop";
const SERVER = "api.prod.example.com:6443";
const MANIFEST = [
  "apiVersion: apps/v1",
  "kind: Deployment",
  "metadata:",
  "  name: api",
  "---",
  "apiVersion: v1",
  "kind: ConfigMap",
  "metadata:",
  "  name: cfg",
  "data:",
  "  k: new",
  "",
].join("\n");

const planOf = (manifest: string): Obj => planReply(manifest, NS, CONTEXT);

const ACTION = (
  manifest = MANIFEST,
  extra: Obj = {},
  where: "nested" | "root" = "nested",
): PlannedAction => {
  const input = { context: CONTEXT, namespace: NS, manifest, ...extra };
  return {
    type: "kubernetes.manifest.apply",
    payload:
      where === "nested"
        ? { mcpToolId: "kubernetes_k8s_manifest_apply", input }
        : { mcpToolId: "kubernetes_k8s_manifest_apply", ...input },
  };
};

interface Harness {
  readonly exec: ToolExecutor;
  readonly log: string[];
  readonly prompts: string[];
  readonly confirmed: ConfirmedApprovalRequest[];
  readonly audits: Array<{ actionType: string; hitlStatus: string; actionJson: string }>;
  readonly egress: EgressEntry[];
  readonly dispatched: PlannedAction[];
  readonly locks: Set<string>;
  readonly preflightInputs: Array<Record<string, unknown>>;
}

interface Options {
  readonly approve?: boolean;
  readonly typed?: string;
  readonly channel?: "typed" | "plain-only";
  readonly caps?: "none";
  /** Pairs the owner approved; default the one pair above. */
  readonly pairs?: ReadonlyArray<readonly [string, string]>;
  readonly manifest?: string;
  readonly settleThrows?: boolean;
  readonly preflightThrows?: boolean;
  /** A promise the typed prompt waits for before it answers (to hold the lock open). */
  readonly hold?: Promise<void>;
  readonly onPrompt?: () => void;
  /** A prepare reply that forges the hashes. */
  readonly forged?: boolean;
}

function harness(o: Options = {}): Harness {
  const log: string[] = [];
  const prompts: string[] = [];
  const confirmed: ConfirmedApprovalRequest[] = [];
  const audits: Harness["audits"] = [];
  const egress: EgressEntry[] = [];
  const dispatched: PlannedAction[] = [];
  const locks = new Set<string>();
  const preflightInputs: Array<Record<string, unknown>> = [];
  const pairs = o.pairs ?? [[CONTEXT, NS]];
  const capabilities: BoundWriteCapabilities | undefined =
    o.caps === "none"
      ? undefined
      : {
          preflight: async (_id, input) => {
            if (o.preflightThrows === true) throw new Error("boom");
            preflightInputs.push(structuredClone({ ...input }));
            const context = String(input["context"]);
            const namespace = String(input["namespace"]);
            if (!pairs.some(([c, n]) => c === context && n === namespace)) {
              return { ok: false, reason: K8S_PREFLIGHT_REFUSALS.notApprovedNamespace };
            }
            const key = `${context}\0${namespace}`;
            if (locks.has(key)) return { ok: false, reason: K8S_PREFLIGHT_REFUSALS.busy };
            locks.add(key);
            return {
              ok: true,
              release: () => {
                locks.delete(key);
                log.push("release");
              },
            };
          },
          settle: (id, ctx) => {
            log.push(`settle:${id}`);
            if (o.settleThrows === true) return Promise.reject(new Error("boom"));
            return Promise.resolve(
              settleK8sManifest({ input: ctx.input, reply: ctx.reply, server: SERVER }),
            );
          },
        };
  const consent =
    o.channel === "plain-only"
      ? {
          requestApproval: async (p: string) => {
            log.push("prompt");
            prompts.push(p);
            return { approved: true, answerSource: "human" as const };
          },
        }
      : {
          requestApproval: async () => ({ approved: true, answerSource: "human" as const }),
          requestConfirmedApproval: async (
            req: ConfirmedApprovalRequest,
          ): Promise<ConfirmedApprovalResult> => {
            log.push("prompt:confirmed");
            prompts.push(req.prompt);
            confirmed.push(req);
            o.onPrompt?.();
            if (o.hold !== undefined) await o.hold;
            return {
              approved: o.approve ?? true,
              typed: o.typed ?? req.confirmText,
              answerSource: "human" as const,
            };
          },
        };
  const exec = new ToolExecutor(
    consent,
    {
      recordAudit: (e) => {
        audits.push({
          actionType: e.actionType,
          hitlStatus: e.hitlStatus,
          actionJson: e.actionJson,
        });
        log.push(`audit:${e.actionType}:${e.hitlStatus}`);
      },
    },
    {
      dispatch: async (a) => {
        dispatched.push(a);
        log.push(`dispatch:${a.type}:${String(a.payload?.["mcpToolId"])}`);
        if (a.type.endsWith(".write.prepare")) {
          const reply = planOf(o.manifest ?? MANIFEST);
          return o.forged === true
            ? { ...reply, planSha256: "f".repeat(64), diffSha256: "e".repeat(64) }
            : reply;
        }
        return { ok: true };
      },
      ...(capabilities === undefined ? {} : { boundWriteCapabilities: capabilities }),
    },
    undefined,
    {
      append: (e) => {
        egress.push(e);
      },
    },
    NO_POLICY_OVERLAY,
  );
  return { exec, log, prompts, confirmed, audits, egress, dispatched, locks, preflightInputs };
}

const writesOf = (h: Harness): PlannedAction[] =>
  h.dispatched.filter((a) => !a.type.endsWith(".write.prepare"));
const inputOf = (a: PlannedAction | undefined): Obj => (a?.payload?.["input"] ?? {}) as Obj;

function rejectedWith(r: ActionResult, reason: string): void {
  expect(r.status).toBe("rejected");
  if (r.status === "rejected") expect(r.reason).toBe(reason);
}

describe("the Kubernetes apply through the production table (D3a, I54)", () => {
  test("plan, then the write with the GATEWAY's hashes; typed confirm; ledger order", async () => {
    const h = harness();
    const r = await h.exec.execute(ACTION());
    expect(r).toEqual({ status: "ok", result: { ok: true } });
    expect(h.dispatched.map((a) => String(a.payload?.["mcpToolId"]))).toEqual([
      "kubernetes_k8s_manifest_plan",
      "kubernetes_k8s_manifest_apply",
    ]);
    expect(h.dispatched.map((a) => a.type)).toEqual([
      "kubernetes.write.prepare",
      "kubernetes.manifest.apply",
    ]);
    // The prepare read got exactly the three input keys.
    expect(inputOf(h.dispatched[0])).toEqual({
      context: CONTEXT,
      namespace: NS,
      manifest: MANIFEST,
    });
    // The write carries the settled hashes and the caller's other fields unchanged.
    const expected = planOf(MANIFEST);
    expect(inputOf(writesOf(h)[0])).toEqual({
      context: CONTEXT,
      namespace: NS,
      manifest: MANIFEST,
      planSha256: k8sPlanHash(CONTEXT, NS, MANIFEST),
      diffSha256: expected["diffSha256"],
    });
    // Audit and ledger saw the prepare and the write, in that order.
    expect(h.audits.map((a) => a.actionType)).toEqual([
      "kubernetes.write.prepare",
      "kubernetes.manifest.apply",
    ]);
    expect(h.egress.map((e) => e.resultStatus)).toEqual(["authorized", "authorized"]);
    // One typed prompt, with the plan in it and the derived target as the text to type.
    expect(h.confirmed).toHaveLength(1);
    expect(h.confirmed[0]?.confirmText).toBe(
      `kubernetes/apply ${CONTEXT}/${NS} 2 objects ${k8sPlanHash(CONTEXT, NS, MANIFEST).slice(0, 12)}`,
    );
    expect(h.prompts[0]).toContain("Deployment");
    expect(h.prompts[0]).toContain(SERVER);
    const audit = JSON.parse(h.audits.at(-1)?.actionJson ?? "{}") as Obj;
    expect(typeof audit["diffSha256"]).toBe("string");
    expect(typeof audit["boundValuesSha256"]).toBe("string");
    // The lock is freed last, once the run is over.
    expect(h.log.at(-1)).toBe("release");
    expect(h.locks.size).toBe(0);
  });

  test("a prepare reply that forges the hashes is refused: the gateway's own are the identity", async () => {
    const h = harness({ forged: true });
    rejectedWith(await h.exec.execute(ACTION()), PREPARE_REFUSALS.unbound);
    expect(writesOf(h)).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.locks.size).toBe(0);
  });

  test("a caller-supplied planSha256 or diffSha256 is refused before any read, at the root and in input", async () => {
    for (const key of ["planSha256", "diffSha256"]) {
      for (const where of ["nested", "root"] as const) {
        const h = harness();
        rejectedWith(
          await h.exec.execute(ACTION(MANIFEST, { [key]: "c".repeat(64) }, where)),
          PREPARE_REFUSALS.callerBound,
        );
        expect(h.dispatched).toEqual([]);
        expect(h.prompts).toEqual([]);
        expect(h.log.some((l) => l.startsWith("settle:"))).toBe(false);
        expect(h.preflightInputs).toEqual([]);
      }
    }
  });

  test("an unapproved (context, namespace) pair is refused before any child", async () => {
    for (const [context, namespace] of [
      [CONTEXT, "other"],
      ["elsewhere", NS],
    ] as const) {
      const h = harness();
      const r = await h.exec.execute({
        type: "kubernetes.manifest.apply",
        payload: {
          mcpToolId: "kubernetes_k8s_manifest_apply",
          input: { context, namespace, manifest: MANIFEST },
        },
      });
      rejectedWith(r, K8S_PREFLIGHT_REFUSALS.notApprovedNamespace);
      expect(h.dispatched).toEqual([]);
      expect(h.audits.some((a) => a.actionType === "kubernetes.write.prepare")).toBe(false);
      expect(h.prompts).toEqual([]);
    }
  });

  test("a channel with no typed prompt (ChatOps) is refused before any child; no prepare row exists", async () => {
    const h = harness({ channel: "plain-only" });
    rejectedWith(await h.exec.execute(ACTION()), CONFIRM_UNSUPPORTED_REASON);
    expect(h.dispatched).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.preflightInputs).toEqual([]);
    expect(h.audits.some((a) => a.actionType === "kubernetes.write.prepare")).toBe(false);
  });

  test("a dispatcher with no capabilities refuses before any child", async () => {
    const h = harness({ caps: "none" });
    rejectedWith(await h.exec.execute(ACTION()), PREPARE_REFUSALS.capabilityMissing);
    expect(h.dispatched).toEqual([]);
    expect(h.prompts).toEqual([]);
  });

  test("a preflight that throws refuses with the fixed reason", async () => {
    const h = harness({ preflightThrows: true });
    rejectedWith(await h.exec.execute(ACTION()), PREFLIGHT_FAILED_REASON);
    expect(h.dispatched).toEqual([]);
  });

  test("a manifest the gateway refuses (a Secret, a wrong namespace) never reaches a child", async () => {
    const secret = ["apiVersion: v1", "kind: Secret", "metadata:", "  name: s", ""].join("\n");
    const other = [
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: c",
      "  namespace: kube-system",
      "",
    ].join("\n");
    for (const manifest of [secret, other, "not: [valid"]) {
      const h = harness();
      const r = await h.exec.execute(ACTION(manifest));
      expect(r.status).toBe("rejected");
      expect(h.dispatched).toEqual([]);
      expect(h.preflightInputs).toEqual([]);
    }
  });
});

describe("the namespace lock (D3a)", () => {
  test("a second apply on the same pair is refused while the first awaits its owner", async () => {
    let open: () => void = () => undefined;
    const hold = new Promise<void>((res) => {
      open = res;
    });
    const first = harness({ hold });
    // The second executor shares the first's lock set through the same harness.
    const running = first.exec.execute(ACTION());
    await new Promise((res) => setTimeout(res, 20));
    expect(first.locks.size).toBe(1);
    const second = await first.exec.execute(ACTION());
    rejectedWith(second, K8S_PREFLIGHT_REFUSALS.busy);
    open();
    expect((await running).status).toBe("ok");
    expect(first.locks.size).toBe(0);
  });

  test("the lock is freed on decline, on a confirm mismatch, on a failed settle and on a forged plan", async () => {
    for (const o of [
      { approve: false },
      { typed: "apply something else" },
      { settleThrows: true },
      { forged: true },
    ] as const) {
      const h = harness(o);
      const r = await h.exec.execute(ACTION());
      expect(r.status).toBe("rejected");
      expect(writesOf(h)).toEqual([]);
      expect(h.locks.size).toBe(0);
      expect(h.log.at(-1)).toBe("release");
    }
  });
});

describe("what the audit row and the egress ledger hold of a manifest (D3a)", () => {
  const BIG = [
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata:",
    "  name: big",
    "data:",
    ...Array.from({ length: 400 }, (_, i) => `  k${String(i)}: ${"x".repeat(90)}`),
    "",
  ].join("\n");

  test("a 40 KiB manifest is recorded as its size and SHA-256, never its text", async () => {
    expect(Buffer.byteLength(BIG, "utf8")).toBeGreaterThan(36_000);
    const h = harness({ manifest: BIG });
    const r = await h.exec.execute(ACTION(BIG));
    expect(r.status).toBe("ok");
    const rows = [...h.audits.map((a) => a.actionJson), ...h.egress.map((e) => JSON.stringify(e))];
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(row).not.toContain("xxxxxxxxxx");
      expect(row).not.toContain("apiVersion: v1");
    }
    for (const a of h.audits) {
      const parsed = JSON.parse(a.actionJson) as { action?: { payload?: { input?: Obj } } };
      const input = parsed.action?.payload?.input ?? {};
      expect(input["manifest"]).toBeUndefined();
      expect(input["manifestBytes"]).toBe(Buffer.byteLength(BIG, "utf8"));
      expect(typeof input["manifestSha256"]).toBe("string");
    }
  });
});
