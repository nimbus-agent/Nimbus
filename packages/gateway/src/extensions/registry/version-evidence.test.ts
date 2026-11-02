import { describe, expect, test } from "bun:test";
import type {
  LivenessEntry,
  LivenessEntryRead,
  RegistryVersionEntry,
} from "@nimbus-dev/registry-format";
import type { RegistryLivenessRead } from "./registry-liveness.ts";
import {
  checkedEvidence,
  compareVersionQuality,
  evidenceApprovalFields,
  LIVENESS_CAVEAT,
  localInstallEvidence,
  qualityUnreadable,
  versionEvidence,
} from "./version-evidence.ts";

function quality(passed: number, cases: number): Record<string, unknown> {
  return {
    scorer: 1,
    score: Math.floor((passed * 100) / cases),
    cases,
    passed,
    rubrics: {
      exact: { cases, passed },
      "json-match": { cases: 0, passed: 0 },
      "one-of": { cases: 0, passed: 0 },
    },
  };
}

function entry(publishedAt: string, q?: unknown): RegistryVersionEntry {
  const base = { channel: "stable", publishedAt };
  return (q === undefined ? base : { ...base, quality: q }) as unknown as RegistryVersionEntry;
}

const NOW = Date.parse("2026-11-01T10:00:00Z");
const base = { registry: "acme-reg", declaresNetwork: false, starterPack: false, now: NOW };

describe("versionEvidence tested", () => {
  test("scored", () => {
    const e = versionEvidence({
      ...base,
      versions: { "1.0.0": entry("2026-10-29T00:00:00Z", quality(9, 10)) },
      version: "1.0.0",
    });
    expect(e.tested).toEqual({
      state: "scored",
      score: 90,
      cases: 10,
      passed: 9,
      measuredBy: "acme-reg",
      text: "9 of 10 cases passed (90/100), tests by the publisher, measured by acme-reg",
    });
  });
  test("a package declaring a network says its tests had none", () => {
    const e = versionEvidence({
      ...base,
      declaresNetwork: true,
      versions: { "1.0.0": entry("2026-10-29T00:00:00Z", quality(9, 10)) },
      version: "1.0.0",
    });
    expect(e.tested.text).toBe(
      "9 of 10 cases passed (90/100), tests by the publisher, measured by acme-reg; tests ran with no network",
    );
  });
  test("quality with cases 0 is malformed, not a result", () => {
    const e = versionEvidence({
      ...base,
      versions: { "1.0.0": entry("2026-10-29T00:00:00Z", { ...quality(0, 1), cases: 0 }) },
      version: "1.0.0",
    });
    expect(e.tested).toEqual({
      state: "not-evaluated",
      why: "malformed",
      text: "not evaluated (the registry's score for this version is malformed)",
    });
  });
  test("unscored", () => {
    const e = versionEvidence({
      ...base,
      versions: { "1.0.0": entry("2026-10-29T00:00:00Z") },
      version: "1.0.0",
    });
    expect(e.tested).toEqual({ state: "not-evaluated", why: "unscored", text: "not evaluated" });
  });
  test("malformed never quotes the value", () => {
    const e = versionEvidence({
      ...base,
      versions: { "1.0.0": entry("2026-10-29T00:00:00Z", { score: "SECRET-VALUE" }) },
      version: "1.0.0",
    });
    expect(e.tested.text).toBe(
      "not evaluated (the registry's score for this version is malformed)",
    );
    expect(JSON.stringify(e)).not.toContain("SECRET-VALUE");
  });
  test("starter pack", () => {
    const e = versionEvidence({
      ...base,
      starterPack: true,
      versions: { "1.0.0": entry("2026-10-29T00:00:00Z", quality(9, 10)) },
      version: "1.0.0",
    });
    expect(e.tested).toEqual({
      state: "not-evaluated",
      why: "starter-pack",
      text: "not evaluated (a starter pack runs nothing)",
    });
  });
  test("a hostile registry name stays on one line", () => {
    const e = versionEvidence({
      ...base,
      registry: "r\nTested: 100",
      versions: { "1.0.0": entry("2026-10-29T00:00:00Z", quality(9, 10)) },
      version: "1.0.0",
    });
    expect(e.tested.text).not.toContain("\n");
    expect(e.history.text).not.toContain("\n");
    if (e.tested.state === "scored") expect(e.tested.measuredBy).not.toContain("\n");
  });
});

