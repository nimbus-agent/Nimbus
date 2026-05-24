/**
 * Unit tests for `nimbus extension` per-subcommand handlers.
 *
 * Each handler is exercised with a fixture-driven `IPCClient`-shaped mock
 * (via the shared CLI test harness) so the tests run in-process and do
 * not touch the gateway socket. Coverage targets the success path + IPC-
 * error path for every public helper.
 *
 * Phase 6 Task 13: migrated off per-file `mock.module("@clack/prompts")`
 * + `mock.module("../lib/gateway-process.ts")` (which leaked across the
 * full `bun test packages/cli` run via Bun's process-global mock.module)
 * and onto the shared harness in `packages/cli/test/helpers/cli-mocks.ts`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects only
import { CLACK_CANCEL, clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

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
  runExtensionList,
  runExtensionRemove,
  stripFlags,
  takeFlagValue,
} = extensionMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

// ----------------------------- flag helpers -------------------------------

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

// ----------------------------- fetchSandboxPosture ------------------------

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

// ----------------------------- runExtensionList ---------------------------

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
    // New tabular format: ID | Version | Publisher | Status
    expect(out.stdout).toMatch(/ID\s+Version\s+Publisher\s+Status/);
    expect(out.stdout).toContain("a.b");
    expect(out.stdout).toContain("1.0.0");
    expect(out.stdout).toContain("c.d");
    expect(out.stdout).toContain("disabled");
    expect(out.stdout).toContain("(unverified)");
    // needs-reinstall annotation lines are preserved for grep-based scripts.
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

// ----------------------------- runExtensionInfo ---------------------------

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

// ----------------------------- runExtensionInstall ------------------------

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

// ----------------------------- enable / disable ---------------------------

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

// ----------------------------- runExtensionRemove -------------------------

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

// ----------------------------- runExtension (top-level dispatcher) ----------

describe("runExtension top-level dispatcher", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("throws when gateway state is unreadable", async () => {
    setFixture({}); // gatewayState undefined
    await expect(runExtension(["list"])).rejects.toThrow(/Gateway is not running/);
  });

  // Note: testing the dispatch branches for individual subcommands (list,
  // info, install, enable, disable, remove) requires a connectable IPC
  // socket. Those branches are intentionally left to e2e tests; the
  // per-handler logic above already covers the meaningful code paths.
});

// ----------------------------- runExtensionInstall --publisher-key (T2 PR 2) -

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

// ----------------------------- formatExtensionListTable (T2 PR 2) ----------

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
    // ESC = U+001B; build via String.fromCharCode so the literal regex doesn't
    // carry a control character (Biome `noControlCharactersInRegex`).
    const ESC = String.fromCharCode(27);
    expect(formatted).toMatch(new RegExp(`${ESC}\\[2;33m\\(unverified\\)\\s*${ESC}\\[0m`));
  });

  test("NO_COLOR=1 (noColor=true) disables ANSI codes even on TTY", () => {
    const formatted = formatExtensionListTable([{ id: "ext-b", version: "0.5.1", enabled: 1 }], {
      isTty: true,
      noColor: true,
    });
    const ESC = String.fromCharCode(27);
    expect(formatted).not.toMatch(new RegExp(`${ESC}\\[`));
  });

  test("disabled row shows 'disabled' in Status column", () => {
    const formatted = formatExtensionListTable([{ id: "ext-c", version: "1.0.0", enabled: 0 }], {
      isTty: false,
      noColor: true,
    });
    expect(formatted).toContain("disabled");
  });
});

// ----------------------------- formatExtensionInfoHuman (T2 PR 2) ----------

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

// ----------------------------- runExtensionInfo --json (T2 PR 2) ----------

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
    // Truncated, not full
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

// ─────────────────────────── T2 PR 4 — --force / --deps / --tree ────────────

// ----------------------------- runExtensionRemove --force (T2 PR 4) ---------

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
    // Capture stderr — `process.stderr.write` is what extension.ts uses for
    // the --force warning, not `console.warn`, so we intercept directly.
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
    // Capture stderr before triggering the error path.
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrOutput.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    // Override process.exit so it throws instead of killing the process,
    // which lets us assert on stderr output written before exit is called.
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

// ----------------------------- runExtensionInfo --deps (T2 PR 4) ------------

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
    // Neither Forward nor Reverse section should appear
    expect(out.stdout).not.toContain("Forward");
    expect(out.stdout).not.toContain("Reverse");
  });
});

// ----------------------------- runExtensionList --tree (T2 PR 4) ------------

describe("runExtensionList --tree (T2 PR 4)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("--tree fetches per-extension info and renders via renderTree", async () => {
    // extension.list → 2 rows; then extension.info for each row
    const { client, calls } = createMockIpcClient([
      {
        extensions: [
          { id: "ext-a", version: "1.0.0", enabled: 1 },
          { id: "ext-b", version: "2.0.0", enabled: 1 },
        ],
      },
      // extension.info for ext-a
      { extension: { forwardDeps: [{ id: "ext-b", range: "^2.0.0" }] } },
      // extension.info for ext-b
      { extension: { forwardDeps: [] } },
    ]);
    await runExtensionList(client, ["list", "--tree"]);
    // Should have made 3 calls: list + 2 info
    expect(calls.length).toBe(3);
    expect(calls[0]?.method).toBe("extension.list");
    expect(calls[1]?.method).toBe("extension.info");
    expect(calls[2]?.method).toBe("extension.info");
    // renderTree output should contain both extension ids
    expect(out.stdout).toContain("ext-a");
    expect(out.stdout).toContain("ext-b");
  });

  test("--tree falls back to leaf node when extension.info throws", async () => {
    const { client } = createMockIpcClient([
      { extensions: [{ id: "ext-z", version: "0.1.0", enabled: 1 }] },
      // extension.info throws
      new Error("info unavailable"),
    ]);
    // Should not throw — best-effort leaf rendering
    await runExtensionList(client, ["list", "--tree"]);
    expect(out.stdout).toContain("ext-z");
  });
});
