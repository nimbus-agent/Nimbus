import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
// TEST-ONLY cross-package import: `.dependency-cruiser.cjs`'s `audit:boundaries`
// (`cli-no-import-gateway`) excludes every `*.test.ts` file from the boundary check, so this
// import is not reachable from `query.ts`'s own production dependency graph — only from here.
// This is what makes `CORRELATION_WINDOW_MS_CLI_MIRROR` (`query.ts`) a PINNED mirror rather
// than a plain restated literal: see "the correlation window is pinned to the real gateway
// constant" below.
import { CORRELATION_WINDOW_MS } from "../../../gateway/src/index/negation-predicates.ts";
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const queryMod = await import("./query.ts");
const { runQuery, CORRELATION_WINDOW_MS_CLI_MIRROR } = queryMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

/** Helper: set up fixture with a mock IPC client and return calls array. */
function setupMock(responseQueue: ReadonlyArray<unknown>): ReturnType<typeof createMockIpcClient> {
  const mock = createMockIpcClient(responseQueue);
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: mock.client,
  });
  return mock;
}

describe("runQuery — help & validation", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints usage when called with no args", async () => {
    await runQuery([]);
    expect(out.stdout).toContain("nimbus query");
    expect(out.stdout).toContain("--service");
    expect(out.stdout).toContain("--sql");
  });

  it("prints usage for 'help' / '--help' / '-h'", async () => {
    await runQuery(["help"]);
    expect(out.stdout).toContain("nimbus query");
    out.reset();
    await runQuery(["--help"]);
    expect(out.stdout).toContain("nimbus query");
    out.reset();
    await runQuery(["-h"]);
    expect(out.stdout).toContain("nimbus query");
  });

  it("throws when neither --service nor --sql is provided", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runQuery(["--type", "pr"])).rejects.toThrow(/Missing --service/);
  });

  it("throws when gateway is not running for an --sql path", async () => {
    setFixture({});
    await expect(runQuery(["--sql", "SELECT 1"])).rejects.toThrow(
      /Gateway is not running\. Start with: nimbus start/,
    );
  });

  it("throws when gateway is not running for a --service path", async () => {
    setFixture({});
    await expect(runQuery(["--service", "github"])).rejects.toThrow(
      /Gateway is not running\. Start with: nimbus start/,
    );
  });
});

describe("runQuery — --sql path", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls index.querySql with the supplied sql and prints JSON when --json", async () => {
    const mock = createMockIpcClient([{ rows: [{ id: 1, title: "hi" }], meta: { count: 1 } }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runQuery(["--sql", "SELECT * FROM items", "--json"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "index.querySql",
      params: { sql: "SELECT * FROM items" },
    });
    expect(out.stdout).toContain('"id": 1');
    expect(out.stdout).toContain('"title": "hi"');
  });
});

