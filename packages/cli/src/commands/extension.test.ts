import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";

import { CLACK_CANCEL, clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import type { AvailableUpdateCli, SyncResult, UpdateApplyResultCli } from "./extension.ts";

const extensionMod = await import("./extension.ts");
const {
  fetchSandboxPosture,
  formatExtensionInfoHuman,
  formatExtensionListTable,
  hasFlag,
  runExtension,
  runExtensionDisable,
  runExtensionEnable,
  runExtensionInfo,
  runExtensionInstall,
  runExtensionKeygen,
  runExtensionList,
  runExtensionRemove,
  runExtensionSign,
  runExtensionSyncWithCaller,
  runExtensionUpdateWithCaller,
  runExtensionDowngradeWithCaller,
  stripFlags,
  takeFlagValue,
} = extensionMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("hasFlag", () => {
  test("returns true when flag is present", () => {
    expect(hasFlag(["--json", "x"], "--json")).toBe(true);
  });
  test("returns false when absent", () => {
    expect(hasFlag(["x", "y"], "--json")).toBe(false);
  });
});

describe("takeFlagValue", () => {
  test("returns value after flag", () => {
    expect(takeFlagValue(["--filter", "needs-reinstall"], "--filter")).toBe("needs-reinstall");
  });
  test("returns undefined when flag missing", () => {
    expect(takeFlagValue(["other"], "--filter")).toBeUndefined();
  });
  test("returns undefined when flag is final arg", () => {
    expect(takeFlagValue(["--filter"], "--filter")).toBeUndefined();
  });
});

describe("stripFlags", () => {
  test("removes --yes / -y / --json", () => {
    expect(stripFlags(["a", "--yes", "b", "-y", "c", "--json"])).toEqual(["a", "b", "c"]);
  });
  test("removes --filter + value pair", () => {
    expect(stripFlags(["info", "--filter", "needs-reinstall", "id"])).toEqual(["info", "id"]);
  });
  test("removes --publisher-key + value pair", () => {
    expect(stripFlags(["install", "/p", "--publisher-key", "/tmp/k"])).toEqual(["install", "/p"]);
  });
  test("preserves non-flag positional args", () => {
    expect(stripFlags(["install", "/some/path"])).toEqual(["install", "/some/path"]);
  });
});

describe("fetchSandboxPosture", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("returns platform_capabilities when present", async () => {
    const { client } = createMockIpcClient([
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    const posture = await fetchSandboxPosture(client);
    expect(posture).toEqual({ network: "per_host", reason: null });
  });

  test("returns null when sandbox key missing", async () => {
    const { client } = createMockIpcClient([{ unrelated: true }]);
    expect(await fetchSandboxPosture(client)).toBeNull();
  });

  test("returns null when diag.snapshot throws", async () => {
    const { client } = createMockIpcClient([new Error("boom")]);
    expect(await fetchSandboxPosture(client)).toBeNull();
  });
});

describe("runExtensionList", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("prints (no extensions installed) when list empty", async () => {
    const { client, calls } = createMockIpcClient([{ extensions: [] }]);
    await runExtensionList(client, ["list"]);
    expect(calls[0]?.method).toBe("extension.list");
    expect(calls[0]?.params).toEqual({});
    expect(out.stdout).toContain("(no extensions installed)");
  });

  test("renders tabular rows + preserves [needs-reinstall] annotation lines", async () => {
    const { client } = createMockIpcClient([
      {
        extensions: [
          { id: "a.b", version: "1.0.0", enabled: 1 },
          { id: "c.d", version: "2.0.0", enabled: 0 },
          { id: "e.f", version: "3.0.0", enabled: 1, needs_reinstall: true },
        ],
      },
    ]);
    await runExtensionList(client, ["list"]);
    expect(out.stdout).toMatch(/ID\s+Version\s+Publisher\s+Status/);
    expect(out.stdout).toContain("a.b");
    expect(out.stdout).toContain("1.0.0");
    expect(out.stdout).toContain("c.d");
    expect(out.stdout).toContain("disabled");
    expect(out.stdout).toContain("(unverified)");
    expect(out.stdout).toContain("e.f@3.0.0 [needs-reinstall]");
  });

  test("--filter is forwarded as params.filter", async () => {
    const { client, calls } = createMockIpcClient([{ extensions: [] }]);
    await runExtensionList(client, ["list", "--filter", "needs-reinstall"]);
    expect(calls[0]?.params).toEqual({ filter: "needs-reinstall" });
  });

  test("--json prints the raw envelope", async () => {
    const envelope = { extensions: [{ id: "x", version: "1", enabled: 1 }] };
    const { client } = createMockIpcClient([envelope]);
    await runExtensionList(client, ["list", "--json"]);
    expect(out.stdout.trimEnd()).toBe(JSON.stringify(envelope, undefined, 2));
  });

  test("propagates IPC errors", async () => {
    const { client } = createMockIpcClient([new Error("ipc down")]);
    await expect(runExtensionList(client, ["list"])).rejects.toThrow(/ipc down/);
  });
});

describe("runExtensionInfo", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("throws when id missing", async () => {
    const { client } = createMockIpcClient([]);
    await expect(runExtensionInfo(client, [], [])).rejects.toThrow(/extension info/);
  });

  test("prints labelled lines for the extension + sandbox cap", async () => {
    const { client } = createMockIpcClient([
      { extension: { id: "ext1", version: "1.2.3", enabled: 1 } },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext1"], ["info", "ext1"]);
    expect(out.stdout).toContain("Extension: ext1");
    expect(out.stdout).toContain("Version:   1.2.3");
    expect(out.stdout).toContain("Enabled:   yes");
    expect(out.stdout).toContain("Network isolation: per-host");
  });

  test("appends message when needs_reinstall is true", async () => {
    const { client } = createMockIpcClient([
      {
        extension: { id: "ext2", version: "0.1", enabled: 0, needs_reinstall: true },
        message: "Please reinstall this extension.",
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext2"], ["info", "ext2"]);
    expect(out.stdout).toContain("Please reinstall this extension.");
    expect(out.stdout).toContain("Enabled:   no");
  });

  test("--json prints combined envelope", async () => {
    const { client } = createMockIpcClient([
      { extension: { id: "ext3", version: "1.0", enabled: 1 } },
      { sandbox: { platform_capabilities: { network: "all_or_nothing", reason: "no bwrap" } } },
    ]);
    await runExtensionInfo(client, ["ext3"], ["info", "ext3", "--json"]);
    const parsed = JSON.parse(out.stdout.trimEnd());
    expect(parsed.extension.id).toBe("ext3");
    expect(parsed.sandbox.platform_capabilities.network).toBe("all_or_nothing");
  });

  test("--json still prints when sandbox posture is null", async () => {
    const { client } = createMockIpcClient([
      { extension: { id: "ext4", version: "1.0", enabled: 1 } },
      new Error("diag failed"),
    ]);
    await runExtensionInfo(client, ["ext4"], ["info", "ext4", "--json"]);
    const parsed = JSON.parse(out.stdout.trimEnd());
    expect(parsed.sandbox).toBeNull();
  });

  test("propagates IPC errors on extension.info", async () => {
    const { client } = createMockIpcClient([new Error("not found")]);
    await expect(runExtensionInfo(client, ["missing"], ["info", "missing"])).rejects.toThrow(
      /not found/,
    );
  });
});

describe("runExtensionInstall", () => {
  const origIsTty = process.stdout.isTTY;

  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: origIsTty,
    });
    clearFixture();
  });

  test("throws when source path missing", async () => {
    const { client } = createMockIpcClient([]);
    await expect(runExtensionInstall(client, ["install"], [])).rejects.toThrow(/extension install/);
  });

  test("refuses install without --yes in non-TTY mode", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client } = createMockIpcClient([]);
    await expect(runExtensionInstall(client, ["install", "./ext"], ["./ext"])).rejects.toThrow(
      /Refusing to install without confirmation/,
    );
  });

  test("--yes happy path prints installed envelope", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const installed = { id: "new.ext", version: "1.0.0", installPath: "/somewhere" };
    const { client, calls } = createMockIpcClient([installed]);
    await runExtensionInstall(client, ["install", "./ext", "--yes"], ["./ext"]);
    expect(calls[0]?.method).toBe("extension.install");
    expect(out.stdout).toContain("new.ext");
    expect(out.stdout).toContain("/somewhere");
  });

  test("propagates IPC errors with --yes", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client } = createMockIpcClient([new Error("install denied")]);
    await expect(
      runExtensionInstall(client, ["install", "./ext", "--yes"], ["./ext"]),
    ).rejects.toThrow(/install denied/);
  });

  test("-y short flag is honoured", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client, calls } = createMockIpcClient([{ id: "x", version: "1", installPath: "/p" }]);
    await runExtensionInstall(client, ["install", "./ext", "-y"], ["./ext"]);
    expect(calls.length).toBe(1);
  });

  test("TTY mode with confirm-true completes install", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    setFixture({ clackAnswer: true });
    const { client, calls } = createMockIpcClient([{ id: "ext", version: "1", installPath: "/p" }]);
    await runExtensionInstall(client, ["install", "./ext"], ["./ext"]);
    expect(calls.length).toBe(1);
  });

  test("TTY mode with confirm-false aborts install (prints Cancelled)", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    setFixture({ clackAnswer: false });
    const { client, calls } = createMockIpcClient([]);
    await runExtensionInstall(client, ["install", "./ext"], ["./ext"]);
    expect(calls.length).toBe(0);
    expect(out.stdout).toContain("Cancelled.");
  });

  test("TTY mode with isCancel symbol aborts install", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    setFixture({ clackAnswer: CLACK_CANCEL });
    const { client, calls } = createMockIpcClient([]);
    await runExtensionInstall(client, ["install", "./ext"], ["./ext"]);
    expect(calls.length).toBe(0);
  });
});

