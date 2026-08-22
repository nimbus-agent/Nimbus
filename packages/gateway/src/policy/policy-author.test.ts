import { describe, expect, test } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { openSeededInMemoryDb } from "../../test/helpers/migrated-db-seed.ts";
import { type AuthorDeps, authorPolicy } from "./policy-author.ts";
import { buildPolicyGate } from "./policy-gate.ts";
import { verifyPolicy } from "./policy-signing.ts";
import { PolicyStore } from "./policy-store.ts";

const VALID_TOML = `[policy]
version = 2
org = "acme"

[policy.retention]
min_days = 30

[policy.hitl]
require = ["db.drop"]
`;

function freshDeps(): { deps: AuthorDeps; pubkeyB64: string; privkeyB64: string } {
  const db = openSeededInMemoryDb(36);
  const store = new PolicyStore(db);
  const gate = buildPolicyGate(db, store, {
    retentionDays: 7,
    hitlRequired: new Set<string>(),
    quorum: new Map(),
    capabilitiesDisabled: new Set(),
  });
  const kp = generateEd25519Keypair();
  const privkeyB64 = encodeBase64(kp.privkey);
  const pubkeyB64 = encodeBase64(kp.pubkey);
  return {
    deps: { store, gate, db, privkeyB64, pubkeyB64, nowMs: 1_700_000_000_000 },
    pubkeyB64,
    privkeyB64,
  };
}

function auditCount(db: AuthorDeps["db"], actionType: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM audit_log WHERE action_type = ?")
    .get(actionType) as { n: number };
  return row.n;
}

describe("authorPolicy", () => {
  test("valid toml → ok, gate enforces it, store persists source=anchor, audit row written", () => {
    const { deps } = freshDeps();
    const result = authorPolicy(deps, VALID_TOML);

    expect(result.ok).toBe(true);
    // Gate reflects the new policy.
    const enforced = deps.gate.enforced();
    expect(enforced.retentionDays).toBe(30);
    expect(enforced.hitlRequired.has("db.drop")).toBe(true);
    // Store persisted with source "anchor".
    const loaded = deps.store.load();
    expect(loaded?.source).toBe("anchor");
    expect(loaded?.org).toBe("acme");
    expect(loaded?.version).toBe(2);
    // Anchor pinned itself.
    expect(deps.store.getAnchorPubkey()).toBe(deps.pubkeyB64);
    // Audit row exists.
    expect(auditCount(deps.db, "policy.applied")).toBe(1);
  });

  test("empty org → ok:false, nothing persisted", () => {
    const { deps } = freshDeps();
    const result = authorPolicy(deps, `[policy]\nversion = 1\norg = ""\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("org");
    expect(deps.store.load()).toBeUndefined();
  });

  test("version < 1 → ok:false", () => {
    const { deps } = freshDeps();
    const result = authorPolicy(deps, `[policy]\nversion = 0\norg = "acme"\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("version");
  });

  test("returned bundle verifies against the anchor pubkey", () => {
    const { deps, pubkeyB64 } = freshDeps();
    const result = authorPolicy(deps, VALID_TOML);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(verifyPolicy(result.bundle.toml, result.bundle.sig, pubkeyB64)).toBe(true);
    }
  });

  test("result/bundle NEVER contains the privkey", () => {
    const { deps, privkeyB64 } = freshDeps();
    const result = authorPolicy(deps, VALID_TOML);
    expect(JSON.stringify(result)).not.toContain(privkeyB64);
  });
});
