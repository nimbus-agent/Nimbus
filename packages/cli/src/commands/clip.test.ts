import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

import {
  CLIP_USAGE,
  formatBriefsLine,
  formatClipList,
  formatStatus,
  parseLimit,
  parseScopesFlag,
  runClip,
  runClipDelete,
  runClipList,
  runClipPair,
  runClipRevoke,
  runClipScopes,
  runClipStatus,
} from "./clip.ts";

const out = captureOutput();

afterAll(() => {
  out.restore();
});

// ---------------------------------------------------------------------------
// Pure helpers (no IPC needed)
// ---------------------------------------------------------------------------

describe("clip CLI formatting", () => {
  test("formatStatus lists labels + fingerprints", () => {
    const result = formatStatus([{ label: "chrome", fingerprint: "abcd1234", scopes: ["clip"] }]);
    expect(result).toContain("chrome");
    expect(result).toContain("abcd1234");
  });

  test("formatStatus reports empty state", () => {
    expect(formatStatus([])).toMatch(/no clipper tokens/i);
  });

  test("usage mentions pair, status, revoke", () => {
    expect(CLIP_USAGE).toMatch(/pair/);
    expect(CLIP_USAGE).toMatch(/status/);
    expect(CLIP_USAGE).toMatch(/revoke/);
  });

  test("formatStatus formats multiple devices", () => {
    const result = formatStatus([
      { label: "chrome", fingerprint: "abcd1234", scopes: ["clip", "briefs"] },
      { label: "firefox", fingerprint: "ef567890", scopes: ["clip"] },
    ]);
    expect(result).toContain("chrome");
    expect(result).toContain("abcd1234");
    expect(result).toContain("firefox");
    expect(result).toContain("ef567890");
  });

  test("formatStatus shows each device's scopes", () => {
    const out = formatStatus([
      { label: "chrome", fingerprint: "abcd1234", scopes: ["clip", "briefs"] },
    ]);
    expect(out).toContain("chrome");
    expect(out).toContain("clip,briefs");
  });

  test("formatBriefsLine reports enabled", () => {
    expect(formatBriefsLine(true)).toBe("briefs: enabled");
  });

  test("formatBriefsLine reports disabled with the how-to-enable hint", () => {
    expect(formatBriefsLine(false)).toBe("briefs: disabled (enable [briefs] in nimbus.toml)");
  });
});