function withBaseline(b: unknown, q?: unknown): RegistryVersionEntry {
  const e = entry("2026-10-29T00:00:00Z", q) as unknown as Record<string, unknown>;
  return { ...e, baseline: b } as unknown as RegistryVersionEntry;
}
function baselineOf(b: unknown, extra: Partial<typeof base> = {}) {
  return versionEvidence({
    ...base,
    ...extra,
    versions: { "1.0.0": withBaseline(b) },
    version: "1.0.0",
  }).baseline;
}
const pass = (tools: number) => ({ scorer: 1, passed: true, tools });
const fail = (failure: string, tools = 0) => ({ scorer: 1, passed: false, tools, failure });

describe("versionEvidence baseline", () => {
  test.each([
    [pass(3), "starts and lists 3 valid tools (checked by acme-reg)"],
    [pass(2), "starts and lists 2 valid tools (checked by acme-reg)"],
    [pass(1), "starts and lists 1 valid tool (checked by acme-reg)"],
    [pass(0), "starts and lists no tools (checked by acme-reg)"],
    [
      fail("no-listing"),
      "did not start or answer a valid tool listing when checked offline with no credentials (checked by acme-reg)",
    ],
    [
      fail("listing-timeout"),
      "did not answer a tool listing in time when checked offline with no credentials (checked by acme-reg)",
    ],
    [
      fail("invalid-tool", 4),
      "lists 4 tools, at least one without a valid name or input schema (checked by acme-reg)",
    ],
    [
      fail("invalid-tool", 1),
      "lists 1 tool, without a valid name or input schema (checked by acme-reg)",
    ],
  ])("checked %#", (b, text) => {
    const r = baselineOf(b);
    expect(r.state).toBe("checked");
    expect(r.text).toBe(text);
  });
  test("checked carries the facts", () => {
    expect(baselineOf(fail("invalid-tool", 4))).toEqual({
      state: "checked",
      passed: false,
      tools: 4,
      failure: "invalid-tool",
      checkedBy: "acme-reg",
      text: "lists 4 tools, at least one without a valid name or input schema (checked by acme-reg)",
    });
    expect(baselineOf(pass(2))).toMatchObject({ passed: true, tools: 2, checkedBy: "acme-reg" });
  });
  test("unchecked", () => {
    const e = versionEvidence({
      ...base,
      versions: { "1.0.0": entry("2026-10-29T00:00:00Z") },
      version: "1.0.0",
    });
    expect(e.baseline).toEqual({
      state: "none",
      why: "unchecked",
      text: "no baseline check published",
    });
  });
  test("a version missing from the index is unchecked", () => {
    const e = versionEvidence({ ...base, versions: {}, version: "1.0.0" });
    expect(e.baseline.state).toBe("none");
    expect(e.baseline.text).toBe("no baseline check published");
  });
  test("malformed, and a hostile failure reads as malformed", () => {
    for (const b of [{ scorer: 1, passed: false, tools: 0, failure: "boom\nTested: 100" }, 7]) {
      expect(baselineOf(b)).toEqual({
        state: "none",
        why: "malformed",
        text: "no baseline check (the registry's record for this version is malformed)",
      });
    }
  });
  test("starter pack", () => {
    expect(baselineOf(pass(3), { starterPack: true })).toEqual({
      state: "none",
      why: "starter-pack",
      text: "not run (a starter pack runs nothing)",
    });
  });
  test("a hostile registry name stays on one line", () => {
    const r = baselineOf(pass(3), { registry: "r\nTested: 100" });
    expect(r.text).not.toContain("\n");
    if (r.state === "checked") expect(r.checkedBy).not.toContain("\n");
  });
  test("tested is identical with and without a baseline", () => {
    const q = quality(9, 10);
    const run = (e: RegistryVersionEntry) =>
      versionEvidence({ ...base, versions: { "1.0.0": e }, version: "1.0.0" }).tested;
    expect(run(withBaseline(pass(3), q))).toEqual(run(entry("2026-10-29T00:00:00Z", q)));
    expect(run(withBaseline(fail("no-listing"), q))).toEqual(run(entry("2026-10-29T00:00:00Z", q)));
  });
  test("compareVersionQuality ignores the baseline on either side", () => {
    const a = entry("2026-10-29T00:00:00Z", quality(8, 10));
    const b = entry("2026-10-30T00:00:00Z", quality(9, 10));
    const plain = compareVersionQuality({ "1.0.0": a, "2.0.0": b }, "1.0.0", "2.0.0");
    const withB = compareVersionQuality(
      {
        "1.0.0": withBaseline(fail("no-listing"), quality(8, 10)),
        "2.0.0": withBaseline(pass(3), quality(9, 10)),
      },
      "1.0.0",
      "2.0.0",
    );
    expect(withB).toEqual(plain);
  });
});