describe("runExtensionEnable", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("throws on missing id", async () => {
    const { client } = createMockIpcClient([]);
    await expect(runExtensionEnable(client, [])).rejects.toThrow(/extension enable/);
  });

  test("happy path prints ok envelope", async () => {
    const { client, calls } = createMockIpcClient([{ ok: true }]);
    await runExtensionEnable(client, ["my.ext"]);
    expect(calls[0]?.method).toBe("extension.enable");
    expect(calls[0]?.params).toEqual({ id: "my.ext" });
    expect(out.stdout).toContain('"ok": true');
  });

  test("propagates IPC errors", async () => {
    const { client } = createMockIpcClient([new Error("unknown extension")]);
    await expect(runExtensionEnable(client, ["bogus"])).rejects.toThrow(/unknown extension/);
  });
});

describe("runExtensionDisable", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("throws on missing id", async () => {
    const { client } = createMockIpcClient([]);
    await expect(runExtensionDisable(client, [])).rejects.toThrow(/extension disable/);
  });

  test("happy path prints ok envelope", async () => {
    const { client, calls } = createMockIpcClient([{ ok: true }]);
    await runExtensionDisable(client, ["my.ext"]);
    expect(calls[0]?.method).toBe("extension.disable");
    expect(calls[0]?.params).toEqual({ id: "my.ext" });
  });

  test("propagates IPC errors", async () => {
    const { client } = createMockIpcClient([new Error("disable failed")]);
    await expect(runExtensionDisable(client, ["x"])).rejects.toThrow(/disable failed/);
  });
});

describe("runExtensionRemove", () => {
  const origIsTty = process.stdout.isTTY;

  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: origIsTty,
    });
    clearFixture();
  });

  test("throws on missing id", async () => {
    const { client } = createMockIpcClient([]);
    await expect(runExtensionRemove(client, ["remove"], [])).rejects.toThrow(/extension remove/);
  });

  test("refuses to remove without --yes in non-TTY mode", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client } = createMockIpcClient([]);
    await expect(runExtensionRemove(client, ["remove", "my.ext"], ["my.ext"])).rejects.toThrow(
      /Refusing to remove without confirmation/,
    );
  });

  test("--yes happy path prints ok envelope", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client, calls } = createMockIpcClient([{ ok: true }]);
    await runExtensionRemove(client, ["remove", "my.ext", "--yes"], ["my.ext"]);
    expect(calls[0]?.method).toBe("extension.remove");
    expect(calls[0]?.params).toEqual({ id: "my.ext" });
  });

  test("propagates IPC errors with --yes", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client } = createMockIpcClient([new Error("remove failed")]);
    await expect(
      runExtensionRemove(client, ["remove", "my.ext", "--yes"], ["my.ext"]),
    ).rejects.toThrow(/remove failed/);
  });

  test("-y short flag also bypasses prompt", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client, calls } = createMockIpcClient([{ ok: true }]);
    await runExtensionRemove(client, ["remove", "x", "-y"], ["x"]);
    expect(calls.length).toBe(1);
  });

  test("TTY mode with confirm-true completes removal", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    setFixture({ clackAnswer: true });
    const { client, calls } = createMockIpcClient([{ ok: true }]);
    await runExtensionRemove(client, ["remove", "my.ext"], ["my.ext"]);
    expect(calls.length).toBe(1);
  });

  test("TTY mode with confirm-false aborts removal (prints Cancelled)", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    setFixture({ clackAnswer: false });
    const { client, calls } = createMockIpcClient([]);
    await runExtensionRemove(client, ["remove", "my.ext"], ["my.ext"]);
    expect(calls.length).toBe(0);
    expect(out.stdout).toContain("Cancelled.");
  });
});

