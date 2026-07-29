import { describe, expect, test } from "bun:test";
import {
  ALL_HEALTH_STATUSES,
  annotationsFor,
  BROKEN_HEADING,
  classifyAppMint,
  classifyPatProbe,
  classifyProvenanceOutcome,
  composeProvenanceDetail,
  describePatOutcome,
  evaluateCertExpiry,
  HEALTH_STATUS_CATALOGUE_COMPLETE,
  HEALTHY_HEADING,
  type HealthRow,
  type PatStrategy,
  runSecretHealth,
  SCHEDULED_HEADING,
  safeParseDate,
  severityOf,
  summarize,
} from "./check-secret-health.ts";
import type { GitHubApi, IssueRef, ProbeResult, Release, RepoPerms } from "./gh-api.ts";
import { computeStateHash, markerFor, openOrUpdateHealthIssue } from "./open-health-issue.ts";

describe("classifyPatProbe", () => {
  test("repo-write: push true → ok, false → insufficient, 401 → dead", () => {
    const s = { kind: "repo-write", targetRepos: ["o/r"] } as const;
    expect(classifyPatProbe(s, { status: 200, scopes: null, push: true })).toBe("ok");
    expect(classifyPatProbe(s, { status: 200, scopes: null, push: false })).toBe("insufficient");
    expect(classifyPatProbe(s, { status: 401, scopes: null })).toBe("dead");
    expect(classifyPatProbe(s, { status: 500, scopes: null })).toBe("indeterminate");
  });
  test("scopes: required present → ok, absent → insufficient", () => {
    const s = { kind: "scopes", required: "public_repo" } as const;
    expect(classifyPatProbe(s, { status: 200, scopes: "public_repo, gist" })).toBe("ok");
    expect(classifyPatProbe(s, { status: 200, scopes: "gist" })).toBe("insufficient");
    expect(classifyPatProbe(s, { status: 401, scopes: null })).toBe("dead");
  });
  test("alive: 200 → ok, 401 → dead, other → indeterminate", () => {
    const s = { kind: "alive" } as const;
    expect(classifyPatProbe(s, { status: 200, scopes: null })).toBe("ok");
    expect(classifyPatProbe(s, { status: 401, scopes: null })).toBe("dead");
    expect(classifyPatProbe(s, { status: 403, scopes: null })).toBe("indeterminate");
  });
});

describe("classifyAppMint", () => {
  test("success outcome → ok", () => {
    expect(classifyAppMint("success")).toBe("ok");
  });
  test("failure outcome → dead", () => {
    expect(classifyAppMint("failure")).toBe("dead");
  });
  test("skipped outcome → dead (fail-closed: a skipped mint step alerts)", () => {
    expect(classifyAppMint("skipped")).toBe("dead");
  });
  test("empty/unset outcome → dead (fail-closed: missing App secret alerts)", () => {
    expect(classifyAppMint("")).toBe("dead");
  });
});

describe("evaluateCertExpiry", () => {
  const now = new Date("2026-07-18T00:00:00Z");
  test("past → expired", () => {
    expect(evaluateCertExpiry(new Date("2026-07-17T00:00:00Z"), now, 21)).toBe("expired");
  });
  test("within threshold → expiring", () => {
    expect(evaluateCertExpiry(new Date("2026-08-01T00:00:00Z"), now, 21)).toBe("expiring");
  });
  test("beyond threshold → ok", () => {
    expect(evaluateCertExpiry(new Date("2026-09-01T00:00:00Z"), now, 21)).toBe("ok");
  });
  test("null (undecodable) → indeterminate", () => {
    expect(evaluateCertExpiry(null, now, 21)).toBe("indeterminate");
  });
  test("NaN date → indeterminate (never a false ok)", () => {
    expect(evaluateCertExpiry(new Date("nonsense"), now, 21)).toBe("indeterminate");
  });
});