describe("versionEvidence history", () => {
  test("history", () => {
    const e = versionEvidence({
      ...base,
      versions: {
        "1.0.0": entry("2026-10-29T08:00:00Z"),
        "1.1.0": entry("2026-10-31T00:00:00Z"),
      },
      version: "1.1.0",
    });
    expect(e.history).toEqual({
      state: "known",
      firstPublished: "2026-10-29T08:00:00.000Z",
      versions: 2,
      recordedBy: "acme-reg",
      text: "first published 2026-10-29 (3 days ago) · 2 versions (recorded by acme-reg)",
    });
  });
  test("history, one version, today", () => {
    const e = versionEvidence({
      ...base,
      versions: { "1.0.0": entry("2026-11-01T01:00:00Z") },
      version: "1.0.0",
    });
    expect(e.history.text).toBe(
      "first published 2026-11-01 (today) · 1 version (recorded by acme-reg)",
    );
  });
  test("history, yesterday", () => {
    const e = versionEvidence({
      ...base,
      versions: { "1.0.0": entry("2026-10-31T23:00:00Z") },
      version: "1.0.0",
    });
    expect(e.history.text).toContain("(1 day ago)");
  });
  test("history, a date in the future", () => {
    const e = versionEvidence({
      ...base,
      versions: { "1.0.0": entry("2030-01-01T00:00:00Z") },
      version: "1.0.0",
    });
    expect(e.history.text).toBe(
      "first published 2030-01-01 (dated in the future) · 1 version (recorded by acme-reg)",
    );
  });
  test("a history date is canonical, whatever spelling the index signed", () => {
    const e = versionEvidence({
      ...base,
      versions: { "1.0.0": entry("Nov 1, 2026 12:00 UTC") },
      version: "1.0.0",
    });
    expect(e.history.text).toContain("first published 2026-11-01 (today)");
    expect(e.history.text).not.toContain("Nov 1");
    expect(e.history.state).toBe("known");
    if (e.history.state === "known") {
      expect(e.history.firstPublished).toBe("2026-11-01T12:00:00.000Z");
    }
  });
  test("no versions listed", () => {
    const e = versionEvidence({ ...base, versions: {}, version: "1.0.0" });
    expect(e.history).toEqual({ state: "none", text: "none (no versions listed)" });
  });
});

describe("localInstallEvidence and checked", () => {
  test("local", () => {
    const e = localInstallEvidence();
    expect(e.tested).toEqual({
      state: "not-evaluated",
      why: "local",
      text: "not evaluated (from a local folder)",
    });
    expect(e.history).toEqual({ state: "none", text: "none (from a local folder)" });
    expect(e.checked).toEqual({
      state: "none",
      why: "local",
      text: "no checks published (from a local folder)",
    });
    expect(e.baseline).toEqual({
      state: "none",
      why: "local",
      text: "not run (from a local folder)",
    });
  });
  test("a caller that passes no liveness states unavailable, never none-published", () => {
    const e = versionEvidence({
      ...base,
      versions: { "1.0.0": entry("2026-10-29T00:00:00Z") },
      version: "1.0.0",
    });
    expect(e.checked).toEqual({
      state: "unavailable",
      why: "unreadable",
      text: "no checks available",
    });
  });
});

const CK = { registry: "acme-reg", starterPack: false, now: NOW };
const verified = (entry: LivenessEntryRead, nimbusVersion = "10.14.1"): RegistryLivenessRead => ({
  state: "verified",
  nimbusVersion,
  entry,
});
const found = (e: Partial<LivenessEntry> & { checkedAt?: string }): LivenessEntryRead => ({
  state: "found",
  entry: { checkedAt: "2026-10-31T08:00:00.000Z", ...e },
});

