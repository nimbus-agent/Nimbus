import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_REGISTRY,
  HARD_DEADLINE_LEAD_DAYS,
  LAST_MANUAL_AUDIT,
  MANUAL_AUDIT_MAX_AGE_DAYS,
} from "./credential-registry";

describe("CREDENTIAL_REGISTRY", () => {
  test("every entry is uniquely keyed by scope+repo+product+name", () => {
    const keys = CREDENTIAL_REGISTRY.map(
      (e) => `${e.location.scope}:${e.location.repo ?? "-"}:${e.product}:${e.name}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("repo-scoped entries name a repo and org-scoped entries do not", () => {
    for (const e of CREDENTIAL_REGISTRY) {
      if (e.location.scope === "repo") expect(e.location.repo).toBeTruthy();
      else expect(e.location.repo).toBeUndefined();
    }
  });

  test("expectedVisibility is only set on org-scoped entries", () => {
    for (const e of CREDENTIAL_REGISTRY) {
      if (e.expectedVisibility !== undefined) expect(e.location.scope).toBe("org");
    }
  });

  test("forbidden entries carry no rotation policy — they must not exist at all", () => {
    for (const e of CREDENTIAL_REGISTRY.filter((x) => x.state === "forbidden")) {
      expect(e.maxAgeDays).toBeNull();
      expect(e.hardDeadline).toBeNull();
    }
  });

  test("signing keys opt out of age-based rotation", () => {
    for (const e of CREDENTIAL_REGISTRY.filter((x) => x.type === "signing-key")) {
      expect(e.maxAgeDays).toBeNull();
    }
  });

  test("every entry states a valid owner handle and a meaningful note", () => {
    for (const e of CREDENTIAL_REGISTRY) {
      expect(e.owner).toMatch(/^@/);
      expect(e.note.length).toBeGreaterThanOrEqual(15);
    }
  });

  test("the manifest holds exactly the audited set: 36 entries across 4 locations", () => {
    expect(CREDENTIAL_REGISTRY.length).toBe(36);

    const counts = new Map<string, number>();
    for (const e of CREDENTIAL_REGISTRY) {
      const loc = e.location.scope === "org" ? "ORG" : (e.location.repo ?? "-");
      counts.set(loc, (counts.get(loc) ?? 0) + 1);
    }
    expect(counts.get("ORG")).toBe(4);
    expect(counts.get("Nimbus")).toBe(23);
    expect(counts.get("nimbus-vscode")).toBe(2);
    expect(counts.get("nimbus-web-clipper")).toBe(7);
  });

  test("hardDeadline is an ISO date when present", () => {
    for (const e of CREDENTIAL_REGISTRY) {
      if (e.hardDeadline !== null) expect(e.hardDeadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("thresholds and the audit stamp are the agreed values", () => {
    expect(HARD_DEADLINE_LEAD_DAYS).toBe(90);
    expect(MANUAL_AUDIT_MAX_AGE_DAYS).toBe(90);
    expect(LAST_MANUAL_AUDIT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // The token is org-scoped (confirmed 2026-07-22), so the 2026-12-01 global-PAT
  // decommission does not apply to it. What does bite is the token's own expiry:
  // publishing breaks on 2026-09-20 unless it is regenerated. Pinned so the
  // earlier, real date cannot silently regress back to the decommission date.
  test("the VSCE_PAT deadline is its expiry, not the global decommission", () => {
    const vsce = CREDENTIAL_REGISTRY.find((e) => e.name === "VSCE_PAT");
    expect(vsce?.hardDeadline).toBe("2026-09-20");
    expect(vsce?.hardDeadline).not.toBe("2026-12-01");
  });

  test("NPM_TOKEN is forbidden — it was revoked 2026-07-19 and must stay gone", () => {
    const npm = CREDENTIAL_REGISTRY.find((e) => e.name === "NPM_TOKEN");
    expect(npm?.state).toBe("forbidden");
  });
});
