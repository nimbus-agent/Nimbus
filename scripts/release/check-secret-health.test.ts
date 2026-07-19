import { describe, expect, test } from "bun:test";
import {
  classifyPatProbe,
  evaluateCertExpiry,
  type PatStrategy,
  runSecretHealth,
  safeParseDate,
  summarize,
} from "./check-secret-health.ts";
import type { GitHubApi, IssueRef, ProbeResult, Release, RepoPerms } from "./gh-api.ts";
import { computeStateHash, markerFor, openOrUpdateHealthIssue } from "./open-health-issue.ts";

describe("classifyPatProbe", () => {
  test("repo-write: push true → ok, false → insufficient, 401 → dead", () => {
    const s = { kind: "repo-write", targetRepo: "o/r" } as const;
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
      return opts.repoPerms ?? { push: true };
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