describe("checkedEvidence", () => {
  test("the fixed texts", () => {
    expect(checkedEvidence({ ...CK, liveness: { state: "none" } })).toEqual({
      state: "none",
      why: "unpublished",
      text: "no checks published",
    });
    expect(checkedEvidence({ ...CK, liveness: verified({ state: "absent" }) })).toEqual({
      state: "none",
      why: "version-absent",
      text: "no checks published for this version",
    });
    expect(checkedEvidence({ ...CK, liveness: { state: "unavailable" } })).toEqual({
      state: "unavailable",
      why: "unreadable",
      text: "no checks available",
    });
    expect(checkedEvidence({ ...CK, liveness: undefined }).text).toBe("no checks available");
    expect(checkedEvidence({ ...CK, liveness: verified({ state: "invalid" }) })).toEqual({
      state: "unavailable",
      why: "malformed-entry",
      text: "no checks available",
    });
  });
  test("a starter pack wins over a verified entry", () => {
    expect(checkedEvidence({ ...CK, starterPack: true, liveness: verified(found({})) })).toEqual({
      state: "none",
      why: "starter-pack",
      text: "not checked (a starter pack runs nothing)",
    });
  });
  test("every part, exactly", () => {
    const r = checkedEvidence({
      ...CK,
      liveness: verified(
        found({
          hosts: { declared: 3, answered: 2 },
          tests: { cases: 5, passed: 4 },
          baseline: { scorer: 1, passed: true, tools: 2 },
        }),
      ),
    });
    expect(r.text).toBe(
      "2 of 3 declared hosts answered · tests: 4 of 5 cases passed · starts and lists 2 valid tools (checked 2026-10-31, 1 day ago, with Nimbus 10.14.1, by acme-reg); does not prove the service's API is unchanged",
    );
    expect(r).toMatchObject({ state: "checked", stale: false, nimbusVersion: "10.14.1" });
  });
  test.each([
    ["run-failed", "run failed"],
    ["run-timeout", "run timed out"],
    ["sandbox-unavailable", "no sandbox"],
  ] as const)("tests failure %s", (failure, words) => {
    const r = checkedEvidence({
      ...CK,
      liveness: verified(found({ hosts: { declared: 1, answered: 0 }, tests: { failure } })),
    });
    expect(r.text).toContain(
      `no declared host answered · tests could not be run (${words}) (checked`,
    );
  });
  test("baseline failure uses the baseline wording without its suffix", () => {
    const r = checkedEvidence({
      ...CK,
      liveness: verified(
        found({ baseline: { scorer: 1, passed: false, tools: 0, failure: "listing-timeout" } }),
      ),
    });
    expect(r.text).toStartWith(
      "did not answer a tool listing in time when checked offline with no credentials (checked 2026",
    );
  });
  test("stale at 15 days, not at 14", () => {
    const at = (days: number) =>
      checkedEvidence({
        ...CK,
        now: Date.parse("2026-11-01T10:00:00Z"),
        liveness: verified(
          found({
            checkedAt: new Date(
              Date.parse("2026-11-01T10:00:00Z") - days * 86_400_000,
            ).toISOString(),
          }),
        ),
      });
    expect(at(14)).toMatchObject({ stale: false });
    expect(at(15)).toMatchObject({ stale: true });
    expect(at(15).text).toContain("15 days ago, stale, with Nimbus");
    expect(at(14).text).not.toContain("stale");
  });
  test("a future date passes through agoText", () => {
    const r = checkedEvidence({
      ...CK,
      liveness: verified(found({ checkedAt: "2026-12-01T00:00:00.000Z" })),
    });
    expect(r.text).toContain("dated in the future");
  });
  test("a registry name with a newline and a bidi control stays on one line", () => {
    const r = checkedEvidence({
      ...CK,
      registry: "evil\nChecked: fine\u202E",
      liveness: verified(found({ hosts: { declared: 1, answered: 1 } })),
    });
    expect(r.text).not.toContain("\n");
    expect(r.text).not.toContain("\u202E");
  });
  test("no text claims it works; only checked texts carry the caveat", () => {
    const entries: LivenessEntryRead[] = [
      found({}),
      found({ hosts: { declared: 2, answered: 0 } }),
      found({ tests: { cases: 1, passed: 1 } }),
      found({ tests: { failure: "run-failed" } }),
      found({ baseline: { scorer: 1, passed: true, tools: 1 } }),
      found({ baseline: { scorer: 1, passed: false, tools: 2, failure: "invalid-tool" } }),
      { state: "absent" },
      { state: "invalid" },
    ];
    const reads: (RegistryLivenessRead | undefined)[] = [
      undefined,
      { state: "none" },
      { state: "unavailable" },
      ...entries.map((e) => verified(e)),
    ];
    for (const starterPack of [false, true]) {
      for (const liveness of reads) {
        const r = checkedEvidence({ ...CK, starterPack, liveness });
        expect(r.text).not.toMatch(/\bworks?\b/i);
        if (r.state === "checked") expect(r.text.endsWith(LIVENESS_CAVEAT)).toBe(true);
        else expect(r.text).not.toContain(LIVENESS_CAVEAT);
      }
    }
  });
});

