import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const peopleMod = await import("./people.ts");
const { runPeople } = peopleMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

function fakePerson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p1",
    displayName: "Alice",
    canonicalEmail: "alice@example.com",
    githubLogin: "alice",
    gitlabLogin: null,
    slackHandle: null,
    linearMemberId: null,
    jiraAccountId: null,
    notionUserId: null,
    linked: true,
    ...overrides,
  };
}

describe("runPeople — help & dispatch", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("prints help when no subcommand is given", async () => {
    await runPeople([]);
    expect(out.stdout).toContain("nimbus people");
    expect(out.stdout).toContain("Usage:");
  });

  it("prints help for 'help' / '--help' / '-h'", async () => {
    await runPeople(["help"]);
    expect(out.stdout).toContain("nimbus people");
    out.reset();
    await runPeople(["--help"]);
    expect(out.stdout).toContain("nimbus people");
    out.reset();
    await runPeople(["-h"]);
    expect(out.stdout).toContain("nimbus people");
  });

  it("prints error and sets exitCode=1 for unknown subcommand", async () => {
    await runPeople(["bogus"]);
    expect(out.stderr).toContain("Unknown people subcommand: bogus");
    expect(out.stderr).toContain("nimbus people help");
    expect(process.exitCode).toBe(1);
  });
});

describe("runPeople — list", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls people.list with default unlinkedOnly=false, limit=100", async () => {
    const mock = createMockIpcClient([[fakePerson()]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list"]);
    expect(mock.calls[0]).toEqual({
      method: "people.list",
      params: { unlinkedOnly: false, limit: 100 },
    });
    expect(out.stdout).toContain("p1");
    expect(out.stdout).toContain("Alice");
    expect(out.stdout).toContain("github=alice");
    expect(out.stdout).toContain("linked");
  });

  it("honours --unlinked and --limit flags", async () => {
    const mock = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list", "--unlinked", "--limit", "10"]);
    expect(mock.calls[0]).toEqual({
      method: "people.list",
      params: { unlinkedOnly: true, limit: 10 },
    });
  });

  it("prints '—' placeholders when name + email are null", async () => {
    const mock = createMockIpcClient([
      [fakePerson({ displayName: null, canonicalEmail: null, githubLogin: null, linked: false })],
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list"]);
    expect(out.stdout).toContain("unlinked");
    expect(out.stdout).toContain("—");
  });
});

describe("runPeople — search", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls people.search with query + default limit 25", async () => {
    const mock = createMockIpcClient([[fakePerson()]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["search", "alice"]);
    expect(mock.calls[0]).toEqual({
      method: "people.search",
      params: { query: "alice", limit: 25 },
    });
  });

  it("throws usage when query missing", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runPeople(["search"])).rejects.toThrow(/Usage: nimbus people search/);
  });
});

describe("runPeople — get", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls people.get and prints person row", async () => {
    const mock = createMockIpcClient([fakePerson()]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["get", "p1"]);
    expect(mock.calls[0]).toEqual({ method: "people.get", params: { id: "p1" } });
    expect(out.stdout).toContain("p1");
  });

  it("prints '(not found)' when null returned", async () => {
    const mock = createMockIpcClient([null]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["get", "missing"]);
    expect(out.stdout).toContain("(not found)");
  });

  it("throws usage when id missing", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runPeople(["get"])).rejects.toThrow(/Usage: nimbus people get/);
  });
});

describe("runPeople — items", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls people.items with personId and prints tab-delimited rows", async () => {
    const mock = createMockIpcClient([[{ id: "github:pr_1", service: "github", name: "Fix bug" }]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["items", "p1"]);
    expect(mock.calls[0]).toEqual({
      method: "people.items",
      params: { personId: "p1", limit: 50 },
    });
    expect(out.stdout).toContain("github\tgithub:pr_1\tFix bug");
  });

  it("throws usage when id missing", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runPeople(["items"])).rejects.toThrow(/Usage: nimbus people items/);
  });
});

describe("runPeople — link", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls people.merge with both ids and prints 'Merged into <id>'", async () => {
    const mock = createMockIpcClient([{ survivorId: "p1", person: fakePerson() }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["link", "p1", "p2"]);
    expect(mock.calls[0]).toEqual({
      method: "people.merge",
      params: { personIdA: "p1", personIdB: "p2" },
    });
    expect(out.stdout).toContain("Merged into p1");
  });

  it("throws usage when ids missing", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runPeople(["link"])).rejects.toThrow(/Usage: nimbus people link/);
    await expect(runPeople(["link", "p1"])).rejects.toThrow(/Usage: nimbus people link/);
  });

  it("throws usage when id-a is empty string", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runPeople(["link", "", "p2"])).rejects.toThrow(/Usage: nimbus people link/);
  });

  it("throws usage when id-b is empty string", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runPeople(["link", "p1", ""])).rejects.toThrow(/Usage: nimbus people link/);
  });
});

