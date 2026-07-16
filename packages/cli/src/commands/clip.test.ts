import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

import {
  CLIP_USAGE,
  formatClipList,
  formatStatus,
  parseLimit,
  runClip,
  runClipDelete,
  runClipList,
  runClipPair,
  runClipRevoke,
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
    const result = formatStatus([{ label: "chrome", fingerprint: "abcd1234" }]);
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
      { label: "chrome", fingerprint: "abcd1234" },
      { label: "firefox", fingerprint: "ef567890" },
    ]);
    expect(result).toContain("chrome");
    expect(result).toContain("abcd1234");
    expect(result).toContain("firefox");
    expect(result).toContain("ef567890");
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
      { devices: [{ label: "chrome", fingerprint: "abcd1234" }] },
    ]);
    await runClipStatus(client);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "clip.status", params: {} });
    expect(out.stdout).toContain("chrome");
    expect(out.stdout).toContain("abcd1234");
  });

  it("prints empty state when no devices", async () => {
    const { client } = createMockIpcClient([{ devices: [] }]);
    await runClipStatus(client);
    expect(out.stdout).toMatch(/no clipper tokens/i);
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

  it("routes 'status' through withIpc", async () => {
    const ipc = createMockIpcClient([{ devices: [{ label: "chrome", fingerprint: "ff00" }] }]);
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