describe("runExtension top-level dispatcher", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("throws when gateway state is unreadable", async () => {
    setFixture({});
    await expect(runExtension(["list"])).rejects.toThrow(/Gateway is not running/);
  });

  test("throws unknown subcommand EXTENSION_USAGE error when gateway running but sub unknown", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await expect(runExtension(["__no_such_sub__"])).rejects.toThrow(/nimbus extension/);
  });

  test("keygen offline sub succeeds without gateway connection (returns, no throw)", async () => {
    // runExtension keygen dispatches via runExtensionOffline — no gateway needed
    const tmpDir = mkdtempSync(join(tmpdir(), "nimbus-ext-keygen-"));
    const outPath = join(tmpDir, `key-${Date.now()}`);
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      // runExtension with keygen — does NOT require a gateway
      await runExtension(["keygen", "--out", outPath]);
      expect(stdoutChunks.join("").trim().length).toBeGreaterThan(0);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test("sign offline sub — sign with missing args exits 2 via process.exit", async () => {
    // runExtensionSign with no dir returns 2 → runExtensionOffline calls process.exit(2)
    const origExit = process.exit.bind(process);
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? ""})`);
    }) as typeof process.exit;
    try {
      await expect(runExtension(["sign"])).rejects.toThrow("process.exit(2)");
    } finally {
      process.exit = origExit;
    }
  });

  test("dispatches 'list' subcommand through gateway fixture ipcClient", async () => {
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          ipcCalls.push({ method, params });
          if (method === "extension.list") return { extensions: [] };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await runExtension(["list"]);
    expect(ipcCalls.some((c) => c.method === "extension.list")).toBe(true);
    expect(out.stdout).toContain("(no extensions installed)");
  });

  test("dispatches '' (empty sub = list) through gateway fixture ipcClient", async () => {
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          ipcCalls.push({ method, params });
          if (method === "extension.list") return { extensions: [] };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await runExtension([]);
    expect(ipcCalls.some((c) => c.method === "extension.list")).toBe(true);
  });

  test("dispatches 'enable' subcommand through gateway fixture ipcClient", async () => {
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          ipcCalls.push({ method, params });
          if (method === "extension.enable") return { ok: true };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await runExtension(["enable", "my.ext"]);
    expect(ipcCalls.some((c) => c.method === "extension.enable")).toBe(true);
  });

  test("dispatches 'disable' subcommand through gateway fixture ipcClient", async () => {
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          ipcCalls.push({ method, params });
          if (method === "extension.disable") return { ok: true };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await runExtension(["disable", "my.ext"]);
    expect(ipcCalls.some((c) => c.method === "extension.disable")).toBe(true);
  });

  test("dispatches 'sync' subcommand through gateway fixture ipcClient and returns 0", async () => {
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          ipcCalls.push({ method, params });
          if (method === "extension.sync") {
            return {
              publishersChecked: 0,
              publishersUnchanged: 0,
              publishersUpdated: [],
              publishersEvicted: [],
              failures: [],
            };
          }
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await runExtension(["sync"]);
    expect(ipcCalls.some((c) => c.method === "extension.sync")).toBe(true);
  });

  test("dispatches 'info' subcommand through gateway fixture ipcClient", async () => {
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          ipcCalls.push({ method, params });
          if (method === "extension.info")
            return { extension: { id: "ext-a", version: "1.0.0", enabled: 1 } };
          if (method === "diag.snapshot") return {};
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await runExtension(["info", "ext-a"]);
    expect(ipcCalls.some((c) => c.method === "extension.info")).toBe(true);
  });

  test("dispatches 'install' subcommand with --yes through gateway fixture ipcClient", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          ipcCalls.push({ method, params });
          if (method === "extension.install")
            return { id: "ext-a", version: "1.0.0", installPath: "/p" };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    const origIsTty = process.stdout.isTTY;
    try {
      await runExtension(["install", "/some/path", "--yes"]);
      expect(ipcCalls.some((c) => c.method === "extension.install")).toBe(true);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: origIsTty });
    }
  });

  test("dispatches 'remove' subcommand with --yes through gateway fixture ipcClient", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          ipcCalls.push({ method, params });
          if (method === "extension.remove") return { ok: true };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    const origIsTty = process.stdout.isTTY;
    try {
      await runExtension(["remove", "ext-a", "--yes"]);
      expect(ipcCalls.some((c) => c.method === "extension.remove")).toBe(true);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: origIsTty });
    }
  });

  test("dispatches 'update' subcommand through gateway fixture ipcClient", async () => {
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          ipcCalls.push({ method, params });
          if (method === "extension.checkForUpdates") return [];
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await runExtension(["update"]);
    expect(ipcCalls.some((c) => c.method === "extension.checkForUpdates")).toBe(true);
  });

  test("dispatches 'downgrade' subcommand — missing id returns 1 and exits via process.exit", async () => {
    // downgrade with no id returns exit code 1 → process.exit(1) via dispatchExtensionWithCode
    const origExit = process.exit.bind(process);
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? ""})`);
    }) as typeof process.exit;
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          ipcCalls.push({ method, params });
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    try {
      await expect(runExtension(["downgrade"])).rejects.toThrow("process.exit(1)");
    } finally {
      process.exit = origExit;
      process.exitCode = 0;
    }
  });

  // Note: testing per-handler logic is covered by the dedicated describe blocks above.
});

