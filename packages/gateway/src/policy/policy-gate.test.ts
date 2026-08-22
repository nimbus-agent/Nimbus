import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import type { QuorumRule } from "../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { computeEnforced, type LocalBaseline, PolicyGate, verifyCandidate } from "./policy-gate.ts";
import { signPolicy } from "./policy-signing.ts";
import { PolicyStore } from "./policy-store.ts";
import { parsePolicyToml } from "./policy-toml.ts";

const baseline: LocalBaseline = {
  retentionDays: 7,
  hitlRequired: new Set(["git.force_push_main"]),
  quorum: new Map<string, QuorumRule>([
    ["terraform.destroy", { approvers: 1, windowSeconds: 600 }],
  ]),
  capabilitiesDisabled: new Set<string>(),
};

describe("computeEnforced — ai_v2 capability lockoff", () => {
  test("UNIONS org policy with the local baseline", () => {
    const e = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.capabilities.ai_v2]\ncode_execution=false\n`,
      ),
      baseline,
    );
    expect(e.capabilitiesDisabled.has("code_execution")).toBe(true);
  });

  test("a policy naming NOTHING cannot re-enable a locally disabled capability", () => {
    const e = computeEnforced(parsePolicyToml(`[policy]\nversion=1\norg="x"\n`), {
      ...baseline,
      capabilitiesDisabled: new Set(["code_execution"]),
    });
    expect(e.capabilitiesDisabled.has("code_execution")).toBe(true);
  });

  test("`= true` in policy cannot re-enable what the baseline disabled (tighten-only)", () => {
    // The whole reason this is a SET and not a boolean: with booleans, a peer-distributed policy
    // saying `code_execution = true` would read as a grant and undo the anchor's lockoff.
    const e = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.capabilities.ai_v2]\ncode_execution=true\n`,
      ),
      { ...baseline, capabilitiesDisabled: new Set(["code_execution"]) },
    );
    expect(e.capabilitiesDisabled.has("code_execution")).toBe(true);
  });

  test("an absent block disables nothing", () => {
    const e = computeEnforced(parsePolicyToml(`[policy]\nversion=1\norg="x"\n`), baseline);
    expect([...e.capabilitiesDisabled]).toEqual([]);
  });
});

