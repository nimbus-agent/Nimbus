import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type LocalBaseline, PolicyGate } from "../policy/policy-gate.ts";
import { signPolicy } from "../policy/policy-signing.ts";
import { PolicyStore } from "../policy/policy-store.ts";
import { isHitlRequiredByPolicy } from "../policy/quorum-override.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel, PlannedAction } from "./types.ts";

/**
 * I22 — the tighten-only HITL overlay.
 *
 * `PolicyGate` has always resolved `EnforcedPolicy.hitlRequired` as a monotonic union, and
 * `docs/SECURITY-INVARIANTS.md` has always described enforcement as reading it. Nothing read it:
 * `isHitlRequiredByPolicy` had zero production callers, so an org admin could sign
 * `[policy.hitl] require = [...]`, watch the signature verify, and get no gate at all.
 *
 * These tests pin the two halves that matter — that the overlay can ADD a gate, and that it can
 * never SUBTRACT one — because "tighten-only" is the entire reason this is compatible with I2's
 * "the consent gate cannot be bypassed or configured away".
 */

function harness(over: { approve?: boolean } = {}): {
  prompts: string[];
  dispatched: string[];
  consent: ConsentChannel;
  audit: AuditSink;
  connectors: ConnectorDispatcher;
} {
  const prompts: string[] = [];
  const dispatched: string[] = [];
  return {
    prompts,
    dispatched,
    consent: {
      requestApproval: async (prompt: string) => {
        prompts.push(prompt);
        return over.approve ?? true;
      },
    },
    audit: { recordAudit: () => {} },
    connectors: {
      dispatch: async (a: PlannedAction) => {
        dispatched.push(a.type);
        return { ok: true };
      },
    },
  };
}

/** An action type deliberately NOT in `HITL_REQUIRED_BACKING` — a read, ungated by default. */
const UNGATED = "search.run";
/** An action type that IS in the frozen set. */
const FROZEN = "email.send";