describe("parseScopesFlag", () => {
  test("splits a comma list and trims", () => {
    expect(parseScopesFlag("clip, agents")).toEqual(["clip", "agents"]);
    expect(parseScopesFlag(undefined)).toBeUndefined();
  });

  test("does NOT validate names — the gateway is the only validator", () => {
    // A second copy of the scope vocabulary in the CLI would drift from the gateway's.
    expect(parseScopesFlag("telepathy")).toEqual(["telepathy"]);
  });

  test("an explicitly empty --scopes yields [] so the gateway can refuse it", () => {
    // NOT undefined: passing the flag is a statement, and "unspecified" is a different thing.
    expect(parseScopesFlag("")).toEqual([]);
    expect(parseScopesFlag("  ,  ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runClipPair
// ---------------------------------------------------------------------------

describe("runClipPair", () => {
  beforeEach(() => {
    out.reset();
  });

  it("calls clip.pair without label and prints pairing code", async () => {
    const { client, calls } = createMockIpcClient([
      { code: "ABC123", expiresAtMs: Date.now() + 120_000, label: "My Browser" },
    ]);
    await runClipPair(client, undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "clip.pair", params: {} });
    expect(out.stdout).toContain("ABC123");
    expect(out.stdout).toContain("My Browser");
  });

  it("calls clip.pair with label when provided", async () => {
    const { client, calls } = createMockIpcClient([
      { code: "XYZ789", expiresAtMs: Date.now() + 120_000, label: "work-chrome" },
    ]);
    await runClipPair(client, "work-chrome");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "clip.pair", params: { label: "work-chrome" } });
    expect(out.stdout).toContain("XYZ789");
    expect(out.stdout).toContain("work-chrome");
  });

  it("prints the 2-minute instruction", async () => {
    const { client } = createMockIpcClient([
      { code: "ABC123", expiresAtMs: Date.now() + 120_000, label: "browser" },
    ]);
    await runClipPair(client, undefined);
    expect(out.stdout).toContain("2 minutes");
  });

  it("prints the gateway URL when the response includes it", async () => {
    const { client } = createMockIpcClient([
      {
        code: "ABC123",
        expiresAtMs: Date.now() + 120_000,
        label: "chrome",
        gatewayUrl: "http://127.0.0.1:7474",
      },
    ]);
    await runClipPair(client, undefined);
    expect(out.stdout).toContain("http://127.0.0.1:7474");
    expect(out.stdout).toContain("ABC123");
    expect(out.stdout).not.toMatch(/no HTTP port/i);
  });

  it("warns to start the HTTP surface when no gateway URL is returned", async () => {
    const { client } = createMockIpcClient([
      { code: "ABC123", expiresAtMs: Date.now() + 120_000, label: "chrome" },
    ]);
    await runClipPair(client, undefined);
    expect(out.stdout).toMatch(/no HTTP port/i);
    expect(out.stdout).toContain("nimbus serve --port");
  });

  it("sends scopes when provided", async () => {
    const { client, calls } = createMockIpcClient([
      {
        code: "ABC123",
        expiresAtMs: Date.now() + 120_000,
        label: "chrome",
        scopes: ["clip", "agents"],
      },
    ]);
    await runClipPair(client, "chrome", ["clip", "agents"]);
    expect(calls[0]).toEqual({
      method: "clip.pair",
      params: { label: "chrome", scopes: ["clip", "agents"] },
    });
  });

  it("omits scopes from params when not provided", async () => {
    const { client, calls } = createMockIpcClient([
      { code: "ABC123", expiresAtMs: Date.now() + 120_000, label: "chrome" },
    ]);
    await runClipPair(client, "chrome");
    expect(calls[0]).toEqual({ method: "clip.pair", params: { label: "chrome" } });
  });
});

// ---------------------------------------------------------------------------
// runClipScopes
// ---------------------------------------------------------------------------

describe("runClipScopes", () => {
  beforeEach(() => {
    out.reset();
  });

  it("calls clip.scopes and prints the updated set", async () => {
    const { client, calls } = createMockIpcClient([{ updated: true, scopes: ["clip", "agents"] }]);
    await runClipScopes(client, "chrome", ["clip", "agents"]);
    expect(calls[0]).toEqual({
      method: "clip.scopes",
      params: { label: "chrome", scopes: ["clip", "agents"] },
    });
    expect(out.stdout).toContain('Scopes for "chrome" are now: clip,agents');
  });

  it("throws when the label is unknown", async () => {
    const { client } = createMockIpcClient([{ updated: false, scopes: [] }]);
    await expect(runClipScopes(client, "nope", ["clip"])).rejects.toThrow(
      'No paired client labelled "nope"',
    );
  });
});

// ---------------------------------------------------------------------------
// runClipStatus
// ---------------------------------------------------------------------------

describe("runClipStatus", () => {
  beforeEach(() => {
    out.reset();
  });

  it("calls clip.status and prints formatted device list", async () => {
    const { client, calls } = createMockIpcClient([
      {
        devices: [{ label: "chrome", fingerprint: "abcd1234", scopes: ["clip", "briefs"] }],
        briefsEnabled: true,
      },
    ]);
    await runClipStatus(client);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "clip.status", params: {} });
    expect(out.stdout).toContain("chrome");
    expect(out.stdout).toContain("abcd1234");
  });

  it("prints empty state when no devices", async () => {
    const { client } = createMockIpcClient([{ devices: [], briefsEnabled: false }]);
    await runClipStatus(client);
    expect(out.stdout).toMatch(/no clipper tokens/i);
  });

  it("prints 'briefs: enabled' when the gateway reports briefsEnabled: true", async () => {
    const { client } = createMockIpcClient([{ devices: [], briefsEnabled: true }]);
    await runClipStatus(client);
    expect(out.stdout).toContain("briefs: enabled");
  });

  it("prints the disabled hint when the gateway reports briefsEnabled: false", async () => {
    const { client } = createMockIpcClient([{ devices: [], briefsEnabled: false }]);
    await runClipStatus(client);
    expect(out.stdout).toContain("briefs: disabled (enable [briefs] in nimbus.toml)");
  });
});

// ---------------------------------------------------------------------------
// runClipRevoke
// ---------------------------------------------------------------------------

describe("runClipRevoke", () => {
  beforeEach(() => {
    out.reset();
  });

  it("calls clip.revoke with the given label and prints revoke count", async () => {
    const { client, calls } = createMockIpcClient([{ revoked: 1 }]);
    await runClipRevoke(client, "chrome");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "clip.revoke", params: { label: "chrome" } });
    expect(out.stdout).toContain("Revoked 1 token(s).");
  });

  it("calls clip.revoke with '*' for --all", async () => {
    const { client, calls } = createMockIpcClient([{ revoked: 3 }]);
    await runClipRevoke(client, "*");
    expect(calls[0]).toEqual({ method: "clip.revoke", params: { label: "*" } });
    expect(out.stdout).toContain("Revoked 3 token(s).");
  });
});

