import { describe, expect, test } from "bun:test";
import type { RegistryVersionEntry } from "@nimbus-dev/registry-format";
import {
  compareVersionQuality,
  evidenceApprovalFields,
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
      text: "not evaluated (installed from a local folder)",
    });
    expect(e.history).toEqual({ state: "none", text: "none (installed from a local folder)" });
    expect(e.checked).toEqual({ state: "none", text: "no checks published" });
  });
  test("checked", () => {
    const e = versionEvidence({
      ...base,
      versions: { "1.0.0": entry("2026-10-29T00:00:00Z") },
      version: "1.0.0",
    });
    expect(e.checked).toEqual({ state: "none", text: "no checks published" });
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
      text: "quality not compared: the registry could not be read just now",
    });
  });
});

describe("evidenceApprovalFields", () => {
  const evidence = localInstallEvidence();
  test("one package states the three lines and no scope", () => {
    expect(evidenceApprovalFields(evidence, "com.example.a", 1)).toEqual({
      tested: "not evaluated (installed from a local folder)",
      history: "none (installed from a local folder)",
      checked: "no checks published",
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
