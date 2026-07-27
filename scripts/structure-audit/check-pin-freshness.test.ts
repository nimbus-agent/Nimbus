import { describe, expect, test } from "bun:test";

import {
  collectPinnedActions,
  DEFAULT_GRACE_DAYS,
  evaluatePin,
  type PinnedAction,
  parseCommitDate,
  parseLatestRelease,
  parseTagObjectType,
  parseTagSha,
  summarize,
  TRACKED_REF_OVERRIDES,
} from "./check-pin-freshness.ts";

const pin = (over: Partial<PinnedAction> = {}): PinnedAction => ({
  ownerRepo: "actions/checkout",
  sha: "a".repeat(40),
  file: "ci.yml",
  ...over,
});

describe("collectPinnedActions", () => {
  test("collects a SHA-pinned third-party ref with its owner/repo", () => {
    const p = collectPinnedActions([
      { path: "ci.yml", text: `  - uses: actions/checkout@${"a".repeat(40)} # v7.0.1\n` },
    ]);
    expect(p).toEqual([{ ownerRepo: "actions/checkout", sha: "a".repeat(40), file: "ci.yml" }]);
  });

  test("reduces a subdirectory action to its owner/repo", () => {
    const p = collectPinnedActions([
      { path: "a.yml", text: `  - uses: github/codeql-action/init@${"b".repeat(40)}\n` },
    ]);
    expect(p[0]?.ownerRepo).toBe("github/codeql-action");
  });

  test("ignores tag-pinned refs — that is the EXISTING gate's job, not this one", () => {
    expect(
      collectPinnedActions([{ path: "a.yml", text: "  - uses: actions/checkout@v4\n" }]),
    ).toEqual([]);
  });

  test("ignores local and docker refs", () => {
    const p = collectPinnedActions([
      { path: "a.yml", text: "  - uses: ./.github/actions/x\n  - uses: docker://alpine:3\n" },
    ]);
    expect(p).toEqual([]);
  });

  test("deduplicates one action pinned to the same SHA in several files", () => {
    const sha = "c".repeat(40);
    const p = collectPinnedActions([
      { path: "a.yml", text: `  - uses: o/r@${sha}\n` },
      { path: "b.yml", text: `  - uses: o/r@${sha}\n` },
    ]);
    expect(p).toHaveLength(1);
  });

  test("keeps two DIFFERENT pins of the same action — that is itself drift", () => {
    const p = collectPinnedActions([
      { path: "a.yml", text: `  - uses: o/r@${"a".repeat(40)}\n` },
      { path: "b.yml", text: `  - uses: o/r@${"b".repeat(40)}\n` },
    ]);
    expect(p).toHaveLength(2);
  });
});

describe("evaluatePin", () => {
  const sha = "a".repeat(40);
  const old = "2020-01-01T00:00:00Z";
  const fresh = new Date(Date.now() - 2 * 86_400_000).toISOString();

  test("pinned to the latest release SHA => ok", () => {
    const r = evaluatePin(
      pin({ sha }),
      { tag: "v7.0.1", publishedAt: old },
      sha,
      DEFAULT_GRACE_DAYS,
    );
    expect(r.verdict).toBe("ok");
  });

  test("behind a release older than grace => stale, naming both versions", () => {
    const r = evaluatePin(pin({ sha }), { tag: "v7.0.1", publishedAt: old }, "b".repeat(40), 30);
    expect(r.verdict).toBe("stale");
    expect(r.detail).toContain("v7.0.1");
  });

  test("behind a release published INSIDE the grace window => ok", () => {
    // A release cut two days ago must not red the org: humans and Dependabot
    // need time to move, and a gate that reds instantly is one people mute.
    const r = evaluatePin(pin({ sha }), { tag: "v8.0.0", publishedAt: fresh }, "b".repeat(40), 30);
    expect(r.verdict).toBe("ok");
  });

  test("unreadable release => indeterminate, never stale", () => {
    expect(evaluatePin(pin(), null, null, 30).verdict).toBe("indeterminate");
  });

  test("release readable but its tag SHA is not => indeterminate", () => {
    const r = evaluatePin(pin(), { tag: "v1", publishedAt: old }, null, 30);
    expect(r.verdict).toBe("indeterminate");
  });

  test("an unparseable publish date fails closed to stale, not silently ok", () => {
    // Mirrors ageHours in the release-train core: a NaN age would satisfy
    // `NaN > grace === false` and mask staleness as current.
    const r = evaluatePin(
      pin({ sha }),
      { tag: "v9", publishedAt: "not-a-date" },
      "b".repeat(40),
      30,
    );
    expect(r.verdict).toBe("stale");
  });

  test("an EMPTY publishedAt yields stale — which is why a caller must never fabricate one", () => {
    // `daysSince("")` fails closed to +Infinity, so handing evaluatePin a
    // dated result built from a FAILED read would manufacture a `stale` finding
    // out of a transient error. The tracked-ref branch therefore builds
    // `latest` only once both the ref read and the commit-date read succeed,
    // and otherwise passes null so this path reports indeterminate instead.
    const r = evaluatePin(pin({ sha }), { tag: "stable", publishedAt: "" }, "b".repeat(40), 30);
    expect(r.verdict).toBe("stale");
    expect(evaluatePin(pin({ sha }), null, "b".repeat(40), 30).verdict).toBe("indeterminate");
  });

  test("a timestamp with no timezone also fails closed", () => {
    const r = evaluatePin(
      pin({ sha }),
      { tag: "v9", publishedAt: "2020-01-01T00:00:00" },
      "b".repeat(40),
      30,
    );
    expect(r.verdict).toBe("stale");
  });
});

