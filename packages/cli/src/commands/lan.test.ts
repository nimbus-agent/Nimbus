import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const mod = await import("./lan.ts");
const { parseLanArgs, runLan } = mod;

describe("parseLanArgs", () => {
  test("no args → status", () => {
    expect(parseLanArgs([])).toEqual({ kind: "status" });
  });

  test("status → status", () => {
    expect(parseLanArgs(["status"])).toEqual({ kind: "status" });
  });

  test("open → open", () => {
    expect(parseLanArgs(["open"])).toEqual({ kind: "open" });
  });

  test("close → close", () => {
    expect(parseLanArgs(["close"])).toEqual({ kind: "close" });
  });

  test("peers → peers", () => {
    expect(parseLanArgs(["peers"])).toEqual({ kind: "peers" });
  });

  const peerCommands = [
    { sub: "grant", peerId: "abc-123" },
    { sub: "revoke", peerId: "peer-x" },
    { sub: "remove", peerId: "peer-y" },
  ] as const;

  for (const { sub, peerId } of peerCommands) {
    test(`${sub} <peerId>`, () => {
      expect(parseLanArgs([sub, peerId])).toEqual({ kind: sub, peerId });
    });

    test(`${sub} missing peerId throws`, () => {
      expect(() => parseLanArgs([sub])).toThrow(new RegExp(`Usage: nimbus lan ${sub}`));
    });
  }

  test("grant trims whitespace from peerId", () => {
    expect(parseLanArgs(["grant", "  trimmed  "])).toEqual({ kind: "grant", peerId: "trimmed" });
  });

  test("unknown subcommand throws", () => {
    expect(() => parseLanArgs(["bogus"])).toThrow(/Unknown subcommand/);
  });
});

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runLan — dispatcher", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
  });
  afterEach(() => {
    clearFixture();
  });

  it("status → lan.getStatus + 3-line output", async () => {
    const mock = createMockIpcClient([
      { enabled: true, pairingOpen: false, listenAddr: "127.0.0.1:7475" },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runLan(["status"]);
    expect(mock.calls[0]?.method).toBe("lan.getStatus");
    expect(out.stdout).toContain("LAN enabled:  true");
    expect(out.stdout).toContain("Pairing open: false");
    expect(out.stdout).toContain("127.0.0.1:7475");
  });

  it("status prints '(none)' when listenAddr is null", async () => {
    const mock = createMockIpcClient([{ enabled: false, pairingOpen: false, listenAddr: null }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runLan([]);
    expect(out.stdout).toContain("(none)");
  });

  it("open → lan.openPairingWindow + prints code + ISO expiry", async () => {
    const mock = createMockIpcClient([
      { pairingCode: "AB123-CD456", expiresAt: 1_747_142_500_000 },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runLan(["open"]);
    expect(mock.calls[0]?.method).toBe("lan.openPairingWindow");
    expect(out.stdout).toContain("AB123-CD456");
    expect(out.stdout).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("close → lan.closePairingWindow + 'Pairing window closed.'", async () => {
    const mock = createMockIpcClient([{ ok: true }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runLan(["close"]);
    expect(mock.calls[0]?.method).toBe("lan.closePairingWindow");
    expect(out.stdout).toContain("Pairing window closed.");
  });

  it("peers (empty list) → 'No LAN peers.'", async () => {
    const mock = createMockIpcClient([{ peers: [] }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runLan(["peers"]);
    expect(mock.calls[0]?.method).toBe("lan.listPeers");
    expect(out.stdout).toContain("No LAN peers.");
  });

  it("peers (non-empty) → table rows with yes/no + (unknown) for missing displayName", async () => {
    const mock = createMockIpcClient([
      {
        peers: [
          { peerId: "peer-A", displayName: "Alice", writeAllowed: true },
          { peerId: "peer-B", writeAllowed: false }, // no displayName
        ],
      },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runLan(["peers"]);
    expect(out.stdout).toContain("peer-A");
    expect(out.stdout).toContain("Alice");
    expect(out.stdout).toContain("yes");
    expect(out.stdout).toContain("peer-B");
    expect(out.stdout).toContain("(unknown)");
    expect(out.stdout).toContain("no");
  });

  // Each per-peer subcommand maps to one IPC method and prints its own confirmation line.
  it.each([
    ["grant", "lan.grantWrite", "Write access granted to peer peer-1"],
    ["revoke", "lan.revokeWrite", "Write access revoked for peer peer-1"],
    ["remove", "lan.removePeer", "Peer peer-1 removed."],
  ])("%s <peerId> → %s + confirmation", async (subcommand, method, confirmation) => {
    const mock = createMockIpcClient([{ ok: true }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runLan([subcommand, "peer-1"]);
    expect(mock.calls[0]).toEqual({ method, params: { peerId: "peer-1" } });
    expect(out.stdout).toContain(confirmation);
  });

  it("throws 'Gateway is not running' when state is undefined (parser passes, gateway absent)", async () => {
    setFixture({});
    await expect(runLan(["status"])).rejects.toThrow(/Gateway is not running/);
  });
});