describe("safeParseDate", () => {
  test("valid openssl notAfter string → Date", () => {
    expect(safeParseDate("Jul 18 12:00:00 2028 GMT")?.getUTCFullYear()).toBe(2028);
  });
  test("garbage → null", () => {
    expect(safeParseDate("not a date")).toBeNull();
  });
});

describe("summarize", () => {
  test("dead PAT or expired cert → hard failure", () => {
    const r = summarize([{ name: "RELEASE_PAT", kind: "pat", status: "dead", detail: "" }]);
    expect(r.hasHardFailure).toBe(true);
    expect(r.table).toContain("RELEASE_PAT");
  });
  test("expiring cert → warning, not hard failure", () => {
    const r = summarize([{ name: "GPG", kind: "cert", status: "expiring", detail: "12d" }]);
    expect(r.hasHardFailure).toBe(false);
    expect(r.hasWarning).toBe(true);
  });
  test("all ok → neither", () => {
    const r = summarize([{ name: "X", kind: "pat", status: "ok", detail: "" }]);
    expect(r.hasHardFailure).toBe(false);
    expect(r.hasWarning).toBe(false);
  });
  test("dead RELEASE_BOT_APP row (from classifyAppMint) → hard failure", () => {
    const r = summarize([
      {
        name: "RELEASE_BOT_APP",
        kind: "pat",
        status: classifyAppMint("failure"),
        detail: "scoped mint: Nimbus+homebrew-tap+scoop-bucket+linux-repo",
      },
    ]);
    expect(r.hasHardFailure).toBe(true);
    expect(r.table).toContain("RELEASE_BOT_APP");
  });
  test("ok RELEASE_BOT_APP row (from classifyAppMint) → not a hard failure", () => {
    const r = summarize([
      {
        name: "RELEASE_BOT_APP",
        kind: "pat",
        status: classifyAppMint("success"),
        detail: "scoped mint: Nimbus+homebrew-tap+scoop-bucket+linux-repo",
      },
    ]);
    expect(r.hasHardFailure).toBe(false);
  });
});

// --- Orchestration integration tests: a hand-written fake GitHubApi (no HTTP), records calls ---

interface FakeApiCalls {
  probeToken: unknown[][];
  getRepoPermissions: unknown[][];
  listOpenIssues: unknown[][];
  createIssue: unknown[][];
  updateIssue: unknown[][];
  commentIssue: unknown[][];
  closeIssue: unknown[][];
  ensureLabel: unknown[][];
}

function createFakeApi(
  opts: {
    probeResults?: Record<string, ProbeResult>;
    repoPerms?: RepoPerms | { status: number };
    repoPermsByRepo?: Record<string, RepoPerms | { status: number }>;
    existingIssues?: IssueRef[];
  } = {},
): GitHubApi & { calls: FakeApiCalls } {
  const calls: FakeApiCalls = {
    probeToken: [],
    getRepoPermissions: [],
    listOpenIssues: [],
    createIssue: [],
    updateIssue: [],
    commentIssue: [],
    closeIssue: [],
    ensureLabel: [],
  };
  let issues = [...(opts.existingIssues ?? [])];
  let nextIssueNumber = 100;
  return {
    calls,
    async getReleaseByTag(_tag: string): Promise<Release | null> {
      return null;
    },
    async getRepoPermissions(ownerRepo, token) {
      calls.getRepoPermissions.push([ownerRepo, token]);
      return opts.repoPermsByRepo?.[ownerRepo] ?? opts.repoPerms ?? { push: true };
    },
    async probeToken(token) {
      calls.probeToken.push([token]);
      return opts.probeResults?.[token] ?? { status: 200, scopes: null };
    },
    async listOpenIssues(label) {
      calls.listOpenIssues.push([label]);
      return issues;
    },
    async createIssue(title, body, labels) {
      calls.createIssue.push([title, body, labels]);
      const number = nextIssueNumber++;
      issues = [...issues, { number, body, createdAt: new Date().toISOString() }];
      return number;
    },
    async updateIssue(num, body) {
      calls.updateIssue.push([num, body]);
      issues = issues.map((i) => (i.number === num ? { ...i, body } : i));
    },
    async commentIssue(num, body) {
      calls.commentIssue.push([num, body]);
    },
    async closeIssue(num, comment) {
      calls.closeIssue.push([num, comment]);
      issues = issues.filter((i) => i.number !== num);
    },
    async ensureLabel(label) {
      calls.ensureLabel.push([label]);
    },
  };
}