describe("computeEnforced — monotonic stricter", () => {
  test("retention floor raises but never lowers", () => {
    const e = computeEnforced(
      parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.retention]\nmin_days=30\n`),
      baseline,
    );
    expect(e.retentionDays).toBe(30);
    const e2 = computeEnforced(
      parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.retention]\nmin_days=3\n`),
      baseline,
    );
    expect(e2.retentionDays).toBe(7);
  });

  test("HITL required = union; policy cannot drop a local requirement", () => {
    const e = computeEnforced(
      parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.hitl]\nrequire=["db.drop"]\n`),
      baseline,
    );
    expect([...e.hitlRequired].sort()).toEqual(["db.drop", "git.force_push_main"]);
  });

  test("quorum approvers = max(local, policy); raise-then-lower toward baseline both apply (no high-water lock)", () => {
    const raise = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."terraform.destroy"]\napprovers=3\nwindow_seconds=900\n`,
      ),
      baseline,
    );
    expect(raise.quorum.get("terraform.destroy")?.approvers).toBe(3);
    const lower = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."terraform.destroy"]\napprovers=2\nwindow_seconds=900\n`,
      ),
      baseline,
    );
    expect(lower.quorum.get("terraform.destroy")?.approvers).toBe(2);
  });

  test("policy below baseline quorum cannot weaken it", () => {
    const e = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."terraform.destroy"]\napprovers=1\nwindow_seconds=900\n`,
      ),
      {
        ...baseline,
        quorum: new Map<string, QuorumRule>([
          ["terraform.destroy", { approvers: 2, windowSeconds: 600 }],
        ]),
      },
    );
    expect(e.quorum.get("terraform.destroy")?.approvers).toBe(2);
  });

  test("connectors allow passes through (undefined = unrestricted)", () => {
    const e = computeEnforced(
      parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.connectors]\nallow=["github"]\n`),
      baseline,
    );
    expect(e.connectorAllow).toEqual(["github"]);
  });

  test("quorum window = min of defined positive windows (shorter is stricter; policy cannot lengthen)", () => {
    // policy window 3600 vs local 600 -> 600 (policy cannot loosen by lengthening)
    const longer = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."terraform.destroy"]\napprovers=2\nwindow_seconds=3600\n`,
      ),
      baseline,
    );
    expect(longer.quorum.get("terraform.destroy")?.windowSeconds).toBe(600);
    // policy window 120 vs local 600 -> 120 (policy tightens the window)
    const shorter = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."terraform.destroy"]\napprovers=2\nwindow_seconds=120\n`,
      ),
      baseline,
    );
    expect(shorter.quorum.get("terraform.destroy")?.windowSeconds).toBe(120);
    // action with no local baseline rule -> takes policy window
    const fresh = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."db.drop"]\napprovers=2\nwindow_seconds=900\n`,
      ),
      baseline,
    );
    expect(fresh.quorum.get("db.drop")?.windowSeconds).toBe(900);
  });

  test("policy quorum window_seconds <= 0 is ignored; falls back to local window (line 39 false side)", () => {
    // parsePolicyToml drops rules with window<=0, so feed computeEnforced a hand-built policy
    // whose quorum window is 0 to exercise the `pol.windowSeconds > 0 ? ... : undefined` false arm.
    const policy = {
      version: 1,
      org: "x",
      connectors: {},
      retention: { minDays: 0 },
      hitl: {
        require: [] as string[],
        quorum: new Map<string, QuorumRule>([
          ["terraform.destroy", { approvers: 2, windowSeconds: 0 }],
        ]),
      },
      audit: {},
      chatops: { channels: new Map(), ownership: new Map() },
      capabilities: { disabled: [] as string[] },
    };
    const e = computeEnforced(policy, baseline);
    // local window 600 survives because policy contributed no positive window
    expect(e.quorum.get("terraform.destroy")).toEqual({ approvers: 2, windowSeconds: 600 });
  });

  test("no defined positive windows yields windowSeconds 0 (line 41 false side)", () => {
    // baseline has NO rule for this id and policy window is 0 -> windows array empty -> 0
    const policy = {
      version: 1,
      org: "x",
      connectors: {},
      retention: { minDays: 0 },
      hitl: {
        require: [] as string[],
        quorum: new Map<string, QuorumRule>([["db.drop", { approvers: 2, windowSeconds: 0 }]]),
      },
      audit: {},
      chatops: { channels: new Map(), ownership: new Map() },
      capabilities: { disabled: [] as string[] },
    };
    const e = computeEnforced(policy, baseline);
    expect(e.quorum.get("db.drop")).toEqual({ approvers: 2, windowSeconds: 0 });
  });

  test("audit shipTo + shipFormat present pass through (lines 50/51 false sides)", () => {
    const e = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.audit]\nship_to="https://siem/ingest"\nship_format="ndjson"\n`,
      ),
      baseline,
    );
    expect(e.auditShipTo).toBe("https://siem/ingest");
    expect(e.auditShipFormat).toBe("ndjson");
  });

  test("baseline-only quorum action (absent from policy) survives untouched", () => {
    // policy defines quorum only for db.drop; baseline's terraform.destroy must be preserved verbatim
    const e = computeEnforced(
      parsePolicyToml(
        `[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."db.drop"]\napprovers=2\nwindow_seconds=900\n`,
      ),
      baseline,
    );
    expect(e.quorum.get("terraform.destroy")).toEqual({ approvers: 1, windowSeconds: 600 });
    expect(e.quorum.get("db.drop")).toEqual({ approvers: 2, windowSeconds: 900 });
  });
});

describe("PolicyGate", () => {
  function freshStore(): PolicyStore {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    return new PolicyStore(db);
  }

  test("ungoverned gate (empty store) returns the baseline verbatim and source 'none'", () => {
    const gate = new PolicyGate(freshStore(), baseline);
    expect(gate.status().signatureValid).toBe(false);
    expect(gate.status().source).toBe("none");
    expect(gate.enforced().retentionDays).toBe(7);
    expect([...gate.enforced().hitlRequired]).toEqual(["git.force_push_main"]);
  });

  test("rehydrate is fail-closed: persisted policy but NO pinned pubkey => stays ungoverned", () => {
    const store = freshStore();
    const kp = generateEd25519Keypair();
    const toml = `[policy]\nversion=2\norg="acme"\n[policy.retention]\nmin_days=30\n`;
    store.persist({
      toml,
      sig: signPolicy(toml, encodeBase64(kp.privkey)),
      org: "acme",
      version: 2,
      source: "peer",
      fetchedAt: 5,
    });
    // no pinAnchorPubkey call
    const gate = new PolicyGate(store, baseline);
    expect(gate.status().signatureValid).toBe(false);
    expect(gate.enforced().retentionDays).toBe(7);
  });

  test("rehydrate applies a persisted+pinned valid policy; enforced reflects it", () => {
    const store = freshStore();
    const kp = generateEd25519Keypair();
    const toml = `[policy]\nversion=2\norg="acme"\n[policy.retention]\nmin_days=30\n`;
    store.pinAnchorPubkey(encodeBase64(kp.pubkey), "manual", 1);
    store.persist({
      toml,
      sig: signPolicy(toml, encodeBase64(kp.privkey)),
      org: "acme",
      version: 2,
      source: "peer",
      fetchedAt: 5,
    });
    const gate = new PolicyGate(store, baseline);
    expect(gate.status().signatureValid).toBe(true);
    expect(gate.status().version).toBe(2);
    expect(gate.enforced().retentionDays).toBe(30);
  });

  test("applyVerified updates the enforced view and pendingRestart flag", () => {
    const gate = new PolicyGate(freshStore(), baseline);
    const policy = parsePolicyToml(
      `[policy]\nversion=3\norg="acme"\n[policy.retention]\nmin_days=45\n`,
    );
    gate.applyVerified(
      policy,
      { toml: "x", sig: "y", org: "acme", version: 3, source: "anchor", fetchedAt: 9 },
      true,
    );
    expect(gate.status().pendingRestart).toBe(true);
    expect(gate.status().source).toBe("anchor");
    expect(gate.enforced().retentionDays).toBe(45);
  });

  test("rehydrate maps persisted source 'none' to 'peer' (line 106 true side)", () => {
    const store = freshStore();
    const kp = generateEd25519Keypair();
    const toml = `[policy]\nversion=2\norg="acme"\n[policy.retention]\nmin_days=30\n`;
    store.pinAnchorPubkey(encodeBase64(kp.pubkey), "manual", 1);
    store.persist({
      toml,
      sig: signPolicy(toml, encodeBase64(kp.privkey)),
      org: "acme",
      version: 2,
      source: "none",
      fetchedAt: 5,
    });
    const gate = new PolicyGate(store, baseline);
    expect(gate.status().signatureValid).toBe(true);
    expect(gate.status().source).toBe("peer");
  });

  test("applyVerified maps persisted source 'none' to 'peer' (line 119 true side)", () => {
    const gate = new PolicyGate(freshStore(), baseline);
    const policy = parsePolicyToml(`[policy]\nversion=3\norg="acme"\n`);
    gate.applyVerified(
      policy,
      { toml: "x", sig: "y", org: "acme", version: 3, source: "none", fetchedAt: 9 },
      false,
    );
    expect(gate.status().source).toBe("peer");
  });

  test("verifyCandidate returns null for a tampered bundle, parsed policy for a valid one", () => {
    const kp = generateEd25519Keypair();
    const toml = `[policy]\nversion=1\norg="acme"\n[policy.retention]\nmin_days=30\n`;
    const sig = signPolicy(toml, encodeBase64(kp.privkey));
    const pub = encodeBase64(kp.pubkey);
    expect(verifyCandidate(toml.replace("30", "99"), sig, pub)).toBeNull();
    const ok = verifyCandidate(toml, sig, pub);
    expect(ok?.retention.minDays).toBe(30);
  });
});