describe("runExtensionInstall --publisher-key (T2 PR 2)", () => {
  const origIsTty = process.stdout.isTTY;

  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: origIsTty,
    });
    clearFixture();
  });

  test("forwards --publisher-key path through to extension.install IPC params", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client, calls } = createMockIpcClient([
      { id: "ext-a", version: "1.0.0", installPath: "/p" },
    ]);
    await runExtensionInstall(
      client,
      ["install", "/path/to/ext", "--publisher-key", "/tmp/pub.key", "--yes"],
      ["/path/to/ext"],
    );
    expect(calls[0]?.method).toBe("extension.install");
    expect(calls[0]?.params).toMatchObject({ publisherKeyPath: "/tmp/pub.key" });
  });

  test("does NOT include publisherKeyPath when flag is absent", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client, calls } = createMockIpcClient([
      { id: "ext-a", version: "1.0.0", installPath: "/p" },
    ]);
    await runExtensionInstall(client, ["install", "/path/to/ext", "--yes"], ["/path/to/ext"]);
    expect(calls[0]?.method).toBe("extension.install");
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params["publisherKeyPath"]).toBeUndefined();
  });
});

describe("formatExtensionListTable (T2 PR 2)", () => {
  test("renders header with ID | Version | Publisher | Status", () => {
    const formatted = formatExtensionListTable(
      [
        { id: "ext-a", version: "1.0.0", enabled: 1, publisher: { id: "pub-a", key: "AAA" } },
        { id: "ext-b", version: "0.5.1", enabled: 1 },
      ],
      { isTty: false, noColor: true },
    );
    expect(formatted).toMatch(/ID\s+Version\s+Publisher\s+Status/);
    expect(formatted).toContain("ext-a");
    expect(formatted).toContain("pub-a");
    expect(formatted).toContain("(unverified)");
  });

  test("(unverified) is wrapped in ANSI dim-yellow on TTY with NO_COLOR unset", () => {
    const formatted = formatExtensionListTable([{ id: "ext-b", version: "0.5.1", enabled: 1 }], {
      isTty: true,
      noColor: false,
    });
    const ESC = String.fromCodePoint(27);
    expect(formatted).toMatch(new RegExp(String.raw`${ESC}\[2;33m\(unverified\)\s*${ESC}\[0m`));
  });

  test("NO_COLOR=1 (noColor=true) disables ANSI codes even on TTY", () => {
    const formatted = formatExtensionListTable([{ id: "ext-b", version: "0.5.1", enabled: 1 }], {
      isTty: true,
      noColor: true,
    });
    const ESC = String.fromCodePoint(27);
    expect(formatted).not.toMatch(new RegExp(String.raw`${ESC}\[`));
  });

  test("disabled row shows 'disabled' in Status column", () => {
    const formatted = formatExtensionListTable([{ id: "ext-c", version: "1.0.0", enabled: 0 }], {
      isTty: false,
      noColor: true,
    });
    expect(formatted).toContain("disabled");
  });
});