describe("runSecretHealth (orchestration)", () => {
  test("hard failure: a dead PAT opens/updates the secret-health issue and returns hardFailure:true", async () => {
    const api = createFakeApi({
      probeResults: { "dead-token": { status: 401, scopes: null } },
    });
    const result = await runSecretHealth({
      api,
      now: new Date("2026-07-18T00:00:00Z"),
      thresholdDays: 21,
      pats: [
        {
          env: "RELEASE_PAT",
          token: "dead-token",
          strategy: { kind: "alive" } as PatStrategy,
        },
      ],
      certs: [],
    });
    expect(result.hardFailure).toBe(true);
    expect(api.calls.ensureLabel.length).toBe(1);
    expect(api.calls.createIssue.length).toBe(1);
    expect(api.calls.closeIssue.length).toBe(0);
  });

  test("all healthy: probes ok + certs decode far-future → closes any open issue, returns hardFailure:false", async () => {
    const existingBody = `${markerFor("secret-health")}\n<!-- release-health-state:stale -->\n\nprevious alert`;
    const api = createFakeApi({
      probeResults: { "good-token": { status: 200, scopes: null } },
      existingIssues: [{ number: 7, body: existingBody, createdAt: "2020-01-01T00:00:00Z" }],
    });
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 400);
    const result = await runSecretHealth({
      api,
      now: new Date(),
      thresholdDays: 21,
      pats: [
        {
          env: "RELEASE_PAT",
          token: "good-token",
          strategy: { kind: "alive" } as PatStrategy,
        },
      ],
      certs: [
        {
          name: "GPG_SIGNING_SUBKEY",
          secretEnv: "GPG_SIGNING_SUBKEY",
          passwordEnv: "GPG_PASSPHRASE",
          present: true,
          decode: async () => farFuture,
        },
      ],
    });
    expect(result.hardFailure).toBe(false);
    expect(api.calls.closeIssue.length).toBe(1);
    expect(api.calls.createIssue.length).toBe(0);
    expect(api.calls.updateIssue.length).toBe(0);
  });

  test("repo-write multi-repo: push:true on every target repo → ok, no hard failure (T4)", async () => {
    const api = createFakeApi({
      probeResults: { "pm-token": { status: 200, scopes: null } },
      repoPermsByRepo: {
        "nimbus-agent/homebrew-tap": { push: true },
        "nimbus-agent/scoop-bucket": { push: true },
      },
    });
    const result = await runSecretHealth({
      api,
      now: new Date("2026-07-18T00:00:00Z"),
      thresholdDays: 21,
      pats: [
        {
          env: "PACKAGE_MANAGER_PAT",
          token: "pm-token",
          strategy: {
            kind: "repo-write",
            targetRepos: ["nimbus-agent/homebrew-tap", "nimbus-agent/scoop-bucket"],
          } as PatStrategy,
        },
      ],
      certs: [],
    });
    expect(result.hardFailure).toBe(false);
    expect(api.calls.getRepoPermissions.length).toBe(2);
    expect(api.calls.createIssue.length).toBe(0);
  });

  test("repo-write multi-repo: push:false on one target repo → insufficient hard failure (T4)", async () => {
    const api = createFakeApi({
      probeResults: { "pm-token": { status: 200, scopes: null } },
      repoPermsByRepo: {
        "nimbus-agent/homebrew-tap": { push: true },
        "nimbus-agent/scoop-bucket": { push: false },
      },
    });
    const result = await runSecretHealth({
      api,
      now: new Date("2026-07-18T00:00:00Z"),
      thresholdDays: 21,
      pats: [
        {
          env: "PACKAGE_MANAGER_PAT",
          token: "pm-token",
          strategy: {
            kind: "repo-write",
            targetRepos: ["nimbus-agent/homebrew-tap", "nimbus-agent/scoop-bucket"],
          } as PatStrategy,
        },
      ],
      certs: [],
    });
    expect(result.hardFailure).toBe(true);
    expect(api.calls.createIssue.length).toBe(1);
  });

  test("extraRows: a dead App-mint row (classifyAppMint) opens the issue and returns hardFailure:true, even with otherwise-healthy pats/certs", async () => {
    const api = createFakeApi({
      probeResults: { "good-token": { status: 200, scopes: null } },
    });
    const result = await runSecretHealth({
      api,
      now: new Date("2026-07-18T00:00:00Z"),
      thresholdDays: 21,
      pats: [
        {
          env: "WINGET_PAT",
          token: "good-token",
          strategy: { kind: "alive" } as PatStrategy,
        },
      ],
      certs: [],
      extraRows: [
        {
          name: "RELEASE_BOT_APP",
          kind: "pat",
          status: classifyAppMint("skipped"),
          detail: "scoped mint: Nimbus+homebrew-tap+scoop-bucket+linux-repo",
        },
      ],
    });
    expect(result.hardFailure).toBe(true);
    expect(api.calls.createIssue.length).toBe(1);
  });

  test("extraRows: an ok App-mint row does not trigger a hard failure", async () => {
    const api = createFakeApi({
      probeResults: { "good-token": { status: 200, scopes: null } },
    });
    const result = await runSecretHealth({
      api,
      now: new Date("2026-07-18T00:00:00Z"),
      thresholdDays: 21,
      pats: [
        {
          env: "WINGET_PAT",
          token: "good-token",
          strategy: { kind: "alive" } as PatStrategy,
        },
      ],
      certs: [],
      extraRows: [
        {
          name: "RELEASE_BOT_APP",
          kind: "pat",
          status: classifyAppMint("success"),
          detail: "scoped mint: Nimbus+homebrew-tap+scoop-bucket+linux-repo",
        },
      ],
    });
    expect(result.hardFailure).toBe(false);
    expect(api.calls.createIssue.length).toBe(0);
  });

  // --- the guard this split must never weaken ---
  test("DEAD STILL FAILS: a dead PAT hard-fails even when a deadline row is also present", async () => {
    // The regression this guards: softening the deadline row (so the weekly job
    // stops being red on a scheduled expiry) must not soften the row next to it.
    // A credential the provider just rejected is broken NOW and exits 1, always.
    const api = createFakeApi({ probeResults: { "dead-token": { status: 401, scopes: null } } });
    const result = await runSecretHealth({
      api,
      now: new Date("2026-07-29T00:00:00Z"),
      thresholdDays: 21,
      pats: [
        { env: "WINGET_PAT", token: "dead-token", strategy: { kind: "alive" } as PatStrategy },
      ],
      certs: [],
      extraRows: [
        {
          name: "nimbus-vscode/VSCE_PAT",
          kind: "inventory",
          status: "deadline-approaching",
          detail: "hard deadline 2026-09-20 in 53d",
        },
      ],
    });
    expect(result.hardFailure).toBe(true);
    expect(api.calls.createIssue.length).toBe(1);
    const body = String(api.calls.createIssue[0]?.[1] ?? "");
    expect(body).toContain(BROKEN_HEADING);
    expect(body).toContain("WINGET_PAT");
  });

  test("an approaching deadline alone files the issue but does NOT fail the job", async () => {
    const api = createFakeApi();
    const result = await runSecretHealth({
      api,
      now: new Date("2026-07-29T00:00:00Z"),
      thresholdDays: 21,
      pats: [],
      certs: [],
      extraRows: [
        {
          name: "nimbus-vscode/VSCE_PAT",
          kind: "inventory",
          status: "deadline-approaching",
          detail: "hard deadline 2026-09-20 in 53d",
        },
      ],
    });
    expect(result.hardFailure).toBe(false);
    expect(api.calls.createIssue.length).toBe(1);
    expect(api.calls.closeIssue.length).toBe(0);
  });

  test("the same deadline inside the critical window DOES fail the job", async () => {
    const api = createFakeApi();
    const result = await runSecretHealth({
      api,
      now: new Date("2026-09-10T00:00:00Z"),
      thresholdDays: 21,
      pats: [],
      certs: [],
      extraRows: [
        {
          name: "nimbus-vscode/VSCE_PAT",
          kind: "inventory",
          status: "deadline-critical",
          detail: "hard deadline 2026-09-20 in 10d",
        },
      ],
    });
    expect(result.hardFailure).toBe(true);
  });

  test("repo-write: a repo perms-lookup error object → indeterminate, NOT a hard failure (T6)", async () => {
    const api = createFakeApi({
      probeResults: { "pm-token": { status: 200, scopes: null } },
      repoPermsByRepo: {
        "nimbus-agent/homebrew-tap": { status: 500 },
        "nimbus-agent/scoop-bucket": { push: true },
      },
    });
    const result = await runSecretHealth({
      api,
      now: new Date("2026-07-18T00:00:00Z"),
      thresholdDays: 21,
      pats: [
        {
          env: "PACKAGE_MANAGER_PAT",
          token: "pm-token",
          strategy: {
            kind: "repo-write",
            targetRepos: ["nimbus-agent/homebrew-tap", "nimbus-agent/scoop-bucket"],
          } as PatStrategy,
        },
      ],
      certs: [],
    });
    // indeterminate is a warning, not a hard failure — an errored perms lookup must never
    // masquerade as a false "insufficient".
    expect(result.hardFailure).toBe(false);
    expect(api.calls.createIssue.length).toBe(1);
  });
});

