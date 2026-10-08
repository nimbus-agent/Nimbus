import { describe, expect, test } from "bun:test";

import {
  buildPrMetadata,
  canonicalEpochMs,
  gitlabEventTransition,
  normalizeBitbucketPrState,
  normalizeGithubPrState,
  normalizeGitlabMrState,
  PR_EMITTED_KEYS,
  PR_META_VERSION,
} from "./pr-meta.ts";

describe("normalizers", () => {
  test("github: merged wins over state", () => {
    expect(normalizeGithubPrState("closed", true)).toBe("merged");
    expect(normalizeGithubPrState("closed", false)).toBe("closed");
    expect(normalizeGithubPrState("open", false)).toBe("open");
    expect(normalizeGithubPrState(undefined, false)).toBeUndefined();
    expect(normalizeGithubPrState("draft-ish", false)).toBe("unknown");
  });
  test("bitbucket: upper-case vocabulary", () => {
    expect(normalizeBitbucketPrState("OPEN")).toBe("open");
    expect(normalizeBitbucketPrState("MERGED")).toBe("merged");
    expect(normalizeBitbucketPrState("DECLINED")).toBe("closed");
    expect(normalizeBitbucketPrState("SUPERSEDED")).toBe("closed");
    expect(normalizeBitbucketPrState("merged")).toBe("unknown");
    expect(normalizeBitbucketPrState(undefined)).toBeUndefined();
  });
  test("gitlab MR state (fetchOne)", () => {
    expect(normalizeGitlabMrState("opened")).toBe("open");
    expect(normalizeGitlabMrState("merged")).toBe("merged");
    expect(normalizeGitlabMrState("closed")).toBe("closed");
    expect(normalizeGitlabMrState("locked")).toBe("closed");
    expect(normalizeGitlabMrState(undefined)).toBeUndefined();
  });
  test("gitlab event transitions: only state-changing actions", () => {
    expect(gitlabEventTransition("accepted")).toBe("merged");
    expect(gitlabEventTransition("merged")).toBe("merged");
    expect(gitlabEventTransition("opened")).toBe("open");
    expect(gitlabEventTransition("reopened")).toBe("open");
    expect(gitlabEventTransition("closed")).toBe("closed");
    expect(gitlabEventTransition("approved")).toBeNull();
    expect(gitlabEventTransition("commented on")).toBeNull();
    expect(gitlabEventTransition(undefined)).toBeNull();
  });
  test("prototype-named values never resolve to Object members", () => {
    for (const v of ["constructor", "__proto__", "toString"]) {
      expect(normalizeBitbucketPrState(v)).toBe("unknown");
      expect(normalizeGitlabMrState(v)).toBe("unknown");
      expect(normalizeGithubPrState(v, false)).toBe("unknown");
      expect(gitlabEventTransition(v)).toBeNull();
    }
  });
});

describe("canonicalEpochMs", () => {
  test("accepts positive integers and parseable ISO strings only", () => {
    expect(canonicalEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(canonicalEpochMs("2026-10-08T12:00:00Z")).toBe(Date.parse("2026-10-08T12:00:00Z"));
    expect(canonicalEpochMs(0)).toBeUndefined();
    expect(canonicalEpochMs(-5)).toBeUndefined();
    expect(canonicalEpochMs(1.5)).toBeUndefined();
    expect(canonicalEpochMs(Number.NaN)).toBeUndefined();
    expect(canonicalEpochMs("not a date")).toBeUndefined();
    expect(canonicalEpochMs("")).toBeUndefined();
    expect(canonicalEpochMs(undefined)).toBeUndefined();
    expect(canonicalEpochMs(null)).toBeUndefined();
  });
});

describe("buildPrMetadata", () => {
  test("derives merged from state, strips colliding raw keys, stamps meta_v", () => {
    const out = buildPrMetadata(
      { state: "MERGED", merged: false, merged_at: "bogus", id: 4 },
      { state: "merged", stateRaw: "MERGED", openedAtMs: 1_000, repo: "acme/app" },
    );
    expect(out).toEqual({
      id: 4,
      state: "merged",
      state_raw: "MERGED",
      merged: true,
      opened_at_ms: 1_000,
      repo: "acme/app",
      meta_v: PR_META_VERSION,
    });
  });
  test("absent state writes neither state nor merged", () => {
    const out = buildPrMetadata({}, { repo: "acme/app" });
    expect("state" in out).toBe(false);
    expect("merged" in out).toBe(false);
  });
  test("merged_at is dropped when the state is not merged", () => {
    const out = buildPrMetadata({}, { state: "open", mergedAtMs: 5_000 });
    expect("merged_at" in out).toBe(false);
  });
  test("merged_at is kept when merged, and when state is unknown", () => {
    expect(buildPrMetadata({}, { state: "merged", mergedAtMs: 5_000 })["merged_at"]).toBe(5_000);
    expect(buildPrMetadata({}, { mergedAtMs: 5_000 })["merged_at"]).toBe(5_000);
  });
  test("bitbucket's table omits merged_at", () => {
    expect(PR_EMITTED_KEYS.bitbucket.has("merged_at")).toBe(false);
    expect(PR_EMITTED_KEYS.github.has("merged_at")).toBe(true);
  });
});