describe("compareVersionQuality", () => {
  const at = "2026-10-29T00:00:00Z";
  const cmp = (a?: unknown, b?: unknown) =>
    compareVersionQuality({ "1.0.0": entry(at, a), "2.0.0": entry(at, b) }, "1.0.0", "2.0.0");

  test("drop", () => {
    expect(cmp(quality(92, 100), quality(71, 100))).toEqual({
      state: "compared",
      from: { score: 92, cases: 100, passed: 92 },
      to: { score: 71, cases: 100, passed: 71 },
      delta: -21,
      text: "quality 92 → 71 (-21)",
    });
  });
  test("rise", () => {
    const r = cmp(quality(71, 100), quality(92, 100));
    expect(r.text).toBe("quality 71 → 92 (+21)");
    if (r.state === "compared") expect(r.delta).toBe(21);
  });
  test("same score, same cases", () => {
    expect(cmp(quality(92, 100), quality(92, 100)).text).toBe("quality unchanged at 92/100");
  });
  test("cases differ", () => {
    expect(cmp(quality(37, 40), quality(19, 20)).text).toBe(
      "quality 92/100 on 40 cases → 95/100 on 20 cases",
    );
  });
  test("same score, cases differ", () => {
    const r = cmp(quality(37, 40), quality(23, 25));
    expect(r.text).toBe("quality 92/100 on 40 cases → 92/100 on 25 cases");
    expect(r.state).toBe("compared");
    if (r.state === "compared") {
      expect(r.delta).toBe(0);
      expect(r.from.cases).toBe(40);
      expect(r.to.cases).toBe(25);
    }
  });
  test("installed version not in the index", () => {
    expect(compareVersionQuality({ "2.0.0": entry(at, quality(9, 10)) }, "1.0.0", "2.0.0")).toEqual(
      {
        state: "not-compared",
        why: "installed-unscored",
        text: "quality not compared: 1.0.0 is not scored",
      },
    );
  });
  test("candidate unscored", () => {
    expect(cmp(quality(9, 10), undefined)).toEqual({
      state: "not-compared",
      why: "candidate-unscored",
      text: "quality not compared: 2.0.0 is not scored",
    });
  });
  test("both unscored", () => {
    expect(cmp(undefined, undefined)).toEqual({
      state: "not-compared",
      why: "both-unscored",
      text: "quality not compared: neither version is scored",
    });
  });
  test("malformed side", () => {
    expect(cmp({ bad: 1 }, quality(9, 10))).toEqual({
      state: "not-compared",
      why: "installed-malformed",
      text: "quality not compared: 1.0.0 has a malformed score",
    });
    expect(cmp(quality(9, 10), { bad: 1 })).toEqual({
      state: "not-compared",
      why: "candidate-malformed",
      text: "quality not compared: 2.0.0 has a malformed score",
    });
  });
  test("candidate gone", () => {
    expect(compareVersionQuality({ "1.0.0": entry(at, quality(9, 10)) }, "1.0.0", "2.0.0")).toEqual(
      {
        state: "not-compared",
        why: "candidate-gone",
        text: "quality not compared: 2.0.0 is no longer in the index",
      },
    );
    expect(compareVersionQuality({}, "1.0.0", "2.0.0").state).toBe("not-compared");
  });
  test("unreadable", () => {
    expect(qualityUnreadable()).toEqual({
      state: "not-compared",
      why: "registry-unreadable",
      text: "quality not compared: the registry could not be read or verified just now",
    });
  });
});

describe("evidenceApprovalFields", () => {
  const evidence = localInstallEvidence();
  test("one package states the four lines and no scope", () => {
    expect(evidenceApprovalFields(evidence, "com.example.a", 1)).toEqual({
      baseline: "not run (from a local folder)",
      tested: "not evaluated (from a local folder)",
      history: "none (from a local folder)",
      checked: "no checks published (from a local folder)",
    });
    expect(evidenceApprovalFields(evidence, "com.example.a", 0)).not.toHaveProperty(
      "evidenceScope",
    );
  });
  test("two packages say the other package, three say the 2 other packages", () => {
    expect(evidenceApprovalFields(evidence, "com.example.a", 2).evidenceScope).toBe(
      "for com.example.a only; the other package in this plan is not summarised here",
    );
    expect(evidenceApprovalFields(evidence, "com.example.a", 3).evidenceScope).toBe(
      "for com.example.a only; the 2 other packages in this plan are not summarised here",
    );
  });
  test("an id cannot forge a line of the prompt", () => {
    expect(evidenceApprovalFields(evidence, "a\nforged", 2).evidenceScope).not.toContain("\n");
  });
});
