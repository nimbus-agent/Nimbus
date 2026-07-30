import { describe, expect, test } from "bun:test";

import type { BypassActor } from "./check-bypass-actors.ts";
import { type AttestationCheckInput, evaluateAttestation } from "./check-bypass-attestation.ts";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const DAY = 86_400_000;

const DECLARED: Record<string, BypassActor[]> = {
  Nimbus: [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }],
  "nimbus-sdk": [],
};

function attestation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    attested_at: new Date(NOW - 3 * DAY).toISOString(),
    attested_by: "asafgolombek",
    grace_days: 90,
    repos: ["Nimbus", "nimbus-sdk"],
    observed: {
      Nimbus: [{ actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" }],
      "nimbus-sdk": [],
    },
    ...overrides,
  });
}

function input(overrides: Partial<AttestationCheckInput> = {}): AttestationCheckInput {
  return {
    raw: attestation(),
    declaredRepos: ["Nimbus", "nimbus-sdk"],
    declaredBypass: DECLARED,
    graceDays: 90,
    nowMs: NOW,
    ...overrides,
  };
}

describe("evaluateAttestation", () => {
  test("passes on a fresh, complete, agreeing attestation", () => {
    const r = evaluateAttestation(input());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("reports an absent file distinctly from an unparseable one", () => {
    expect(evaluateAttestation(input({ raw: null })).errors[0]).toContain("no attestation file");
    expect(evaluateAttestation(input({ raw: "{oops" })).errors[0]).toContain("not valid JSON");
  });

  test("reports legal JSON that is not an object as unparseable", () => {
    expect(evaluateAttestation(input({ raw: "[]" })).errors[0]).toContain("not valid JSON");
  });

  test("fails one day past the grace window", () => {
    const raw = attestation({ attested_at: new Date(NOW - 91 * DAY).toISOString() });
    const r = evaluateAttestation(input({ raw }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("91d old (grace 90d)");
  });

  test("reads grace from config, not from the attestation's own grace_days", () => {
    const raw = attestation({
      attested_at: new Date(NOW - 45 * DAY).toISOString(),
      grace_days: 90,
    });
    expect(evaluateAttestation(input({ raw, graceDays: 90 })).ok).toBe(true);
    // A hand-edited grace_days:90 cannot widen a config that says 30.
    expect(evaluateAttestation(input({ raw, graceDays: 30 })).ok).toBe(false);
  });

  // NaN comparisons are ALL false, so a naive `elapsed > grace` check PASSES.
  test("treats an unparseable attested_at as a finding, never as fresh", () => {
    const raw = attestation({ attested_at: "not-a-date" });
    const r = evaluateAttestation(input({ raw }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("not a parseable timestamp");
  });

  test("rejects a future-dated attestation beyond the skew tolerance", () => {
    const raw = attestation({ attested_at: new Date(NOW + 2 * 3_600_000).toISOString() });
    const r = evaluateAttestation(input({ raw }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("in the future");
  });

  test("tolerates small forward clock skew", () => {
    const raw = attestation({ attested_at: new Date(NOW + 10 * 60_000).toISOString() });
    expect(evaluateAttestation(input({ raw })).ok).toBe(true);
  });

  test("fails when a newly declared repo is not covered by the attestation", () => {
    const r = evaluateAttestation(
      input({
        declaredRepos: ["Nimbus", "nimbus-sdk", "nimbus-new"],
        declaredBypass: { ...DECLARED, "nimbus-new": [] },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("do not match declared repos"))).toBe(true);
  });

  // The second NaN fail-open: `elapsed > NaN` is false, so an unguarded missing
  // attestation_grace_days would report a 10-year-old attestation as fresh.
  test("a non-numeric grace window is a finding, not a silently disabled check", () => {
    const raw = attestation({ attested_at: new Date(NOW - 3650 * DAY).toISOString() });
    const r = evaluateAttestation(input({ raw, graceDays: Number.NaN }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("attestation_grace_days"))).toBe(true);
  });

  test("a zero or negative grace window is a finding", () => {
    for (const bad of [0, -30]) {
      const r = evaluateAttestation(input({ graceDays: bad }));
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("attestation_grace_days"))).toBe(true);
    }
  });

  test("fails when the attested snapshot no longer agrees with declared intent", () => {
    const r = evaluateAttestation(input({ declaredBypass: { ...DECLARED, Nimbus: [] } }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("drifts from declared intent");
  });
});
