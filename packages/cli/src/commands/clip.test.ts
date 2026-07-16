import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

import {
  CLIP_USAGE,
  formatStatus,
  runClip,
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