describe("openOrUpdateHealthIssue", () => {
  test("no existing issue: creates the issue and ensures the label", async () => {
    const api = createFakeApi();
    await openOrUpdateHealthIssue(api, {
      key: "secret-health",
      title: "🔑 alert",
      body: "table",
      state: "state-1",
    });
    expect(api.calls.ensureLabel.length).toBe(1);
    expect(api.calls.createIssue.length).toBe(1);
    expect(api.calls.updateIssue.length).toBe(0);
  });

  test("existing issue, state hash differs: updates the issue AND comments", async () => {
    const oldHash = computeStateHash("state-old");
    const existingBody = `${markerFor("secret-health")}\n<!-- release-health-state:${oldHash} -->\n\nold table`;
    const api = createFakeApi({
      existingIssues: [{ number: 42, body: existingBody, createdAt: "2020-01-01T00:00:00Z" }],
    });
    await openOrUpdateHealthIssue(api, {
      key: "secret-health",
      title: "🔑 alert",
      body: "new table",
      state: "state-new",
    });
    expect(api.calls.updateIssue.length).toBe(1);
    expect(api.calls.commentIssue.length).toBe(1);
  });

  test("existing issue, state hash identical: updates the issue but does NOT comment", async () => {
    const sameHash = computeStateHash("state-same");
    const existingBody = `${markerFor("secret-health")}\n<!-- release-health-state:${sameHash} -->\n\nsame table`;
    const api = createFakeApi({
      existingIssues: [{ number: 43, body: existingBody, createdAt: "2020-01-01T00:00:00Z" }],
    });
    await openOrUpdateHealthIssue(api, {
      key: "secret-health",
      title: "🔑 alert",
      body: "same table",
      state: "state-same",
    });
    expect(api.calls.updateIssue.length).toBe(1);
    expect(api.calls.commentIssue.length).toBe(0);
  });
});