// ---------------------------------------------------------------------------
// runClip (dispatcher)
// ---------------------------------------------------------------------------

describe("runClip (dispatcher)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when the gateway is not running", async () => {
    setFixture({});
    await expect(runClip(["pair"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  it("prints usage when no subcommand is given", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await runClip([]);
    expect(out.stdout).toContain("pair");
    expect(out.stdout).toContain("status");
    expect(out.stdout).toContain("revoke");
  });

  // A flag-shaped value is the next FLAG, not a value. Before this guard each of
  // these silently succeeded with nonsense: a device literally named "--scopes",
  // a tag filter of "--limit", a scope list of ["--json"]. None of them are
  // rejected by anything downstream in a way the operator could act on.
  it.each([
    ["pair --label swallows the next flag", ["pair", "--label", "--scopes", "clip"], /clip pair/],
    ["pair --scopes with no value", ["pair", "--scopes"], /clip pair/],
    ["scopes --set swallows the next flag", ["scopes", "chrome", "--set", "--json"], /clip scopes/],
    ["list --tag swallows the next flag", ["list", "--tag", "--limit", "10"], /clip list/],
    ["list --limit with no value", ["list", "--limit"], /clip list/],
  ])("rejects %s", async (_case, argv, usage) => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runClip(argv)).rejects.toThrow(usage);
  });

  it("a bare trailing --tag is rejected, not read as 'no tag'", async () => {
    // The worst of the set: it used to read as "flag absent" and list EVERY clip,
    // so an operator who meant to filter got the opposite of a filter.
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runClip(["list", "--tag"])).rejects.toThrow(/clip list/);
  });

  it("prints usage for unknown subcommand", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await runClip(["bogus"]);
    expect(out.stdout).toContain("pair");
  });

  it("throws for revoke with no label", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runClip(["revoke"])).rejects.toThrow("Usage: nimbus clip revoke");
  });

  it("routes 'pair' through withIpc", async () => {
    const ipc = createMockIpcClient([
      { code: "P1234", expiresAtMs: Date.now() + 120_000, label: "browser" },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runClip(["pair"]);
    expect(ipc.calls[0]).toEqual({ method: "clip.pair", params: {} });
    expect(out.stdout).toContain("P1234");
  });

  it("routes 'pair --label <n>' through withIpc with label", async () => {
    const ipc = createMockIpcClient([
      { code: "P9999", expiresAtMs: Date.now() + 120_000, label: "work" },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runClip(["pair", "--label", "work"]);
    expect(ipc.calls[0]).toEqual({ method: "clip.pair", params: { label: "work" } });
  });

  it("routes 'pair --scopes <a,b>' through withIpc with parsed scopes", async () => {
    const ipc = createMockIpcClient([
      { code: "P4242", expiresAtMs: Date.now() + 120_000, label: "work", scopes: ["clip"] },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runClip(["pair", "--label", "work", "--scopes", "clip,agents"]);
    expect(ipc.calls[0]).toEqual({
      method: "clip.pair",
      params: { label: "work", scopes: ["clip", "agents"] },
    });
  });

  it("throws usage for 'pair --scopes' with no following value", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runClip(["pair", "--scopes"])).rejects.toThrow(
      "Usage: nimbus clip pair [--label <device>] [--scopes <a,b>]",
    );
  });

  it("throws usage for 'pair --scopes' immediately followed by another flag", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    // --scopes with no value, followed by --label: rest[s+1] is "--label", which would otherwise
    // be silently consumed as the (nonsensical) scope list "--label".
    await expect(runClip(["pair", "--scopes", "--label", "work"])).rejects.toThrow(
      "Usage: nimbus clip pair [--label <device>] [--scopes <a,b>]",
    );
  });

  it("does NOT throw for 'pair' with no --scopes flag at all (flag genuinely omitted)", async () => {
    const ipc = createMockIpcClient([
      { code: "P0001", expiresAtMs: Date.now() + 120_000, label: "browser" },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runClip(["pair"]);
    expect(ipc.calls[0]).toEqual({ method: "clip.pair", params: {} });
  });

  it("routes 'scopes <label> --set <a,b>' through withIpc", async () => {
    const ipc = createMockIpcClient([{ updated: true, scopes: ["clip", "agents"] }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runClip(["scopes", "chrome", "--set", "clip,agents"]);
    expect(ipc.calls[0]).toEqual({
      method: "clip.scopes",
      params: { label: "chrome", scopes: ["clip", "agents"] },
    });
    expect(out.stdout).toContain("clip,agents");
  });

  it("throws usage for 'scopes' without a label", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runClip(["scopes"])).rejects.toThrow("Usage: nimbus clip scopes");
  });

  it("throws usage for 'scopes <label>' without --set", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runClip(["scopes", "chrome"])).rejects.toThrow("Usage: nimbus clip scopes");
  });

  it("routes 'status' through withIpc", async () => {
    const ipc = createMockIpcClient([
      {
        devices: [{ label: "chrome", fingerprint: "ff00", scopes: ["clip"] }],
        briefsEnabled: false,
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runClip(["status"]);
    expect(ipc.calls[0]).toEqual({ method: "clip.status", params: {} });
    expect(out.stdout).toContain("chrome");
  });

  it("routes 'revoke <label>' through withIpc", async () => {
    const ipc = createMockIpcClient([{ revoked: 1 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runClip(["revoke", "chrome"]);
    expect(ipc.calls[0]).toEqual({ method: "clip.revoke", params: { label: "chrome" } });
  });

  it("routes 'revoke --all' as '*' through withIpc", async () => {
    const ipc = createMockIpcClient([{ revoked: 2 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runClip(["revoke", "--all"]);
    expect(ipc.calls[0]).toEqual({ method: "clip.revoke", params: { label: "*" } });
    expect(out.stdout).toContain("Revoked 2 token(s).");
  });
});

const CLIP_ROW = {
  id: "nimbus:clip:abc",
  title: "Understanding Rust Async",
  url: "https://blog.ex.com/rust-async",
  clippedAt: 1721145600000,
  tags: ["rust", "async"],
  mode: "article",
  wordCount: 42,
};

describe("parseLimit", () => {
  it("returns the number when valid", () => {
    expect(parseLimit("25")).toBe(25);
  });
  it("falls back to 50 on non-numeric / non-positive", () => {
    expect(parseLimit("foo")).toBe(50);
    expect(parseLimit("-3")).toBe(50);
    expect(parseLimit("0")).toBe(50);
    expect(parseLimit(undefined)).toBe(50);
  });
  it("rejects partially-numeric and decimal tokens", () => {
    expect(parseLimit("20junk")).toBe(50);
    expect(parseLimit("1.5")).toBe(50);
  });
  it("caps at 1000", () => {
    expect(parseLimit("999999")).toBe(1000);
  });
});

describe("formatClipList", () => {
  it("shows an empty-state line when there are no clips", () => {
    expect(formatClipList([], undefined)).toMatch(/no clips saved/i);
  });
  it("shows a tag-specific empty state", () => {
    expect(formatClipList([], "rust")).toContain('tag "rust"');
  });
  it("renders a header row plus title, tags and url", () => {
    const s = formatClipList([CLIP_ROW], undefined);
    const [header] = s.split("\n");
    expect(header).toContain("CLIPPED");
    expect(header).toContain("TITLE");
    expect(header).toContain("TAGS");
    expect(header).toContain("URL");
    expect(s).toContain("Understanding Rust Async");
    expect(s).toContain("rust");
    expect(s).toContain("https://blog.ex.com/rust-async");
  });

  it("adds no footnote when every clip is complete", () => {
    const s = formatClipList([CLIP_ROW], undefined);
    expect(s).not.toContain("16 KiB");
    expect(s.split("\n")).toHaveLength(2); // header + one row, nothing else
  });

  it("footnotes partial clips with a count (#1005)", () => {
    const s = formatClipList(
      [{ ...CLIP_ROW, truncated: true, sourceWordCount: 20_000, wordCount: 8_192 }, CLIP_ROW],
      undefined,
    );
    expect(s).toContain("1 of 2 clips exceeded the 16 KiB body cap");
    expect(s).toContain("sourceWordCount");
    // The rows themselves keep their fixed-width layout — the disclosure is
    // appended, not squeezed into a column.
    expect(s).toContain("Understanding Rust Async");
  });
});

describe("runClipList", () => {
  beforeEach(() => out.reset());

  it("calls clip.list and prints the table", async () => {
    const { client, calls } = createMockIpcClient([{ clips: [CLIP_ROW] }]);
    await runClipList(client, { limit: 50, json: false });
    expect(calls[0]).toEqual({ method: "clip.list", params: { limit: 50 } });
    expect(out.stdout).toContain("Understanding Rust Async");
  });

  it("passes the tag param when filtering", async () => {
    const { client, calls } = createMockIpcClient([{ clips: [] }]);
    await runClipList(client, { tag: "rust", limit: 50, json: false });
    expect(calls[0]).toEqual({ method: "clip.list", params: { limit: 50, tag: "rust" } });
    expect(out.stdout).toContain('tag "rust"');
  });

  it("emits JSON (incl. wordCount) with --json", async () => {
    const { client } = createMockIpcClient([{ clips: [CLIP_ROW] }]);
    await runClipList(client, { limit: 50, json: true });
    const parsed = JSON.parse(out.stdout);
    expect(parsed[0].wordCount).toBe(42);
    expect(parsed[0].id).toBe("nimbus:clip:abc");
  });
});

describe("runClipDelete", () => {
  beforeEach(() => out.reset());

  it("deletes by target and reports the count", async () => {
    const { client, calls } = createMockIpcClient([{ deleted: 1, matched: 1 }]);
    await runClipDelete(client, "https://a.com/p", { all: false, yes: false });
    expect(calls[0]).toEqual({ method: "clip.delete", params: { target: "https://a.com/p" } });
    expect(out.stdout).toContain("Deleted 1 clip.");
  });

  it("pluralizes for multiple", async () => {
    const { client } = createMockIpcClient([{ deleted: 3, matched: 3 }]);
    await runClipDelete(client, "https://a.com/p", { all: false, yes: false });
    expect(out.stdout).toContain("Deleted 3 clips.");
  });

  it("--all without --yes only reports the count (dry run, no delete)", async () => {
    const { client, calls } = createMockIpcClient([{ deleted: 0, matched: 12 }]);
    await runClipDelete(client, undefined, { all: true, yes: false });
    expect(calls[0]).toEqual({ method: "clip.delete", params: { all: true, dryRun: true } });
    expect(out.stdout).toContain("12 clips would be deleted");
    expect(out.stdout).toContain("--yes");
  });

  it("--all without --yes is singular-safe for a single match", async () => {
    const { client } = createMockIpcClient([{ deleted: 0, matched: 1 }]);
    await runClipDelete(client, undefined, { all: true, yes: false });
    expect(out.stdout).toContain("1 clip would be deleted");
    expect(out.stdout).not.toContain("1 clips would be deleted");
  });

  it("--all --yes deletes everything", async () => {
    const { client, calls } = createMockIpcClient([{ deleted: 12, matched: 12 }]);
    await runClipDelete(client, undefined, { all: true, yes: true });
    expect(calls[0]).toEqual({ method: "clip.delete", params: { all: true } });
    expect(out.stdout).toContain("Deleted 12 clips.");
  });

  it("--all with zero clips reports the empty state (dry run)", async () => {
    const { client } = createMockIpcClient([{ deleted: 0, matched: 0 }]);
    await runClipDelete(client, undefined, { all: true, yes: false });
    expect(out.stdout).toContain("No clips to delete.");
    expect(out.stdout).not.toContain("would be deleted");
  });

  it("--all --yes with zero clips reports the empty state", async () => {
    const { client } = createMockIpcClient([{ deleted: 0, matched: 0 }]);
    await runClipDelete(client, undefined, { all: true, yes: true });
    expect(out.stdout).toContain("No clips to delete.");
    expect(out.stdout).not.toContain("Deleted 0");
  });

  it("throws usage when no target and not --all", async () => {
    const { client } = createMockIpcClient([]);
    await expect(runClipDelete(client, undefined, { all: false, yes: false })).rejects.toThrow(
      "Usage: nimbus clip delete",
    );
  });

  it("rejects a target together with --all (no accidental mass-delete)", async () => {
    const { client, calls } = createMockIpcClient([]);
    await expect(
      runClipDelete(client, "https://a.com/p", { all: true, yes: true }),
    ).rejects.toThrow("not both");
    expect(calls).toHaveLength(0);
  });
});

describe("runClip (dispatcher) — list + delete routing", () => {
  beforeEach(() => out.reset());
  afterEach(() => clearFixture());

  it("routes 'list' through withIpc", async () => {
    const ipc = createMockIpcClient([{ clips: [] }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runClip(["list"]);
    expect(ipc.calls[0]).toEqual({ method: "clip.list", params: { limit: 50 } });
  });

  it("routes 'delete <url>' through withIpc", async () => {
    const ipc = createMockIpcClient([{ deleted: 1, matched: 1 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runClip(["delete", "https://a.com/p"]);
    expect(ipc.calls[0]).toEqual({ method: "clip.delete", params: { target: "https://a.com/p" } });
  });
});