describe("I22 — a signed org policy can ADD a HITL requirement", () => {
  test("an ungated action type prompts once the overlay claims it", async () => {
    const h = harness();
    const exec = new ToolExecutor(h.consent, h.audit, h.connectors, undefined, NULL_EGRESS_SINK, {
      isHitlRequiredByPolicy: (t) => t === UNGATED,
    });
    await exec.execute({ type: UNGATED, payload: {} });
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain(UNGATED);
  });

  test("the same action does NOT prompt without the overlay — so the prompt is the policy's doing", async () => {
    // The control that makes the assertion above mean something: if `search.run` prompted anyway,
    // the test would pass with the overlay wired to a constant `false`.
    const h = harness();
    const exec = new ToolExecutor(
      h.consent,
      h.audit,
      h.connectors,
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    await exec.execute({ type: UNGATED, payload: {} });
    expect(h.prompts).toEqual([]);
    expect(h.dispatched).toEqual([UNGATED]);
  });

  test("a denied policy-added prompt blocks the dispatch", async () => {
    const h = harness({ approve: false });
    const exec = new ToolExecutor(h.consent, h.audit, h.connectors, undefined, NULL_EGRESS_SINK, {
      isHitlRequiredByPolicy: () => true,
    });
    const res = await exec.execute({ type: UNGATED, payload: {} });
    expect(res.status).toBe("rejected");
    expect(h.dispatched).toEqual([]);
  });
});

describe("I22 — a policy can NEVER remove a frozen-set requirement (tighten-only)", () => {
  test("a frozen-set action still prompts when the overlay says it is not required", async () => {
    // The load-bearing direction. `gate()` computes `HITL_REQUIRED.has(t) || overlay(t)` — an OR,
    // never an assignment — so a hostile, buggy or merely stale policy cannot take an action type
    // OUT of I2's frozen set. If this ever reads `overlay(t) ? … : HITL_REQUIRED.has(t)`, or the
    // operands swap into an `&&`, this test is what catches it.
    const h = harness();
    const exec = new ToolExecutor(h.consent, h.audit, h.connectors, undefined, NULL_EGRESS_SINK, {
      isHitlRequiredByPolicy: () => false,
    });
    await exec.execute({ type: FROZEN, payload: {} });
    expect(h.prompts).toHaveLength(1);
  });

  test("a throwing overlay adds nothing and does not gate everything", async () => {
    // Fails toward the frozen set. An overlay fault turning every read into a consent prompt is a
    // self-inflicted denial of service, and I2 is still the floor underneath.
    const h = harness();
    const exec = new ToolExecutor(h.consent, h.audit, h.connectors, undefined, NULL_EGRESS_SINK, {
      isHitlRequiredByPolicy: () => {
        throw new Error("policy store unavailable");
      },
    });
    await exec.execute({ type: UNGATED, payload: {} });
    expect(h.prompts).toEqual([]);

    await exec.execute({ type: FROZEN, payload: {} });
    expect(h.prompts).toHaveLength(1);
  });

  test("NO_POLICY_OVERLAY is the identity: behaviour matches the pre-overlay executor", async () => {
    const h = harness();
    const exec = new ToolExecutor(
      h.consent,
      h.audit,
      h.connectors,
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    await exec.execute({ type: UNGATED, payload: {} });
    await exec.execute({ type: FROZEN, payload: {} });
    expect(h.prompts).toHaveLength(1);
    expect(h.dispatched).toEqual([UNGATED, FROZEN]);
  });
});

describe("I22 — end to end from a SIGNED policy to a consent prompt", () => {
  const baseline: LocalBaseline = {
    retentionDays: 7,
    hitlRequired: new Set<string>(),
    quorum: new Map(),
  };

  function gateWithSignedHitlRequire(require: readonly string[]): {
    gate: PolicyGate;
    db: Database;
  } {
    const kp = generateEd25519Keypair();
    const toml = `[policy]\nversion=1\norg="acme"\n[policy.hitl]\nrequire=${JSON.stringify(require)}\n`;
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    const store = new PolicyStore(db);
    store.pinAnchorPubkey(encodeBase64(kp.pubkey), "manual", 1);
    store.persist({
      toml,
      sig: signPolicy(toml, encodeBase64(kp.privkey)),
      org: "acme",
      version: 1,
      source: "peer",
      fetchedAt: 1,
    });
    return { gate: new PolicyGate(store, baseline), db };
  }

  test("a signed [policy.hitl] require entry produces a real consent prompt", async () => {
    // The whole chain, with nothing hand-built in the middle: sign → verify → resolve → read →
    // gate → prompt. The previous I22 assertion stopped at "resolve", asserting on a
    // `LocalBaseline` production never constructs — which is exactly how the resolution stayed
    // correct while nothing consumed its output.
    const { gate, db } = gateWithSignedHitlRequire([UNGATED]);
    expect(gate.status().signatureValid).toBe(true);
    expect(isHitlRequiredByPolicy(gate.enforced(), UNGATED)).toBe(true);

    const h = harness();
    const exec = new ToolExecutor(h.consent, h.audit, h.connectors, undefined, NULL_EGRESS_SINK, {
      isHitlRequiredByPolicy: (t) => isHitlRequiredByPolicy(gate.enforced(), t),
    });
    await exec.execute({ type: UNGATED, payload: {} });
    expect(h.prompts).toHaveLength(1);
    db.close();
  });

  test("a signed policy naming NOTHING leaves the action ungated", async () => {
    // Control. Without it, an executor that prompted on everything would pass the test above.
    const { gate, db } = gateWithSignedHitlRequire([]);
    const h = harness();
    const exec = new ToolExecutor(h.consent, h.audit, h.connectors, undefined, NULL_EGRESS_SINK, {
      isHitlRequiredByPolicy: (t) => isHitlRequiredByPolicy(gate.enforced(), t),
    });
    await exec.execute({ type: UNGATED, payload: {} });
    expect(h.prompts).toEqual([]);
    expect(h.dispatched).toEqual([UNGATED]);
    db.close();
  });

  test("a TAMPERED policy's require list never reaches the gate", async () => {
    // I22's fail-closed leg, now observable at the executor instead of only at the resolver: an
    // unverified bundle falls back to baseline, so its `require` list adds nothing.
    const kp = generateEd25519Keypair();
    const good = `[policy]\nversion=1\norg="acme"\n[policy.hitl]\nrequire=[]\n`;
    const sig = signPolicy(good, encodeBase64(kp.privkey));
    const tampered = good.replace("require=[]", `require=["${UNGATED}"]`);
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    const store = new PolicyStore(db);
    store.pinAnchorPubkey(encodeBase64(kp.pubkey), "manual", 1);
    store.persist({ toml: tampered, sig, org: "acme", version: 1, source: "peer", fetchedAt: 1 });
    const gate = new PolicyGate(store, baseline);
    expect(gate.status().signatureValid).toBe(false);

    const h = harness();
    const exec = new ToolExecutor(h.consent, h.audit, h.connectors, undefined, NULL_EGRESS_SINK, {
      isHitlRequiredByPolicy: (t) => isHitlRequiredByPolicy(gate.enforced(), t),
    });
    await exec.execute({ type: UNGATED, payload: {} });
    expect(h.prompts).toEqual([]);
    db.close();
  });
});