describe("classifyProvenanceOutcome", () => {
  test("passes through the action's known statuses", () => {
    expect(classifyProvenanceOutcome("ok")).toBe("ok");
    expect(classifyProvenanceOutcome("missing-provenance")).toBe("missing-provenance");
    expect(classifyProvenanceOutcome("source-mismatch")).toBe("source-mismatch");
    expect(classifyProvenanceOutcome("indeterminate")).toBe("indeterminate");
  });

  test("fails closed: unset or unrecognised is never ok", () => {
    // An empty string means the probe never reported (renamed step id, skipped
    // step, or an action that exits before writing output) — never the same
    // thing as a genuinely absent/unconfigured secret, so it must warn
    // (`indeterminate`), not silently pass as `not-configured` (review finding #1).
    expect(classifyProvenanceOutcome("")).toBe("indeterminate");
    expect(classifyProvenanceOutcome("weird")).toBe("indeterminate");
  });
});

describe("composeProvenanceDetail", () => {
  test("both empty (skipped probe) → the original static placeholder, unchanged", () => {
    expect(composeProvenanceDetail("", "")).toBe("latest published version");
  });

  test("version + action detail present → both are surfaced together", () => {
    expect(
      composeProvenanceDetail(
        "1.3.0",
        "repository https://github.com/attacker/x != https://github.com/nimbus-agent/nimbus-sdk",
      ),
    ).toBe(
      "v1.3.0: repository https://github.com/attacker/x != https://github.com/nimbus-agent/nimbus-sdk",
    );
  });

  test("version present, action detail empty → just the version, no dangling separator", () => {
    expect(composeProvenanceDetail("0.5.0", "")).toBe("v0.5.0");
  });

  test("version empty, action detail present → detail alone with an explicit unknown-version marker", () => {
    expect(composeProvenanceDetail("", "no SLSA provenance predicate — publish degraded")).toBe(
      "unknown version: no SLSA provenance predicate — publish degraded",
    );
  });
});