describe("runQuery — --service path", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls index.queryItems with services + clamped limit; renders --json", async () => {
    const mock = createMockIpcClient([
      {
        items: [
          {
            id: "pr-1",
            indexPrimaryKey: "github:pr-1",
            service: "github",
            itemType: "pr",
            name: "foo",
            modifiedAt: 1700000000000,
          },
        ],
        meta: { limit: 50, total: 1 },
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runQuery(["--service", "github", "--limit", "5000", "--json"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "index.queryItems",
      params: { services: ["github"], limit: 1000 }, // clamped from 5000 → 1000
    });
    expect(out.stdout).toContain('"name": "foo"');
  });

  it("includes types + sinceMs when --type and --since are present", async () => {
    const mock = createMockIpcClient([{ items: [], meta: { limit: 50, total: 0 } }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runQuery(["--service", "slack", "--type", "message", "--since", "1d", "--json"]);
    expect(mock.calls).toHaveLength(1);
    const p = mock.calls[0]?.params as Record<string, unknown>;
    expect(p["services"]).toEqual(["slack"]);
    expect(p["types"]).toEqual(["message"]);
    expect(typeof p["sinceMs"]).toBe("number");
    expect(p["limit"]).toBe(50);
  });

  it("default-limits to 50 when --limit is missing or invalid", async () => {
    const mock = createMockIpcClient([{ items: [], meta: { limit: 50, total: 0 } }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runQuery(["--service", "github", "--limit", "garbage", "--json"]);
    expect(mock.calls[0]?.params).toMatchObject({ limit: 50 });
  });

  it("prints '(no rows)' when no items returned and pretty is set", async () => {
    const mock = createMockIpcClient([{ items: [], meta: { limit: 50, total: 0 } }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runQuery(["--service", "github", "--pretty"]);
    expect(out.stdout).toContain("(no rows)");
  });

  it("renders item cards in --pretty mode", async () => {
    const mock = createMockIpcClient([
      {
        items: [
          {
            id: "pr-1",
            indexPrimaryKey: "github:pr-1",
            service: "github",
            itemType: "pr",
            name: "My PR",
            modifiedAt: 1700000000000,
            url: "https://example.test/pr/1",
          },
        ],
        meta: { limit: 50, total: 1 },
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runQuery(["--service", "github", "--pretty"]);
    expect(out.stdout).toContain("My PR");
    expect(out.stdout).toContain("github");
    expect(out.stdout).toContain("https://example.test/pr/1");
    expect(out.stdout).toMatch(/1 row/);
  });

  it("renders kv blocks in --pretty mode when rows are not item-like", async () => {
    const mock = createMockIpcClient([
      { rows: [{ id: 1, label: "x", created_at: 1700000000000 }], meta: { count: 1 } },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runQuery(["--sql", "SELECT id, label, created_at FROM other", "--pretty"]);
    expect(out.stdout).toContain("#1");
    expect(out.stdout).toContain("id:");
    expect(out.stdout).toContain("label:");
  });
});

describe("runQuery — output formatting branches", () => {
  let origIsTTY: PropertyDescriptor | undefined;
  beforeEach(() => {
    out.reset();
    // Force a deterministic non-TTY stdout so the compact-JSON branch is exercised
    // regardless of the runner or global isTTY pollution from other test files in the
    // combined `bun test packages/cli/src` run (the --pretty tests force cards via the flag).
    origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      writable: true,
      value: false,
    });
  });
  afterEach(() => {
    clearFixture();
    if (origIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    } else {
      // No own descriptor existed, so restore that ABSENCE rather than defining
      // an own `undefined` property — the latter leaves process.stdout with a
      // property it never had, which shadows the prototype and can leak into
      // any later test sharing this process.
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });

  // compact JSON path: no --json, no --pretty, process.stdout.isTTY is falsy in tests
  it("emits compact JSON for --sql when neither --json nor --pretty is given (non-TTY)", async () => {
    const mock = setupMock([{ rows: [{ id: 42 }], meta: { count: 1 } }]);
    await runQuery(["--sql", "SELECT id FROM t"]);
    expect(mock.calls[0]?.method).toBe("index.querySql");
    // compact JSON: no indentation
    expect(out.stdout).toContain('[{"id":42}]');
  });

  it("emits compact JSON for --service when neither --json nor --pretty is given (non-TTY)", async () => {
    const mock = setupMock([{ items: [{ id: 7 }], meta: { limit: 50, total: 1 } }]);
    await runQuery(["--service", "github"]);
    expect(mock.calls[0]?.method).toBe("index.queryItems");
    expect(out.stdout).toContain('[{"id":7}]');
  });

  // singular vs plural row count
  it("shows '1 row' (singular) for exactly one result in --pretty mode", async () => {
    setupMock([{ items: [{ name: "A", service: "svc" }], meta: { limit: 50, total: 1 } }]);
    await runQuery(["--service", "svc", "--pretty"]);
    expect(out.stdout).toMatch(/\(1 row ·/);
  });

  it("shows 'N rows' (plural) for multiple results in --pretty mode", async () => {
    setupMock([
      {
        items: [
          { name: "A", service: "svc" },
          { name: "B", service: "svc" },
        ],
        meta: { limit: 50, total: 2 },
      },
    ]);
    await runQuery(["--service", "svc", "--pretty"]);
    expect(out.stdout).toMatch(/\(2 rows ·/);
  });

  // --limit 0 → defaults to 50
  it("defaults limit to 50 when --limit is 0", async () => {
    const mock = setupMock([{ items: [], meta: { limit: 50, total: 0 } }]);
    await runQuery(["--service", "github", "--limit", "0", "--json"]);
    expect(mock.calls[0]?.params).toMatchObject({ limit: 50 });
  });

  // --limit negative → defaults to 50
  it("defaults limit to 50 when --limit is negative", async () => {
    const mock = setupMock([{ items: [], meta: { limit: 50, total: 0 } }]);
    await runQuery(["--service", "github", "--limit", "-5", "--json"]);
    expect(mock.calls[0]?.params).toMatchObject({ limit: 50 });
  });

  // --service "" (empty string) → throws
  it("throws when --service is provided but its value is an empty string", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runQuery(["--service", ""])).rejects.toThrow(/Missing --service/);
  });

  // takeFlag: flag present but is the LAST argument (no value after it) → returns undefined → service=undefined → throws
  it("throws when --service flag appears last with no value (takeFlag i+1>=args.length)", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    // --service with no following arg → takeFlag returns undefined → Missing --service
    await expect(runQuery(["--service"])).rejects.toThrow(/Missing --service/);
  });

  // --type "" (empty string) → type param omitted from IPC call
  it("omits types param when --type value is an empty string", async () => {
    const mock = setupMock([{ items: [], meta: { limit: 50, total: 0 } }]);
    await runQuery(["--service", "github", "--type", "", "--json"]);
    const p = mock.calls[0]?.params as Record<string, unknown>;
    expect(p["types"]).toBeUndefined();
  });
});

describe("runQuery — TTY card regression for the new index.queryItems shape", () => {
  let origIsTTY: PropertyDescriptor | undefined;
  beforeEach(() => {
    out.reset();
    // Force a deterministic TTY stdout so the default (non-flagged) card-rendering
    // branch is exercised: this is the regression path for the bug where the new
    // camelCase queryItems shape (name/itemType/modifiedAt) fell through to
    // key/value blocks instead of numbered cards because isItemLikeRow only
    // recognized the old `title` field.
    origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      writable: true,
      value: true,
    });
  });
  afterEach(() => {
    clearFixture();
    if (origIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    } else {
      // No own descriptor existed, so restore that ABSENCE rather than defining
      // an own `undefined` property — the latter leaves process.stdout with a
      // property it never had, which shadows the prototype and can leak into
      // any later test sharing this process.
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });

  it("renders a numbered card (not a key/value block) with a relative timestamp for a camelCase queryItems row", async () => {
    const ms = Date.now() - 5 * 60 * 1000; // 5 min ago
    setupMock([
      {
        items: [
          {
            id: "pr-42",
            indexPrimaryKey: "github:pr-42",
            service: "github",
            itemType: "pr",
            name: "Fix the thing",
            modifiedAt: ms,
          },
        ],
        meta: { limit: 50, total: 1 },
      },
    ]);
    await runQuery(["--service", "github"]);
    // Card path: a numbered line with the item name, not a "── #1 ──" kv block.
    expect(out.stdout).toMatch(/^1\.\s+Fix the thing/m);
    expect(out.stdout).not.toContain("── #1 ──");
    // The timestamp must render relative ("...m ago"), not a bare epoch integer.
    expect(out.stdout).toMatch(/\d+m ago/);
    expect(out.stdout).not.toContain(String(ms));
  });
});

describe("runQuery — formatQueryCell branches via kv blocks", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  // Exercise boolean, object, null/undefined, number, string in kv-block cells.
  // All these go through formatQueryCell (via printKvBlock for non-_at fields).
  it("renders boolean values as 'true'/'false' strings", async () => {
    setupMock([
      {
        rows: [{ flag_active: true, flag_deleted: false }],
        meta: { count: 1 },
      },
    ]);
    await runQuery(["--sql", "SELECT flag_active, flag_deleted FROM t", "--pretty"]);
    expect(out.stdout).toContain("flag_active: true");
    expect(out.stdout).toContain("flag_deleted: false");
  });

  it("renders object values as JSON in kv block", async () => {
    setupMock([
      {
        rows: [{ meta: { key: "val" } }],
        meta: { count: 1 },
      },
    ]);
    await runQuery(["--sql", "SELECT meta FROM t", "--pretty"]);
    expect(out.stdout).toContain('{"key":"val"}');
  });

  it("renders null cell values as empty string in kv block", async () => {
    setupMock([
      {
        rows: [{ field_a: null, field_b: undefined }],
        meta: { count: 1 },
      },
    ]);
    await runQuery(["--sql", "SELECT field_a, field_b FROM t", "--pretty"]);
    // null/undefined → empty string → "field_a: "
    expect(out.stdout).toContain("field_a:");
  });

  // formatTimestampField with non-finite number falls back to formatQueryCell
  it("renders non-finite _at field via formatQueryCell fallback", async () => {
    setupMock([
      {
        rows: [{ created_at: Number.NaN }],
        meta: { count: 1 },
      },
    ]);
    await runQuery(["--sql", "SELECT created_at FROM t", "--pretty"]);
    // NaN → formatQueryCell → String(NaN) = "NaN"
    expect(out.stdout).toContain("created_at: NaN");
  });

  // _at field with a valid finite timestamp hits the ISO+relative branch
  it("renders finite _at field as ISO local + relative", async () => {
    const nowMs = Date.now();
    setupMock([
      {
        rows: [{ updated_at: nowMs }],
        meta: { count: 1 },
      },
    ]);
    await runQuery(["--sql", "SELECT updated_at FROM t", "--pretty"]);
    // Should contain the ISO-like prefix (YYYY-MM-DD HH:MM) and "ago"
    expect(out.stdout).toMatch(/updated_at:.*\d{4}-\d{2}-\d{2}/);
    expect(out.stdout).toContain("ago");
  });
});

describe("runQuery — formatRelative time branches", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  // Each test drives a different formatRelative branch via modifiedAt on an item card.
  // We use --pretty so printItemCard is called with formatTimestampField on modifiedAt.

  it("formatRelative: seconds ago (< 60s)", async () => {
    const ms = Date.now() - 30 * 1000; // 30s ago
    setupMock([
      { items: [{ name: "T", service: "svc", modifiedAt: ms }], meta: { limit: 50, total: 1 } },
    ]);
    await runQuery(["--service", "svc", "--pretty"]);
    expect(out.stdout).toMatch(/\d+s ago/);
  });

  it("formatRelative: minutes ago (< 60 min)", async () => {
    const ms = Date.now() - 5 * 60 * 1000; // 5 min ago
    setupMock([
      { items: [{ name: "T", service: "svc", modifiedAt: ms }], meta: { limit: 50, total: 1 } },
    ]);
    await runQuery(["--service", "svc", "--pretty"]);
    expect(out.stdout).toMatch(/\d+m ago/);
  });

  it("formatRelative: hours ago (< 24h)", async () => {
    const ms = Date.now() - 3 * 60 * 60 * 1000; // 3h ago
    setupMock([
      { items: [{ name: "T", service: "svc", modifiedAt: ms }], meta: { limit: 50, total: 1 } },
    ]);
    await runQuery(["--service", "svc", "--pretty"]);
    expect(out.stdout).toMatch(/\d+h ago/);
  });

  it("formatRelative: days ago (< 30d)", async () => {
    const ms = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10d ago
    setupMock([
      { items: [{ name: "T", service: "svc", modifiedAt: ms }], meta: { limit: 50, total: 1 } },
    ]);
    await runQuery(["--service", "svc", "--pretty"]);
    expect(out.stdout).toMatch(/\d+d ago/);
  });

  it("formatRelative: months ago (< 12 months)", async () => {
    const ms = Date.now() - 60 * 24 * 60 * 60 * 1000; // ~2 months ago
    setupMock([
      { items: [{ name: "T", service: "svc", modifiedAt: ms }], meta: { limit: 50, total: 1 } },
    ]);
    await runQuery(["--service", "svc", "--pretty"]);
    expect(out.stdout).toMatch(/\d+mo ago/);
  });

  it("formatRelative: years ago (>= 12 months)", async () => {
    const ms = Date.now() - 400 * 24 * 60 * 60 * 1000; // ~13 months ago
    setupMock([
      { items: [{ name: "T", service: "svc", modifiedAt: ms }], meta: { limit: 50, total: 1 } },
    ]);
    await runQuery(["--service", "svc", "--pretty"]);
    expect(out.stdout).toMatch(/\d+y ago/);
  });
});

describe("runQuery — printItemCard field-presence branches", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  // Card with no itemType, no modifiedAt → meta only has service
  it("renders card without itemType or modifiedAt (meta = service only)", async () => {
    setupMock([
      {
        items: [{ name: "Bare item", service: "notion" }],
        meta: { limit: 50, total: 1 },
      },
    ]);
    await runQuery(["--service", "notion", "--pretty"]);
    expect(out.stdout).toContain("Bare item");
    expect(out.stdout).toContain("notion");
  });

  // body_preview is a raw-row-only field (dropped from the queryItems wire shape),
  // so these exercise the card path via index.querySql instead.
  // body_preview present but equals title → body line suppressed
  it("suppresses body_preview when it equals the title (raw querySql row)", async () => {
    setupMock([
      {
        rows: [{ title: "same", service: "svc", body_preview: "same" }],
        meta: { count: 1 },
      },
    ]);
    await runQuery(["--sql", "SELECT title, service, body_preview FROM items", "--pretty"]);
    expect(out.stdout).toContain("same");
    // body_preview === title → the body line is suppressed, so "same" renders exactly
    // once (the title line). If it were NOT suppressed it would appear twice.
    const occurrences = out.stdout.split("same").length - 1;
    expect(occurrences).toBe(1);
  });

  // body_preview longer than 120 chars → gets truncated (covers truncate() long-string branch)
  it("truncates long body_preview to 120 chars with ellipsis (raw querySql row)", async () => {
    const longBody = "A".repeat(200);
    setupMock([
      {
        rows: [{ title: "card", service: "svc", body_preview: longBody }],
        meta: { count: 1 },
      },
    ]);
    await runQuery(["--sql", "SELECT title, service, body_preview FROM items", "--pretty"]);
    // Truncated to 119 chars + ellipsis char (≤ 121 display chars total)
    expect(out.stdout).toContain("…");
    // Should not contain the full 200-char string
    expect(out.stdout).not.toContain("A".repeat(200));
  });

  // url absent → no url line printed
  it("renders card without url when url field is absent", async () => {
    setupMock([
      {
        items: [{ name: "No URL", service: "svc" }],
        meta: { limit: 50, total: 1 },
      },
    ]);
    await runQuery(["--service", "svc", "--pretty"]);
    expect(out.stdout).not.toContain("http");
  });

  // body_preview present but empty string → body line suppressed
  it("suppresses body_preview when it is an empty string (raw querySql row)", async () => {
    setupMock([
      {
        rows: [{ title: "Has empty body", service: "svc", body_preview: "" }],
        meta: { count: 1 },
      },
    ]);
    await runQuery(["--sql", "SELECT title, service, body_preview FROM items", "--pretty"]);
    expect(out.stdout).toContain("Has empty body");
  });
});

describe("runQuery — negation flags: scoping validation", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("--not-touching without --type pr is rejected", async () => {
    await expect(runQuery(["--service", "github", "--not-touching", "tests/*"])).rejects.toThrow(
      /--not-touching requires --type pr/,
    );
  });

  it("--not-touching with a conflicting --type is rejected", async () => {
    await expect(
      runQuery(["--service", "github", "--type", "commit", "--not-touching", "tests/*"]),
    ).rejects.toThrow(/--not-touching requires --type pr/);
  });

  it("--no-downstream-incident without --type deployment is rejected", async () => {
    await expect(runQuery(["--service", "github", "--no-downstream-incident"])).rejects.toThrow(
      /--no-downstream-incident requires --type deployment/,
    );
  });

  it("--no-downstream-incident with a conflicting --type is rejected", async () => {
    await expect(
      runQuery(["--service", "github", "--type", "pr", "--no-downstream-incident"]),
    ).rejects.toThrow(/--no-downstream-incident requires --type deployment/);
  });

  it("rejects BEFORE any IPC call: no gateway state is required to observe the rejection", async () => {
    // No fixture set at all — if scoping were validated after the IPC call this would throw
    // "Gateway is not running" instead of the scoping message.
    await expect(runQuery(["--service", "github", "--not-touching", "tests/*"])).rejects.toThrow(
      /--not-touching requires --type pr/,
    );
  });

  it("a correctly-scoped --not-touching call passes validation and reaches the IPC layer", async () => {
    const mock = setupMock([
      {
        items: [],
        meta: { limit: 50, total: 0 },
        gaps: { excludedNoCoverage: 0, excludedTruncated: 0 },
      },
    ]);
    await runQuery(["--service", "github", "--type", "pr", "--not-touching", "tests/*"]);
    expect(mock.calls[0]).toEqual({
      method: "index.queryItems",
      params: {
        services: ["github"],
        types: ["pr"],
        limit: 50,
        notTouching: "tests/*",
      },
    });
  });
});

describe("runQuery — refusal contract", () => {
  const refusal = {
    status: "refused",
    reason: "missing_substrate",
    message:
      "no PR file-coverage data is indexed, so which PRs do not touch a path cannot be verified",
    remediation:
      "sync a connector that populates PR changed-file coverage (GitHub/GitLab), then retry",
  };

  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("a refusal exits 1 and prints the message + remediation to stderr", async () => {
    setupMock([refusal]);
    await runQuery(["--service", "github", "--type", "pr", "--not-touching", "tests/*"]);
    expect(process.exitCode).toBe(1);
    expect(out.stderr).toMatch(/missing_substrate|no .* indexed/i);
    expect(out.stderr).toContain(refusal.remediation);
    // Never on stdout in human mode — that would make a refusal indistinguishable from a
    // successful zero-row answer to anything reading stdout alone.
    expect(out.stdout).not.toContain(refusal.message);
  });

  it("--json refusal is a SINGLE parseable document on stdout, never mixed with text", async () => {
    setupMock([refusal]);
    await runQuery(["--service", "github", "--type", "pr", "--not-touching", "tests/*", "--json"]);
    expect(process.exitCode).toBe(1);
    // Must PARSE, not merely string-match — printing the refusal alongside other text on
    // stdout would break this even if every substring were individually present.
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(parsed["status"]).toBe("refused");
    expect(parsed["reason"]).toBe("missing_substrate");
    expect(parsed["remediation"]).toBe(refusal.remediation);
    // Nothing on stderr under --json — the document IS the answer the caller asked for.
    expect(out.stderr).toBe("");
  });
});

describe("runQuery — negation success output", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("--not-touching reports the two exclusion counts SEPARATELY, never summed", async () => {
    setupMock([
      {
        items: [{ id: "pr-1", service: "github", name: "Fix" }],
        meta: { limit: 50, total: 1 },
        gaps: { excludedNoCoverage: 3, excludedTruncated: 5 },
      },
    ]);
    await runQuery(["--service", "github", "--type", "pr", "--not-touching", "tests/*"]);
    // Both counts visible individually.
    expect(out.stdout).toContain("3");
    expect(out.stdout).toContain("5");
    // Never collapsed into one combined figure (8) presented as a single count.
    expect(out.stdout).not.toMatch(/\b8\b/);
  });

  it("--no-downstream-incident reports excludedNoGraphEntity labelled 'no graph entity of the required type'", async () => {
    setupMock([
      {
        items: [],
        meta: { limit: 50, total: 0 },
        gaps: { excludedNoGraphEntity: 4 },
      },
    ]);
    await runQuery(["--service", "github", "--type", "deployment", "--no-downstream-incident"]);
    expect(out.stdout).toContain("no graph entity of the required type");
    expect(out.stdout).not.toContain("not graphed");
  });

  it("prints the correlation window derived from the pinned constant, never a literal '2h' comment-only claim", async () => {
    setupMock([
      {
        items: [],
        meta: { limit: 50, total: 0 },
        gaps: { excludedNoGraphEntity: 0 },
      },
    ]);
    await runQuery(["--service", "github", "--type", "deployment", "--no-downstream-incident"]);
    expect(out.stdout).toContain("Correlation window:");
    // CORRELATION_WINDOW_MS is 2 hours today; asserted via the formatted duration of the
    // ACTUAL constant, not a hardcoded "2h" string, so this test does not itself restate the
    // literal it is trying to prove isn't restated in production code.
    const hours = CORRELATION_WINDOW_MS / (60 * 60 * 1000);
    expect(out.stdout).toContain(`${String(hours)}h`);
  });

  it("the CLI's mirror constant is pinned to the real gateway CORRELATION_WINDOW_MS", () => {
    expect(CORRELATION_WINDOW_MS_CLI_MIRROR).toBe(CORRELATION_WINDOW_MS);
  });

  it("--json wraps items+meta+gaps+correlationWindowMs in ONE parseable document", async () => {
    setupMock([
      {
        items: [{ id: "d-1", service: "github", name: "Deploy 1" }],
        meta: { limit: 50, total: 1 },
        gaps: { excludedNoGraphEntity: 2 },
      },
    ]);
    await runQuery([
      "--service",
      "github",
      "--type",
      "deployment",
      "--no-downstream-incident",
      "--json",
    ]);
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(Array.isArray(parsed["items"])).toBe(true);
    expect(parsed["gaps"]).toEqual({ excludedNoGraphEntity: 2 });
    expect(parsed["correlationWindowMs"]).toBe(CORRELATION_WINDOW_MS_CLI_MIRROR);
  });

  it("--explain prints the explain block in human mode", async () => {
    setupMock([
      {
        items: [],
        meta: { limit: 50, total: 0 },
        gaps: { excludedNoCoverage: 0, excludedTruncated: 0 },
        explain: {
          sql: "SELECT i.id FROM item i WHERE ...",
          params: ["tests/*"],
          substrate: {
            probeSql: "SELECT COUNT(*) AS n FROM pr_files_state",
            passed: true,
            rowCount: 10,
          },
        },
      },
    ]);
    await runQuery([
      "--service",
      "github",
      "--type",
      "pr",
      "--not-touching",
      "tests/*",
      "--explain",
    ]);
    expect(out.stdout).toContain("explain");
    expect(out.stdout).toContain("SELECT i.id FROM item i WHERE ...");
    expect(out.stdout).toContain("passed=true");
  });

  it("--explain --json puts explain as a field in the parseable document", async () => {
    setupMock([
      {
        items: [],
        meta: { limit: 50, total: 0 },
        gaps: { excludedNoCoverage: 0, excludedTruncated: 0 },
        explain: {
          sql: "SELECT i.id FROM item i WHERE ...",
          params: ["tests/*"],
          substrate: {
            probeSql: "SELECT COUNT(*) AS n FROM pr_files_state",
            passed: true,
            rowCount: 10,
          },
        },
      },
    ]);
    await runQuery([
      "--service",
      "github",
      "--type",
      "pr",
      "--not-touching",
      "tests/*",
      "--explain",
      "--json",
    ]);
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    const explain = parsed["explain"] as Record<string, unknown>;
    expect(explain["sql"]).toBe("SELECT i.id FROM item i WHERE ...");
  });
});