describe("runPeople — printPerson: all handle fields + itemCount", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("prints all handle fields when present", async () => {
    const mock = createMockIpcClient([
      [
        fakePerson({
          githubLogin: "gh-user",
          gitlabLogin: "gl-user",
          slackHandle: "sl-user",
          linearMemberId: "lin-id",
          jiraAccountId: "jira-id",
          notionUserId: "notion-id",
        }),
      ],
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list"]);
    expect(out.stdout).toContain("github=gh-user");
    expect(out.stdout).toContain("gitlab=gl-user");
    expect(out.stdout).toContain("slack=sl-user");
    expect(out.stdout).toContain("linear=lin-id");
    expect(out.stdout).toContain("jira=jira-id");
    expect(out.stdout).toContain("notion=notion-id");
  });

  it("prints itemCount when present", async () => {
    const mock = createMockIpcClient([[fakePerson({ itemCount: 42 })]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list"]);
    expect(out.stdout).toContain("items=42");
  });

  it("omits items= when itemCount is not present", async () => {
    const mock = createMockIpcClient([[fakePerson()]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list"]);
    expect(out.stdout).not.toContain("items=");
  });

  it("omits handle line when all handle fields are null or empty", async () => {
    const mock = createMockIpcClient([
      [
        fakePerson({
          githubLogin: null,
          gitlabLogin: null,
          slackHandle: null,
          linearMemberId: null,
          jiraAccountId: null,
          notionUserId: null,
        }),
      ],
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list"]);
    // The handle line (starting with 3 spaces) should not appear
    expect(out.stdout).not.toContain("   github=");
  });

  it("omits empty-string handle fields from handle line", async () => {
    const mock = createMockIpcClient([
      [
        fakePerson({
          githubLogin: "",
          gitlabLogin: "",
          slackHandle: "my-slack",
        }),
      ],
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list"]);
    expect(out.stdout).not.toContain("github=");
    expect(out.stdout).not.toContain("gitlab=");
    expect(out.stdout).toContain("slack=my-slack");
  });
});

describe("runPeople — search: empty-string query + --limit flag", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("throws usage when query is empty string", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runPeople(["search", ""])).rejects.toThrow(/Usage: nimbus people search/);
  });

  it("honours --limit flag in search", async () => {
    const mock = createMockIpcClient([[fakePerson()]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["search", "bob", "--limit", "5"]);
    expect(mock.calls[0]).toEqual({
      method: "people.search",
      params: { query: "bob", limit: 5 },
    });
  });

  it("ignores trailing --limit with no value in search (uses default)", async () => {
    const mock = createMockIpcClient([[fakePerson()]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["search", "bob", "--limit"]);
    expect(mock.calls[0]).toEqual({
      method: "people.search",
      params: { query: "bob", limit: 25 },
    });
  });
});

describe("runPeople — get: empty-string id", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("throws usage when id is empty string", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runPeople(["get", ""])).rejects.toThrow(/Usage: nimbus people get/);
  });
});

describe("runPeople — items: empty-string id + --limit flag", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("throws usage when id is empty string", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runPeople(["items", ""])).rejects.toThrow(/Usage: nimbus people items/);
  });

  it("honours --limit flag in items", async () => {
    const mock = createMockIpcClient([[{ id: "github:pr_1", service: "github", name: "Fix bug" }]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["items", "p1", "--limit", "10"]);
    expect(mock.calls[0]).toEqual({
      method: "people.items",
      params: { personId: "p1", limit: 10 },
    });
  });

  it("ignores trailing --limit with no value in items (uses default)", async () => {
    const mock = createMockIpcClient([[{ id: "github:pr_1", service: "github", name: "Fix bug" }]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["items", "p1", "--limit"]);
    expect(mock.calls[0]).toEqual({
      method: "people.items",
      params: { personId: "p1", limit: 50 },
    });
  });
});

describe("runPeople — list: trailing --limit with no value", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("ignores trailing --limit with no value in list (uses default 100)", async () => {
    const mock = createMockIpcClient([[fakePerson()]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list", "--limit"]);
    expect(mock.calls[0]).toEqual({
      method: "people.list",
      params: { unlinkedOnly: false, limit: 100 },
    });
  });
});

describe("runPeople — list --not-reviewed", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("sends notReviewed + sinceMs derived via the EXISTING parseSinceDurationToMs", async () => {
    const mock = createMockIpcClient([
      {
        people: [fakePerson()],
        meta: { limit: 100, total: 1 },
        gaps: { excludedNoGraphEntity: 0 },
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    const before = Date.now();
    await runPeople(["list", "--not-reviewed", "--since", "7d"]);
    const params = mock.calls[0]?.params as Record<string, unknown>;
    expect(params["notReviewed"]).toBe(true);
    const sinceMs = params["sinceMs"] as number;
    // 7d = 7 * 24 * 60 * 60 * 1000ms before "now" — same arithmetic query.ts already uses,
    // via the same parse-since.ts function, so the two commands cannot disagree about "7d".
    const expected = before - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(sinceMs - expected)).toBeLessThan(5000);
  });

  it("omits sinceMs when --since is not given (all-time window)", async () => {
    const mock = createMockIpcClient([
      { people: [], meta: { limit: 100, total: 0 }, gaps: { excludedNoGraphEntity: 0 } },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list", "--not-reviewed"]);
    expect(mock.calls[0]).toEqual({
      method: "people.list",
      params: { unlinkedOnly: false, limit: 100, notReviewed: true },
    });
  });

  it("--since with no duration is rejected, never silently widened to the all-time window", async () => {
    // The test above proves that OMITTING --since means all-time, deliberately and visibly. A
    // --since that lost its value must not land in that same place: the caller asked for a
    // window, and answering the wider question with no signal is the substitution this feature
    // exists to prevent. No fixture is set — the rejection must precede any IPC call, so a
    // "Gateway is not running" error here would mean the guard ran too late.
    await expect(runPeople(["list", "--not-reviewed", "--since"])).rejects.toThrow(
      /--since requires a duration/,
    );
  });

  it("makes the ALL-TIME window visible when --since is not given", async () => {
    const mock = createMockIpcClient([
      { people: [], meta: { limit: 100, total: 0 }, gaps: { excludedNoGraphEntity: 0 } },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list", "--not-reviewed"]);
    expect(out.stdout).toMatch(/ALL TIME/);
  });

  it("makes the --since window visible (never lets an all-time answer read as recent)", async () => {
    const mock = createMockIpcClient([
      { people: [], meta: { limit: 100, total: 0 }, gaps: { excludedNoGraphEntity: 0 } },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list", "--not-reviewed", "--since", "7d"]);
    expect(out.stdout).toContain("7d");
    expect(out.stdout).not.toMatch(/ALL TIME/);
  });

  it("prints the excludedNoGraphEntity gap labelled 'no graph entity of the required type'", async () => {
    const mock = createMockIpcClient([
      {
        people: [],
        meta: { limit: 100, total: 0 },
        gaps: { excludedNoGraphEntity: 6 },
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list", "--not-reviewed"]);
    expect(out.stdout).toContain("6");
    expect(out.stdout).toContain("no graph entity of the required type");
    expect(out.stdout).not.toContain("not graphed");
  });

  it("a refusal exits 1 and prints message + remediation to stderr, widening --since named in remediation", async () => {
    const refusal = {
      status: "refused",
      reason: "missing_substrate",
      message:
        "no `reviewed` edges are indexed within the --since window, so who has not reviewed anything in that window cannot be verified",
      remediation:
        "widen the time window (`--since` on the CLI, `sinceDays` on the tool surfaces) to include older reviews, or sync a connector that populates PR review activity and run nimbus index regraph",
    };
    const mock = createMockIpcClient([refusal]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list", "--not-reviewed", "--since", "1h"]);
    expect(process.exitCode).toBe(1);
    expect(out.stderr).toMatch(/missing_substrate|no .* indexed/i);
    expect(out.stderr).toContain("widen the time window");
    // The CLI's own advice must not be LOST while making the remediation surface-neutral.
    expect(out.stderr).toContain("--since");
    expect(out.stdout).not.toContain(refusal.message);
  });

  it("--json refusal is a SINGLE parseable document on stdout", async () => {
    const refusal = {
      status: "refused",
      reason: "missing_substrate",
      message: "no `reviewed` edges are indexed within the --since window",
      remediation: "widen --since to include older reviews",
    };
    const mock = createMockIpcClient([refusal]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list", "--not-reviewed", "--json"]);
    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(parsed["status"]).toBe("refused");
    expect(out.stderr).toBe("");
  });

  it("--json wraps people+gaps+window in ONE parseable document", async () => {
    const mock = createMockIpcClient([
      {
        people: [fakePerson()],
        meta: { limit: 100, total: 1 },
        gaps: { excludedNoGraphEntity: 2 },
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list", "--not-reviewed", "--since", "7d", "--json"]);
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(Array.isArray(parsed["people"])).toBe(true);
    expect(parsed["gaps"]).toEqual({ excludedNoGraphEntity: 2 });
    expect(parsed["window"]).toMatchObject({ allTime: false });
  });

  it("a plain (non-negation) --json call prints the bare array, not a wrapped document", async () => {
    const mock = createMockIpcClient([[fakePerson()]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runPeople(["list", "--json"]);
    const parsed: unknown = JSON.parse(out.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });
});