describe("summarize with the new row kinds", () => {
  test("missing-provenance and source-mismatch are hard failures", () => {
    for (const status of ["missing-provenance", "source-mismatch"] as const) {
      const rows: HealthRow[] = [
        { name: "@nimbus-dev/sdk", kind: "provenance", status, detail: "latest" },
      ];
      expect(summarize(rows).hasHardFailure).toBe(true);
    }
  });

  test("provenance indeterminate warns but does not hard-fail", () => {
    const rows: HealthRow[] = [
      { name: "@nimbus-dev/sdk", kind: "provenance", status: "indeterminate", detail: "HTTP 503" },
    ];
    const s = summarize(rows);
    expect(s.hasHardFailure).toBe(false);
    expect(s.hasWarning).toBe(true);
  });

  test("all-clear stays clean", () => {
    const rows: HealthRow[] = [
      { name: "@nimbus-dev/sdk", kind: "provenance", status: "ok", detail: "latest" },
    ];
    const s = summarize(rows);
    expect(s.hasHardFailure).toBe(false);
    expect(s.hasWarning).toBe(false);
  });

  test("an unreported provenance probe (empty status — renamed/skipped step id, or an action that exits before writing output) warns, never closes the issue as healthy (review finding #1 regression guard)", () => {
    const rows: HealthRow[] = [
      {
        name: "@nimbus-dev/sdk",
        kind: "provenance",
        status: classifyProvenanceOutcome(""),
        detail: "latest published version",
      },
    ];
    const s = summarize(rows);
    // This is the exact defect the review caught: `not-configured` sits in
    // neither `hard` nor `warn`, so a silently-unreported probe took the
    // issue-CLOSING branch and posted "All release credentials healthy". A
    // never-reported probe must warn — never a false ok.
    expect(s.hasHardFailure).toBe(false);
    expect(s.hasWarning).toBe(true);
  });
});

