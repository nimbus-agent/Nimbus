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

  test("every entry states an owner and a note", () => {
    for (const e of CREDENTIAL_REGISTRY) {
      expect(e.owner.length).toBeGreaterThan(0);
      expect(e.note.length).toBeGreaterThan(0);
    }
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

  test("the VSCE_PAT decommission deadline is recorded", () => {
    const vsce = CREDENTIAL_REGISTRY.find((e) => e.name === "VSCE_PAT");
    expect(vsce?.hardDeadline).toBe("2026-12-01");
  });

  test("NPM_TOKEN is forbidden — it was revoked 2026-07-19 and must stay gone", () => {
    const npm = CREDENTIAL_REGISTRY.find((e) => e.name === "NPM_TOKEN");
    expect(npm?.state).toBe("forbidden");
  });
});