describe("formatExtensionInfoHuman (T2 PR 2)", () => {
  test("shows Publisher section with id + truncated key for signed extensions", () => {
    const formatted = formatExtensionInfoHuman({
      id: "ext-a",
      version: "1.0.0",
      publisher: { id: "pub-a", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    });
    expect(formatted).toMatch(/Publisher:\s+pub-a/);
    expect(formatted).toContain("AAAAAAAAAAAAAAAA…");
  });

  test("shows (unverified) for unsigned extensions", () => {
    const formatted = formatExtensionInfoHuman({ id: "ext-b", version: "0.5.1" });
    expect(formatted).toMatch(/Publisher:\s+\(unverified\)/);
  });
});

describe("runExtensionInfo publisher (T2 PR 2)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("human output includes Publisher section with truncated key", async () => {
    const fullKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const { client } = createMockIpcClient([
      {
        extension: {
          id: "ext-a",
          version: "1.0.0",
          enabled: 1,
          publisher: { id: "pub-a", key: fullKey },
        },
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-a"], ["info", "ext-a"]);
    expect(out.stdout).toMatch(/Publisher:\s+pub-a/);
    expect(out.stdout).toContain("AAAAAAAAAAAAAAAA…");
    expect(out.stdout).not.toContain(fullKey);
  });

  test("human output shows (unverified) when publisher absent", async () => {
    const { client } = createMockIpcClient([
      { extension: { id: "ext-b", version: "0.5.1", enabled: 1 } },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-b"], ["info", "ext-b"]);
    expect(out.stdout).toMatch(/Publisher:\s+\(unverified\)/);
  });

  test("--json output includes full publisher.key (not truncated)", async () => {
    const fullKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const { client } = createMockIpcClient([
      {
        extension: {
          id: "ext-a",
          version: "1.0.0",
          enabled: 1,
          publisher: { id: "pub-a", key: fullKey },
        },
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-a"], ["info", "ext-a", "--json"]);
    const parsed = JSON.parse(out.stdout.trimEnd()) as {
      extension: { publisher: { id: string; key: string } };
    };
    expect(parsed.extension.publisher.id).toBe("pub-a");
    expect(parsed.extension.publisher.key).toBe(fullKey);
  });
});

describe("runExtensionRemove --force (T2 PR 4)", () => {
  const origIsTty = process.stdout.isTTY;
  let stderrOutput: string[] = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: origIsTty,
    });
    process.stderr.write = origStderrWrite;
    stderrOutput = [];
    clearFixture();
  });

  test("--force passes force:true in payload + writes warning to stderr", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrOutput.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    const { client, calls } = createMockIpcClient([{ ok: true }]);
    await runExtensionRemove(client, ["remove", "my.ext", "--yes", "--force"], ["my.ext"]);
    expect(calls[0]?.method).toBe("extension.remove");
    expect(calls[0]?.params).toEqual({ id: "my.ext", force: true });
    const errOut = stderrOutput.join("");
    expect(errOut).toContain("--force");
  });

  test("prints actionable message on reverse_dep_blocked and exits 1", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrOutput.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    const origExit = process.exit.bind(process);
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? ""})`);
    }) as typeof process.exit;
    try {
      const { client } = createMockIpcClient([
        new Error("reverse_dep_blocked: dep-a requires my.ext"),
      ]);
      await expect(
        runExtensionRemove(client, ["remove", "my.ext", "--yes"], ["my.ext"]),
      ).rejects.toThrow("process.exit(1)");
      const errOut = stderrOutput.join("");
      expect(errOut).toContain("reverse_dep_blocked");
      expect(errOut).toContain("--force");
    } finally {
      process.exit = origExit;
    }
  });
});

describe("runExtensionInfo --deps (T2 PR 4)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("--deps appends Dependencies section with forward + reverse deps", async () => {
    const { client } = createMockIpcClient([
      {
        extension: {
          id: "ext-a",
          version: "1.0.0",
          enabled: 1,
          forwardDeps: [
            { id: "dep-x", range: "^1.0.0" },
            { id: "dep-y", range: ">=2.0.0" },
          ],
          reverseDeps: [{ extensionId: "parent-a", range: "~0.5.0" }],
        },
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-a"], ["info", "ext-a", "--deps"]);
    expect(out.stdout).toContain("Dependencies:");
    expect(out.stdout).toContain("dep-x");
    expect(out.stdout).toContain("dep-y");
    expect(out.stdout).toContain("parent-a");
    expect(out.stdout).toContain("Forward");
    expect(out.stdout).toContain("Reverse");
  });

  test("--deps prints (none) when both arrays empty", async () => {
    const { client } = createMockIpcClient([
      {
        extension: {
          id: "ext-b",
          version: "0.1.0",
          enabled: 1,
          forwardDeps: [],
          reverseDeps: [],
        },
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-b"], ["info", "ext-b", "--deps"]);
    expect(out.stdout).toContain("(none)");
    expect(out.stdout).not.toContain("Forward");
    expect(out.stdout).not.toContain("Reverse");
  });
});

describe("runExtensionList --tree (T2 PR 4)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("--tree fetches per-extension info and renders via renderTree", async () => {
    const { client, calls } = createMockIpcClient([
      {
        extensions: [
          { id: "ext-a", version: "1.0.0", enabled: 1 },
          { id: "ext-b", version: "2.0.0", enabled: 1 },
        ],
      },
      { extension: { forwardDeps: [{ id: "ext-b", range: "^2.0.0" }] } },
      { extension: { forwardDeps: [] } },
    ]);
    await runExtensionList(client, ["list", "--tree"]);
    expect(calls.length).toBe(3);
    expect(calls[0]?.method).toBe("extension.list");
    expect(calls[1]?.method).toBe("extension.info");
    expect(calls[2]?.method).toBe("extension.info");
    expect(out.stdout).toContain("ext-a");
    expect(out.stdout).toContain("ext-b");
  });

  test("--tree falls back to leaf node when extension.info throws", async () => {
    const { client } = createMockIpcClient([
      { extensions: [{ id: "ext-z", version: "0.1.0", enabled: 1 }] },
      new Error("info unavailable"),
    ]);
    await runExtensionList(client, ["list", "--tree"]);
    expect(out.stdout).toContain("ext-z");
  });
});

// ---------------------------------------------------------------------------
// runExtensionList — additional branch coverage
// ---------------------------------------------------------------------------
describe("runExtensionList — additional branches", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("table row uses enabled=1 when r.enabled is undefined (??1 default)", async () => {
    const { client } = createMockIpcClient([
      {
        extensions: [{ id: "my.ext", version: "1.0.0" }],
      },
    ]);
    await runExtensionList(client, ["list"]);
    expect(out.stdout).toContain("enabled");
    expect(out.stdout).toContain("my.ext");
  });

  test("table row with publisher set renders publisher id (not unverified)", async () => {
    const { client } = createMockIpcClient([
      {
        extensions: [
          { id: "pub.ext", version: "2.0.0", enabled: 1, publisher: { id: "acme", key: "k" } },
        ],
      },
    ]);
    await runExtensionList(client, ["list"]);
    expect(out.stdout).toContain("acme");
    expect(out.stdout).not.toContain("(unverified)");
  });
});

// ---------------------------------------------------------------------------
// formatExtensionListTable — boolean enabled branch
// ---------------------------------------------------------------------------
describe("formatExtensionListTable — boolean enabled", () => {
  test("enabled=true renders 'enabled'", () => {
    const formatted = formatExtensionListTable([{ id: "x", version: "1.0.0", enabled: true }], {
      isTty: false,
      noColor: true,
    });
    expect(formatted).toContain("enabled");
    expect(formatted).not.toContain("disabled");
  });

  test("enabled=false renders 'disabled'", () => {
    const formatted = formatExtensionListTable([{ id: "x", version: "1.0.0", enabled: false }], {
      isTty: false,
      noColor: true,
    });
    expect(formatted).toContain("disabled");
  });
});

// ---------------------------------------------------------------------------
// runExtensionInfo — publisher with no key string (unverified branch in print)
// ---------------------------------------------------------------------------
describe("runExtensionInfo — publisher without key", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("shows (unverified) when publisher exists but key is not a string", async () => {
    const { client } = createMockIpcClient([
      {
        extension: {
          id: "ext-nokey",
          version: "1.0.0",
          enabled: 1,
          publisher: { id: "pub-a" },
        },
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-nokey"], ["info", "ext-nokey"]);
    expect(out.stdout).toContain("Publisher: (unverified)");
  });
});

// ---------------------------------------------------------------------------
// runExtensionInfo — --deps with forward-only or reverse-only
// ---------------------------------------------------------------------------
describe("runExtensionInfo --deps — partial dep sets", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("--deps with only forward deps (no reverse) prints Forward section only", async () => {
    const { client } = createMockIpcClient([
      {
        extension: {
          id: "ext-fwd",
          version: "1.0.0",
          enabled: 1,
          forwardDeps: [{ id: "dep-a", range: "^1.0.0" }],
          reverseDeps: [],
        },
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-fwd"], ["info", "ext-fwd", "--deps"]);
    expect(out.stdout).toContain("Forward");
    expect(out.stdout).not.toContain("Reverse (required");
  });

  test("--deps with only reverse deps (no forward) prints Reverse section only", async () => {
    const { client } = createMockIpcClient([
      {
        extension: {
          id: "ext-rev",
          version: "1.0.0",
          enabled: 1,
          forwardDeps: [],
          reverseDeps: [{ extensionId: "parent-x", range: "^2.0.0" }],
        },
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-rev"], ["info", "ext-rev", "--deps"]);
    expect(out.stdout).toContain("Reverse");
    expect(out.stdout).not.toContain("Forward (this extension");
  });

  test("--deps with undefined dep arrays falls back to empty (no crash)", async () => {
    const { client } = createMockIpcClient([
      {
        extension: {
          id: "ext-nodeps",
          version: "1.0.0",
          enabled: 1,
        },
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-nodeps"], ["info", "ext-nodeps", "--deps"]);
    expect(out.stdout).toContain("(none)");
  });
});

// ---------------------------------------------------------------------------
// runExtensionSyncWithCaller
// ---------------------------------------------------------------------------
describe("runExtensionSyncWithCaller", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
    clearFixture();
  });

  function makeSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
    return {
      publishersChecked: 1,
      publishersUnchanged: 1,
      publishersUpdated: [],
      publishersEvicted: [],
      failures: [],
      ...overrides,
    };
  }

  test("happy path (no flags) prints human summary and returns 0", async () => {
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    const result = makeSyncResult({ publishersChecked: 2, publishersUnchanged: 2 });
    const code = await runExtensionSyncWithCaller({
      args: [],
      caller: async () => result,
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("publishers checked: 2");
  });

  test("--json flag emits JSON instead of human text", async () => {
    const stdoutChunks: string[] = [];
    const result = makeSyncResult();
    const code = await runExtensionSyncWithCaller({
      args: ["--json"],
      caller: async () => result,
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutChunks.join("").trim()) as SyncResult;
    expect(parsed.publishersChecked).toBe(1);
  });

  test("--dry-run passes dryRun:true to caller", async () => {
    let callerArgs: Record<string, unknown> | undefined;
    const result = makeSyncResult();
    await runExtensionSyncWithCaller({
      args: ["--dry-run"],
      caller: async (params) => {
        callerArgs = params;
        return result;
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(callerArgs?.["dryRun"]).toBe(true);
  });

  test("error with 'air-gap' in message returns exit code 3", async () => {
    const code = await runExtensionSyncWithCaller({
      args: [],
      caller: async () => {
        throw new Error("air-gap: network not available");
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(code).toBe(3);
  });

  test("generic error (not air-gap) returns exit code 1", async () => {
    const code = await runExtensionSyncWithCaller({
      args: [],
      caller: async () => {
        throw new Error("some other failure");
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(code).toBe(1);
  });

  test("non-Error thrown returns exit code 1", async () => {
    const code = await runExtensionSyncWithCaller({
      args: [],
      caller: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "plain string error";
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(code).toBe(1);
  });

  test("reverifyResult=failed in updated entry writes stderr and returns 2", async () => {
    const stderrChunks: string[] = [];
    const result = makeSyncResult({
      publishersUpdated: [
        { id: "pub-x", reverifyResult: "failed", failedExtensions: ["ext-a", "ext-b"] },
      ],
    });
    const code = await runExtensionSyncWithCaller({
      args: [],
      caller: async () => result,
      writeStdout: () => {},
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(2);
    expect(stderrChunks.join("")).toContain("pub-x");
    expect(stderrChunks.join("")).toContain("ext-a");
  });

  test("reverifyResult=ok in updated entry does not write stderr", async () => {
    const stderrChunks: string[] = [];
    const result = makeSyncResult({
      publishersUpdated: [{ id: "pub-ok", reverifyResult: "ok", failedExtensions: [] }],
    });
    const code = await runExtensionSyncWithCaller({
      args: [],
      caller: async () => result,
      writeStdout: () => {},
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(0);
    expect(stderrChunks.join("")).not.toContain("pub-ok");
  });

  test("all publishers failed (failures.length === publishersChecked > 0) returns 4", async () => {
    const result = makeSyncResult({
      publishersChecked: 2,
      publishersUnchanged: 0,
      publishersUpdated: [],
      failures: [
        { id: "pub-a", reason: "timeout" },
        { id: "pub-b", reason: "timeout" },
      ],
    });
    const stderrChunks: string[] = [];
    const code = await runExtensionSyncWithCaller({
      args: [],
      caller: async () => result,
      writeStdout: () => {},
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(4);
    expect(stderrChunks.join("")).toContain("pub-a");
  });

  test("partial failures (some pass) returns 0, not 4", async () => {
    const result = makeSyncResult({
      publishersChecked: 3,
      failures: [{ id: "pub-a", reason: "timeout" }],
    });
    const code = await runExtensionSyncWithCaller({
      args: [],
      caller: async () => result,
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runExtensionUpdateWithCaller — listExtensionUpdates
// ---------------------------------------------------------------------------
describe("runExtensionUpdateWithCaller — list mode (no id)", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
    clearFixture();
  });

  function makeUpdate(overrides: Partial<AvailableUpdateCli> = {}): AvailableUpdateCli {
    return {
      id: "ext-a",
      displayName: "Extension A",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      channel: "stable",
      publisherStatus: "verified",
      verificationStatus: "verified",
      ...overrides,
    };
  }

  test("no id → calls checkForUpdates; empty list prints 'No updates available'", async () => {
    const stdoutChunks: string[] = [];
    const code = await runExtensionUpdateWithCaller({
      args: [],
      caller: async () => [],
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("No updates available");
  });

  test("no id → non-empty list prints rows", async () => {
    const stdoutChunks: string[] = [];
    const code = await runExtensionUpdateWithCaller({
      args: [],
      caller: async () => [makeUpdate()],
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("ext-a");
    expect(stdoutChunks.join("")).toContain("1.0.0");
    expect(stdoutChunks.join("")).toContain("1.1.0");
  });

  test("--json flag prints JSON array", async () => {
    const stdoutChunks: string[] = [];
    const code = await runExtensionUpdateWithCaller({
      args: ["--json"],
      caller: async () => [makeUpdate()],
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutChunks.join("").trim()) as AvailableUpdateCli[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]?.id).toBe("ext-a");
  });

  test("--check flag passes force:true to checkForUpdates caller", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    await runExtensionUpdateWithCaller({
      args: ["--check"],
      caller: async (_method, params) => {
        capturedParams = params as Record<string, unknown>;
        return [];
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(capturedParams?.["force"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runExtensionUpdateWithCaller — applyExtensionUpdate
// ---------------------------------------------------------------------------
describe("runExtensionUpdateWithCaller — apply mode (with id)", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
    clearFixture();
  });
  function makeUpdate(overrides: Partial<AvailableUpdateCli> = {}): AvailableUpdateCli {
    return {
      id: "ext-a",
      displayName: "Extension A",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      channel: "stable",
      publisherStatus: "verified",
      verificationStatus: "verified",
      ...overrides,
    };
  }

  function makeApplyResult(overrides: Partial<UpdateApplyResultCli> = {}): UpdateApplyResultCli {
    return { applied: true, ...overrides };
  }

  test("no cached update for id returns 1 with error message", async () => {
    const stderrChunks: string[] = [];
    // caller returns empty list → entry not found
    const code = await runExtensionUpdateWithCaller({
      args: ["ext-b"],
      caller: async () => [],
      writeStdout: () => {},
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("ext-b");
  });

  test("applied=true prints success message with toVersion and returns 0", async () => {
    const stdoutChunks: string[] = [];
    let callCount = 0;
    const code = await runExtensionUpdateWithCaller({
      args: ["ext-a"],
      caller: async (_method, _params) => {
        callCount += 1;
        if (callCount === 1) return [makeUpdate()];
        return makeApplyResult();
      },
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("updated ext-a to 1.1.0");
  });

  test("applied=true with jobId includes jobId in output", async () => {
    const stdoutChunks: string[] = [];
    let callCount = 0;
    const code = await runExtensionUpdateWithCaller({
      args: ["ext-a"],
      caller: async () => {
        callCount += 1;
        if (callCount === 1) return [makeUpdate()];
        return makeApplyResult({ jobId: "job-123" });
      },
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("job-123");
  });

  test("--to flag overrides toVersion", async () => {
    let applyParams: Record<string, unknown> | undefined;
    let callCount = 0;
    await runExtensionUpdateWithCaller({
      args: ["ext-a", "--to", "2.0.0"],
      caller: async (_method, params) => {
        callCount += 1;
        if (callCount === 1) return [makeUpdate()];
        applyParams = params as Record<string, unknown>;
        return makeApplyResult();
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(applyParams?.["toVersion"]).toBe("2.0.0");
  });

  test("applied=false prints failure reason and returns 1", async () => {
    const stderrChunks: string[] = [];
    let callCount = 0;
    const code = await runExtensionUpdateWithCaller({
      args: ["ext-a"],
      caller: async () => {
        callCount += 1;
        if (callCount === 1) return [makeUpdate()];
        return makeApplyResult({ applied: false, reason: "signature_failed" });
      },
      writeStdout: () => {},
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("signature_failed");
  });

  test("applied=false with hint includes hint in stderr", async () => {
    const stderrChunks: string[] = [];
    let callCount = 0;
    const code = await runExtensionUpdateWithCaller({
      args: ["ext-a"],
      caller: async () => {
        callCount += 1;
        if (callCount === 1) return [makeUpdate()];
        return makeApplyResult({ applied: false, reason: "err", hint: "re-run sync" });
      },
      writeStdout: () => {},
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("re-run sync");
  });

  test("applied=false without reason prints 'unknown'", async () => {
    const stderrChunks: string[] = [];
    let callCount = 0;
    const code = await runExtensionUpdateWithCaller({
      args: ["ext-a"],
      caller: async () => {
        callCount += 1;
        if (callCount === 1) return [makeUpdate()];
        return makeApplyResult({ applied: false });
      },
      writeStdout: () => {},
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("unknown");
  });

  test("--json flag with applied=true returns 0 and JSON output", async () => {
    const stdoutChunks: string[] = [];
    let callCount = 0;
    const code = await runExtensionUpdateWithCaller({
      args: ["ext-a", "--json"],
      caller: async () => {
        callCount += 1;
        if (callCount === 1) return [makeUpdate()];
        return makeApplyResult();
      },
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutChunks.join("").trim()) as UpdateApplyResultCli;
    expect(parsed.applied).toBe(true);
  });

  test("--json flag with applied=false returns 1 and JSON output", async () => {
    const stdoutChunks: string[] = [];
    let callCount = 0;
    const code = await runExtensionUpdateWithCaller({
      args: ["ext-a", "--json"],
      caller: async () => {
        callCount += 1;
        if (callCount === 1) return [makeUpdate()];
        return makeApplyResult({ applied: false });
      },
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutChunks.join("").trim()) as UpdateApplyResultCli;
    expect(parsed.applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runExtensionDowngradeWithCaller
// ---------------------------------------------------------------------------
describe("runExtensionDowngradeWithCaller", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
    clearFixture();
  });

  function makeApplyResult(overrides: Partial<UpdateApplyResultCli> = {}): UpdateApplyResultCli {
    return { applied: true, ...overrides };
  }

  const dummyFetchInfo = async () => ({});

  test("missing id returns 1 with usage message", async () => {
    const stderrChunks: string[] = [];
    const code = await runExtensionDowngradeWithCaller({
      args: [],
      caller: async () => makeApplyResult(),
      fetchInfo: dummyFetchInfo,
      writeStdout: () => {},
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("downgrade");
  });

  test("missing --to returns 1 with error message", async () => {
    const stderrChunks: string[] = [];
    const code = await runExtensionDowngradeWithCaller({
      args: ["ext-a"],
      caller: async () => makeApplyResult(),
      fetchInfo: dummyFetchInfo,
      writeStdout: () => {},
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("--to");
  });

  test("applied=true prints success and returns 0", async () => {
    const stdoutChunks: string[] = [];
    const code = await runExtensionDowngradeWithCaller({
      args: ["ext-a", "--to", "0.9.0"],
      caller: async () => makeApplyResult(),
      fetchInfo: dummyFetchInfo,
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("downgraded ext-a to 0.9.0");
  });

  test("applied=false prints failure reason and returns 1", async () => {
    const stderrChunks: string[] = [];
    const code = await runExtensionDowngradeWithCaller({
      args: ["ext-a", "--to", "0.9.0"],
      caller: async () => makeApplyResult({ applied: false, reason: "not_found" }),
      fetchInfo: dummyFetchInfo,
      writeStdout: () => {},
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("not_found");
  });

  test("applied=false with hint includes hint in stderr", async () => {
    const stderrChunks: string[] = [];
    const code = await runExtensionDowngradeWithCaller({
      args: ["ext-a", "--to", "0.9.0"],
      caller: async () => makeApplyResult({ applied: false, reason: "err", hint: "check cache" }),
      fetchInfo: dummyFetchInfo,
      writeStdout: () => {},
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("check cache");
  });

  test("applied=false without reason prints 'unknown'", async () => {
    const stderrChunks: string[] = [];
    const code = await runExtensionDowngradeWithCaller({
      args: ["ext-a", "--to", "0.9.0"],
      caller: async () => makeApplyResult({ applied: false }),
      fetchInfo: dummyFetchInfo,
      writeStdout: () => {},
      writeStderr: (s) => stderrChunks.push(s),
    });
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("unknown");
  });

  test("--json with applied=true returns 0 and JSON", async () => {
    const stdoutChunks: string[] = [];
    const code = await runExtensionDowngradeWithCaller({
      args: ["ext-a", "--to", "0.9.0", "--json"],
      caller: async () => makeApplyResult(),
      fetchInfo: dummyFetchInfo,
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutChunks.join("").trim()) as UpdateApplyResultCli;
    expect(parsed.applied).toBe(true);
  });

  test("--json with applied=false returns 1 and JSON", async () => {
    const stdoutChunks: string[] = [];
    const code = await runExtensionDowngradeWithCaller({
      args: ["ext-a", "--to", "0.9.0", "--json"],
      caller: async () => makeApplyResult({ applied: false }),
      fetchInfo: dummyFetchInfo,
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutChunks.join("").trim()) as UpdateApplyResultCli;
    expect(parsed.applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runExtensionKeygen
// ---------------------------------------------------------------------------
describe("runExtensionKeygen", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-keygen-test-"));

  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
    clearFixture();
  });

  test("generates a key to --out path and returns 0", async () => {
    const outPath = join(tmpRoot, `key-${Date.now()}`);
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      const code = await runExtensionKeygen(["--out", outPath]);
      expect(code).toBe(0);
      // stdout should contain the base64 pubkey
      expect(stdoutChunks.join("").trim().length).toBeGreaterThan(0);
      expect(stderrChunks.join("")).toBe("");
    } finally {
      process.stdout.write = origWrite;
      process.stderr.write = origStderrWrite;
    }
  });

  test("EEXIST without --force returns 2 and writes to stderr", async () => {
    const outPath = join(tmpRoot, `key-exist-${Date.now()}`);
    // Write the file first so EEXIST fires
    const { privkey } = generateEd25519Keypair();
    writeFileSync(outPath, encodeBase64(privkey));
    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      const code = await runExtensionKeygen(["--out", outPath]);
      expect(code).toBe(2);
      expect(stderrChunks.join("")).toContain("refusing to overwrite");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  test("--force overwrites an existing key and returns 0", async () => {
    const outPath = join(tmpRoot, `key-force-${Date.now()}`);
    const { privkey } = generateEd25519Keypair();
    writeFileSync(outPath, encodeBase64(privkey));
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      const code = await runExtensionKeygen(["--out", outPath, "--force"]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test("non-EEXIST write error is re-thrown", async () => {
    // Write to a path whose parent is a FILE (not a directory) → triggers ENOTDIR (not EEXIST)
    const parentFile = join(tmpRoot, `not-a-dir-${Date.now()}`);
    writeFileSync(parentFile, "i am a file");
    // Attempt to write to parentFile/subkey — parentFile is a file, not a dir
    const outPath = join(parentFile, "subkey");
    await expect(runExtensionKeygen(["--out", outPath])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runExtensionSign
// ---------------------------------------------------------------------------
describe("runExtensionSign", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-sign-test-"));

  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
    clearFixture();
  });

  test("missing extDir (no args) returns 2 with usage message", async () => {
    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      const code = await runExtensionSign([]);
      expect(code).toBe(2);
      expect(stderrChunks.join("")).toContain("usage");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  test("extDir starts with '--' returns 2 with usage message", async () => {
    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      const code = await runExtensionSign(["--some-flag"]);
      expect(code).toBe(2);
      expect(stderrChunks.join("")).toContain("usage");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  test("key file not found returns 2 with error message", async () => {
    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    const extDir = join(tmpRoot, `sign-no-key-${Date.now()}`);
    try {
      const code = await runExtensionSign([extDir, "--key", join(tmpRoot, "nonexistent-key")]);
      expect(code).toBe(2);
      expect(stderrChunks.join("")).toContain("could not read key file");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  test("key file with wrong byte length returns 2", async () => {
    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    // Write a key that is NOT 32 bytes (write a 16-byte value base64-encoded)
    const shortKey = new Uint8Array(16);
    const keyPath = join(tmpRoot, `short-key-${Date.now()}`);
    writeFileSync(keyPath, encodeBase64(shortKey));
    try {
      const code = await runExtensionSign(["/some/ext", "--key", keyPath]);
      expect(code).toBe(2);
      expect(stderrChunks.join("")).toContain("32 bytes");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  test("manifest file not found returns 2 with error message", async () => {
    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    // Generate a valid 32-byte key
    const { privkey } = generateEd25519Keypair();
    const keyPath = join(tmpRoot, `valid-key-${Date.now()}`);
    writeFileSync(keyPath, encodeBase64(privkey));
    const extDir = join(tmpRoot, `ext-no-manifest-${Date.now()}`);
    try {
      const code = await runExtensionSign([extDir, "--key", keyPath]);
      expect(code).toBe(2);
      expect(stderrChunks.join("")).toContain("could not read manifest");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  test("happy path: signs manifest and returns 0", async () => {
    // Set up a valid key
    const { privkey } = generateEd25519Keypair();
    const keyPath = join(tmpRoot, `sign-key-${Date.now()}`);
    writeFileSync(keyPath, encodeBase64(privkey));

    // Set up a valid manifest directory + file
    const extDir = mkdtempSync(join(tmpRoot, "ext-sign-"));
    const manifestPath = join(extDir, "nimbus.extension.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ id: "test.ext", version: "1.0.0", name: "Test Extension" }),
    );

    const code = await runExtensionSign([extDir, "--key", keyPath]);
    expect(code).toBe(0);
  });

  test("happy path: strips existing signature before signing", async () => {
    // Covers the `delete parsed['signature']` branch
    const { privkey } = generateEd25519Keypair();
    const keyPath = join(tmpRoot, `sign-key2-${Date.now()}`);
    writeFileSync(keyPath, encodeBase64(privkey));

    const extDir = mkdtempSync(join(tmpRoot, "ext-sign2-"));
    const manifestPath = join(extDir, "nimbus.extension.json");
    // Include an existing signature field that should be stripped then replaced
    writeFileSync(
      manifestPath,
      JSON.stringify({
        id: "test.ext2",
        version: "1.0.0",
        name: "Test2",
        signature: "old-signature",
      }),
    );

    const code = await runExtensionSign([extDir, "--key", keyPath]);
    expect(code).toBe(0);
    // Re-read manifest and verify the signature is a new value (not the old one)
    const { readFileSync: rfs } = await import("node:fs");
    const updated = JSON.parse(rfs(manifestPath, "utf8")) as Record<string, unknown>;
    expect(updated["signature"]).not.toBe("old-signature");
    expect(typeof updated["signature"]).toBe("string");
  });
});