describe("summarize with inventory rows", () => {
  test("undocumented is a hard failure", () => {
    const s = summarize([
      { name: "org/X", kind: "inventory", status: "undocumented", detail: "d" },
    ]);
    expect(s.hasHardFailure).toBe(true);
  });

  test("missing is a hard failure", () => {
    const s = summarize([{ name: "org/X", kind: "inventory", status: "missing", detail: "d" }]);
    expect(s.hasHardFailure).toBe(true);
  });

  test("stale, deadline-approaching, visibility-drift and audit-overdue warn but do not fail", () => {
    for (const status of [
      "stale",
      "deadline-approaching",
      "visibility-drift",
      "audit-overdue",
    ] as const) {
      const s = summarize([{ name: "org/X", kind: "inventory", status, detail: "d" }]);
      expect(s.hasHardFailure).toBe(false);
      expect(s.hasWarning).toBe(true);
    }
  });

  test("deadline-critical is a hard failure — the escalated half of the deadline split", () => {
    const s = summarize([
      {
        name: "nimbus-vscode/VSCE_PAT",
        kind: "inventory",
        status: "deadline-critical",
        detail: "d",
      },
    ]);
    expect(s.hasHardFailure).toBe(true);
  });
});

// --- expiring vs dead: the two states this monitor must never conflate ---

describe("severityOf", () => {
  test("a provider-rejected credential is hard — dead is never downgraded", () => {
    expect(severityOf("dead")).toBe("hard");
    expect(severityOf("insufficient")).toBe("hard");
    expect(severityOf("expired")).toBe("hard");
  });

  test("a calendar deadline with runway left is a warning, and with none is hard", () => {
    expect(severityOf("deadline-approaching")).toBe("warn");
    expect(severityOf("deadline-critical")).toBe("hard");
  });

  test("ok and not-configured are healthy; nothing else is", () => {
    expect(severityOf("ok")).toBe("healthy");
    expect(severityOf("not-configured")).toBe("healthy");
    for (const status of ALL_HEALTH_STATUSES) {
      if (status === "ok" || status === "not-configured") continue;
      expect(severityOf(status)).not.toBe("healthy");
    }
  });

  test("every declared status is classified — nothing falls through as silently healthy", () => {
    // `not-configured` sitting in NEITHER the old hard nor warn set is exactly
    // how an unreported provenance probe once took the issue-CLOSING branch.
    // Now classification is total: every status names its own severity.
    for (const status of ALL_HEALTH_STATUSES) {
      expect(["hard", "warn", "healthy"]).toContain(severityOf(status));
    }
  });

  test("the status catalogue covers the whole union (compile-time proof, asserted at runtime)", () => {
    expect(HEALTH_STATUS_CATALOGUE_COMPLETE).toBe(true);
    expect(new Set(ALL_HEALTH_STATUSES).size).toBe(ALL_HEALTH_STATUSES.length);
  });

  test("an unrecognised status fails closed to hard, never to healthy", () => {
    // A value that slipped past the type system (a renamed action output, a
    // hand-built row) must alarm, not vanish into the healthy section.
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type system to prove the runtime guard
    expect(severityOf("something-nobody-declared" as any)).toBe("hard");
  });
});