describe("summarize", () => {
  const res = (verdict: "ok" | "stale" | "indeterminate") => ({
    ownerRepo: "o/r",
    verdict,
    detail: "d",
  });

  test("any stale pin => exit 1", () => {
    expect(summarize([res("ok"), res("stale")], true).code).toBe(1);
  });

  test("ok + indeterminate => exit 0 with a warning", () => {
    const out = summarize([res("ok"), res("indeterminate")], true);
    expect(out.code).toBe(0);
    expect(out.messages.join("\n")).toContain("::warning::");
  });

  test("nothing evaluable under --strict => exit 1, not 'all clear'", () => {
    expect(summarize([res("indeterminate")], true).code).toBe(1);
  });

  test("nothing evaluable when NOT strict => exit 0 (soft locally)", () => {
    expect(summarize([res("indeterminate")], false).code).toBe(0);
  });
});

describe("parseLatestRelease / parseTagSha", () => {
  test("reads tag_name and published_at", () => {
    expect(
      parseLatestRelease('{"tag_name":"v7.0.1","published_at":"2026-01-01T00:00:00Z"}'),
    ).toEqual({ tag: "v7.0.1", publishedAt: "2026-01-01T00:00:00Z" });
  });
  test("null on malformed json or a missing tag", () => {
    expect(parseLatestRelease("{nope")).toBeNull();
    expect(parseLatestRelease("{}")).toBeNull();
  });
  test("reads a lightweight tag's commit sha", () => {
    expect(parseTagSha(`{"object":{"sha":"${"a".repeat(40)}","type":"commit"}}`)).toBe(
      "a".repeat(40),
    );
  });
  test("null on malformed json", () => {
    expect(parseTagSha("{nope")).toBeNull();
  });
  test("reads an annotated tag's object type so it can be dereferenced", () => {
    expect(parseTagObjectType(`{"object":{"sha":"x","type":"tag"}}`)).toBe("tag");
    expect(parseTagObjectType(`{"object":{"sha":"x","type":"commit"}}`)).toBe("commit");
  });
});

describe("TRACKED_REF_OVERRIDES", () => {
  test("every override names a git ref namespace, not a bare branch name", () => {
    // The value is spliced into `git/ref/<value>`, so `stable` alone would 404
    // and silently degrade the pin to indeterminate rather than checking it.
    for (const ref of Object.values(TRACKED_REF_OVERRIDES)) {
      expect(ref).toMatch(/^(heads|tags)\//);
    }
  });

  test("the map stays small — an entry is a claim about intent, not a mute button", () => {
    expect(Object.keys(TRACKED_REF_OVERRIDES).length).toBeLessThanOrEqual(3);
  });

  test("rust-toolchain is tracked against stable, the ref its pin comment names", () => {
    // Its newest release `v1` sits behind the `stable` branch, so comparing
    // against the release would demand moving the pin BACKWARDS to go green.
    expect(TRACKED_REF_OVERRIDES["dtolnay/rust-toolchain"]).toBe("heads/stable");
  });
});

describe("parseCommitDate", () => {
  test("reads commit.committer.date", () => {
    expect(parseCommitDate('{"commit":{"committer":{"date":"2026-07-01T00:00:00Z"}}}')).toBe(
      "2026-07-01T00:00:00Z",
    );
  });
  test("null on malformed json or a missing date", () => {
    expect(parseCommitDate("{nope")).toBeNull();
    expect(parseCommitDate('{"commit":{}}')).toBeNull();
  });
});