describe("summarize sections", () => {
  const section = (table: string, heading: string): string => {
    const start = table.indexOf(heading);
    if (start < 0) return "";
    const rest = table.slice(start + heading.length);
    const nextHeading = rest.search(/^## /m);
    return nextHeading < 0 ? rest : rest.slice(0, nextHeading);
  };

  const rows: readonly HealthRow[] = [
    { name: "WINGET_PAT", kind: "pat", status: "dead", detail: "the provider REJECTED it" },
    {
      name: "nimbus-vscode/VSCE_PAT",
      kind: "inventory",
      status: "deadline-approaching",
      detail: "hard deadline 2026-09-20 in 53d",
    },
    { name: "org/SONAR_TOKEN", kind: "inventory", status: "ok", detail: "secret last set 10d ago" },
  ];

  test("a dead credential lands in the BROKEN section and a live deadline in the SCHEDULED one", () => {
    const { table } = summarize(rows);
    expect(section(table, BROKEN_HEADING)).toContain("WINGET_PAT");
    expect(section(table, SCHEDULED_HEADING)).toContain("nimbus-vscode/VSCE_PAT");
    expect(section(table, HEALTHY_HEADING)).toContain("org/SONAR_TOKEN");
  });

  test("neither state can appear in the other's section — this is the whole point", () => {
    const { table } = summarize(rows);
    expect(section(table, SCHEDULED_HEADING)).not.toContain("WINGET_PAT");
    expect(section(table, BROKEN_HEADING)).not.toContain("nimbus-vscode/VSCE_PAT");
  });

  test("the two headings differ in words AND in leading glyph, not just in status text", () => {
    expect(BROKEN_HEADING).not.toBe(SCHEDULED_HEADING);
    expect(BROKEN_HEADING).toContain("❌");
    expect(SCHEDULED_HEADING).toContain("🟡");
    expect(SCHEDULED_HEADING.toLowerCase()).toContain("nothing here is broken");
  });

  test("the BROKEN heading is always rendered, so 0 → 1 is visible at a glance", () => {
    const clean = summarize([
      { name: "org/SONAR_TOKEN", kind: "inventory", status: "ok", detail: "fresh" },
    ]);
    expect(clean.table).toContain(BROKEN_HEADING);
    expect(section(clean.table, BROKEN_HEADING)).toContain("_None._");
  });

  test("the headline counts each severity so the summary line alone carries the verdict", () => {
    const { table } = summarize(rows);
    expect(table.split("\n")[0]).toBe("**BROKEN: 1 · scheduled: 1 · healthy: 1**");
  });

  test("the body defines the two vocabularies so no reader has to infer them", () => {
    const { table } = summarize(rows);
    expect(table).toContain("live probe");
    expect(table).toContain("credential-registry.ts");
  });
});

describe("annotationsFor", () => {
  test("an approaching deadline emits a ::warning:: annotation, never ::error::", () => {
    const [line] = annotationsFor([
      {
        name: "nimbus-vscode/VSCE_PAT",
        kind: "inventory",
        status: "deadline-approaching",
        detail: "hard deadline 2026-09-20 in 53d",
      },
    ]);
    expect(line).toStartWith("::warning ");
    expect(line).toContain("nimbus-vscode/VSCE_PAT");
    expect(line).toContain("deadline-approaching");
  });

  test("a dead credential emits ::error::, so the run's annotation list separates them too", () => {
    const [line] = annotationsFor([
      { name: "WINGET_PAT", kind: "pat", status: "dead", detail: "rejected" },
    ]);
    expect(line).toStartWith("::error ");
  });

  test("healthy rows emit nothing", () => {
    expect(annotationsFor([{ name: "X", kind: "pat", status: "ok", detail: "" }])).toEqual([]);
  });

  test("detail text can never break out of the workflow command", () => {
    // A workflow command is recognised only at the START of a line, so the
    // property that matters is that no interpolated text can begin a new one:
    // every CR/LF must be encoded. (A bare `::` mid-message is inert once that
    // holds — the runner does not re-scan within a line.) Registry notes are
    // ours, but secret NAMES arrive from the GitHub API, so escape always.
    const lines = annotationsFor([
      {
        name: "EVIL\n::error::spoofed",
        kind: "inventory",
        status: "undocumented",
        detail: "100% broken\r\nsecond line",
      },
    ]);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line.split(/\r|\n/)).toHaveLength(1);
    // Exactly one command is emitted: the one this function intended.
    expect(line.split(/^::/gm)).toHaveLength(2);
    expect(line).toStartWith("::error ");
    expect(line).toContain("%0A");
    expect(line).toContain("%0D");
    expect(line).toContain("%25");
  });
});

describe("describePatOutcome", () => {
  test("a dead PAT says, in words, that the provider rejected it right now", () => {
    const detail = describePatOutcome("dead", { kind: "alive" });
    expect(detail.toLowerCase()).toContain("rejected");
    expect(detail.toLowerCase()).toContain("now");
  });

  test("a healthy PAT keeps the original strategy-kind detail", () => {
    expect(describePatOutcome("ok", { kind: "scopes", required: "public_repo" })).toBe("scopes");
  });
});
