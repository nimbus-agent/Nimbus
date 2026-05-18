/**
 * Unit tests for `nimbus extension` per-subcommand handlers.
 *
 * Each handler is exercised with a hand-rolled `IPCClient`-shaped mock so the
 * tests run in-process and do not touch the gateway socket. Coverage targets
 * the success path + IPC-error path for every public helper.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";

// `@clack/prompts.confirm` is replaced per-test for the interactive
// install / remove paths. The default mock returns `true` so a TTY-shaped
// process flows through approval; `false` simulates rejection. Tests
// override the default before importing the module under test.
let nextConfirmAnswer: boolean | symbol = true;
const cancelSymbol = Symbol.for("clack:cancel");
mock.module("@clack/prompts", () => ({
  confirm: async () => nextConfirmAnswer,
  isCancel: (v: unknown) => v === cancelSymbol,
}));

// Mock the gateway-process loader so the top-level `runExtension`
// dispatcher can be invoked without a real Gateway socket. Default:
// returns `undefined` so the dispatcher's "Gateway is not running"
// guard fires (covers lines 207-209).
let nextGatewayState: { socketPath: string } | undefined;
mock.module("../lib/gateway-process.ts", () => ({
  readGatewayState: async () => nextGatewayState,
}));

afterAll(() => {
  // Reset to sane defaults to avoid leaking into adjacent CLI tests in
  // the same `bun test` invocation.
  nextConfirmAnswer = true;
  nextGatewayState = undefined;
});

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

type CallRecord = { method: string; params: unknown };

function mockClient(responses: ReadonlyArray<unknown | Error>): {
  client: IPCClient;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  let i = 0;
  const client = {
    call: async <T>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params });
      const r = responses[i++];
      if (r instanceof Error) throw r;
      return r as T;
    },
  };
  return { client: client as unknown as IPCClient, calls };
}

const origLog = console.log;
let captured: string[] = [];

beforeEach(() => {
  captured = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
});

afterEach(() => {
  console.log = origLog;
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
  test("returns platform_capabilities when present", async () => {
    const { client } = mockClient([
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    const out = await fetchSandboxPosture(client);
    expect(out).toEqual({ network: "per_host", reason: null });
  });

  test("returns null when sandbox key missing", async () => {
    const { client } = mockClient([{ unrelated: true }]);
    expect(await fetchSandboxPosture(client)).toBeNull();
  });

  test("returns null when diag.snapshot throws", async () => {
    const { client } = mockClient([new Error("boom")]);
    expect(await fetchSandboxPosture(client)).toBeNull();
  });
});

// ----------------------------- runExtensionList ---------------------------

describe("runExtensionList", () => {
  test("prints (no extensions installed) when list empty", async () => {
    const { client, calls } = mockClient([{ extensions: [] }]);
    await runExtensionList(client, ["list"]);
    expect(calls[0]?.method).toBe("extension.list");
    expect(calls[0]?.params).toEqual({});
    expect(captured.some((l) => l.includes("(no extensions installed)"))).toBe(true);
  });

  test("renders tabular rows + preserves [needs-reinstall] annotation lines", async () => {
    const { client } = mockClient([
      {
        extensions: [
          { id: "a.b", version: "1.0.0", enabled: 1 },
          { id: "c.d", version: "2.0.0", enabled: 0 },
          { id: "e.f", version: "3.0.0", enabled: 1, needs_reinstall: true },
        ],
      },
    ]);
    await runExtensionList(client, ["list"]);
    const out = captured.join("\n");
    // New tabular format: ID | Version | Publisher | Status
    expect(out).toMatch(/ID\s+Version\s+Publisher\s+Status/);
    expect(out).toContain("a.b");
    expect(out).toContain("1.0.0");
    expect(out).toContain("c.d");
    expect(out).toContain("disabled");
    expect(out).toContain("(unverified)");
    // needs-reinstall annotation lines are preserved for grep-based scripts.
    expect(out).toContain("e.f@3.0.0 [needs-reinstall]");
  });

  test("--filter is forwarded as params.filter", async () => {
    const { client, calls } = mockClient([{ extensions: [] }]);
    await runExtensionList(client, ["list", "--filter", "needs-reinstall"]);
    expect(calls[0]?.params).toEqual({ filter: "needs-reinstall" });
  });

  test("--json prints the raw envelope", async () => {
    const envelope = { extensions: [{ id: "x", version: "1", enabled: 1 }] };
    const { client } = mockClient([envelope]);
    await runExtensionList(client, ["list", "--json"]);
    expect(captured.join("\n")).toBe(JSON.stringify(envelope, undefined, 2));
  });

  test("propagates IPC errors", async () => {
    const { client } = mockClient([new Error("ipc down")]);
    await expect(runExtensionList(client, ["list"])).rejects.toThrow(/ipc down/);
  });
});

// ----------------------------- runExtensionInfo ---------------------------

describe("runExtensionInfo", () => {
  test("throws when id missing", async () => {
    const { client } = mockClient([]);
    await expect(runExtensionInfo(client, [], [])).rejects.toThrow(/extension info/);
  });

  test("prints labelled lines for the extension + sandbox cap", async () => {
    const { client } = mockClient([
      { extension: { id: "ext1", version: "1.2.3", enabled: 1 } },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext1"], ["info", "ext1"]);
    const out = captured.join("\n");
    expect(out).toContain("Extension: ext1");
    expect(out).toContain("Version:   1.2.3");
    expect(out).toContain("Enabled:   yes");
    expect(out).toContain("Network isolation: per-host");
  });

  test("appends message when needs_reinstall is true", async () => {
    const { client } = mockClient([
      {
        extension: { id: "ext2", version: "0.1", enabled: 0, needs_reinstall: true },
        message: "Please reinstall this extension.",
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext2"], ["info", "ext2"]);
    expect(captured.join("\n")).toContain("Please reinstall this extension.");
    expect(captured.join("\n")).toContain("Enabled:   no");
  });

  test("--json prints combined envelope", async () => {
    const { client } = mockClient([
      { extension: { id: "ext3", version: "1.0", enabled: 1 } },
      { sandbox: { platform_capabilities: { network: "all_or_nothing", reason: "no bwrap" } } },
    ]);
    await runExtensionInfo(client, ["ext3"], ["info", "ext3", "--json"]);
    const parsed = JSON.parse(captured.join("\n"));
    expect(parsed.extension.id).toBe("ext3");
    expect(parsed.sandbox.platform_capabilities.network).toBe("all_or_nothing");
  });

  test("--json still prints when sandbox posture is null", async () => {
    const { client } = mockClient([
      { extension: { id: "ext4", version: "1.0", enabled: 1 } },
      new Error("diag failed"),
    ]);
    await runExtensionInfo(client, ["ext4"], ["info", "ext4", "--json"]);
    const parsed = JSON.parse(captured.join("\n"));
    expect(parsed.sandbox).toBeNull();
  });

  test("propagates IPC errors on extension.info", async () => {
    const { client } = mockClient([new Error("not found")]);
    await expect(runExtensionInfo(client, ["missing"], ["info", "missing"])).rejects.toThrow(
      /not found/,
    );
  });
});

// ----------------------------- runExtensionInstall ------------------------

describe("runExtensionInstall", () => {
  const origIsTty = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: origIsTty,
    });
  });

  test("throws when source path missing", async () => {
    const { client } = mockClient([]);
    await expect(runExtensionInstall(client, ["install"], [])).rejects.toThrow(/extension install/);
  });

  test("refuses install without --yes in non-TTY mode", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client } = mockClient([]);
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
    const { client, calls } = mockClient([installed]);
    await runExtensionInstall(client, ["install", "./ext", "--yes"], ["./ext"]);
    expect(calls[0]?.method).toBe("extension.install");
    const out = captured.join("\n");
    expect(out).toContain("new.ext");
    expect(out).toContain("/somewhere");
  });

  test("propagates IPC errors with --yes", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client } = mockClient([new Error("install denied")]);
    await expect(
      runExtensionInstall(client, ["install", "./ext", "--yes"], ["./ext"]),
    ).rejects.toThrow(/install denied/);
  });

  test("-y short flag is honoured", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client, calls } = mockClient([{ id: "x", version: "1", installPath: "/p" }]);
    await runExtensionInstall(client, ["install", "./ext", "-y"], ["./ext"]);
    expect(calls.length).toBe(1);
  });

  test("TTY mode with confirm-true completes install", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    nextConfirmAnswer = true;
    const { client, calls } = mockClient([{ id: "ext", version: "1", installPath: "/p" }]);
    await runExtensionInstall(client, ["install", "./ext"], ["./ext"]);
    expect(calls.length).toBe(1);
  });

  test("TTY mode with confirm-false aborts install (prints Cancelled)", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    nextConfirmAnswer = false;
    const { client, calls } = mockClient([]);
    await runExtensionInstall(client, ["install", "./ext"], ["./ext"]);
    expect(calls.length).toBe(0);
    expect(captured.join("\n")).toContain("Cancelled.");
  });

  test("TTY mode with isCancel symbol aborts install", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    nextConfirmAnswer = cancelSymbol;
    const { client, calls } = mockClient([]);
    await runExtensionInstall(client, ["install", "./ext"], ["./ext"]);
    expect(calls.length).toBe(0);
  });
});

// ----------------------------- enable / disable ---------------------------

describe("runExtensionEnable", () => {
  test("throws on missing id", async () => {
    const { client } = mockClient([]);
    await expect(runExtensionEnable(client, [])).rejects.toThrow(/extension enable/);
  });

  test("happy path prints ok envelope", async () => {
    const { client, calls } = mockClient([{ ok: true }]);
    await runExtensionEnable(client, ["my.ext"]);
    expect(calls[0]?.method).toBe("extension.enable");
    expect(calls[0]?.params).toEqual({ id: "my.ext" });
    expect(captured.join("\n")).toContain('"ok": true');
  });

  test("propagates IPC errors", async () => {
    const { client } = mockClient([new Error("unknown extension")]);
    await expect(runExtensionEnable(client, ["bogus"])).rejects.toThrow(/unknown extension/);
  });
});

describe("runExtensionDisable", () => {
  test("throws on missing id", async () => {
    const { client } = mockClient([]);
    await expect(runExtensionDisable(client, [])).rejects.toThrow(/extension disable/);
  });

  test("happy path prints ok envelope", async () => {
    const { client, calls } = mockClient([{ ok: true }]);
    await runExtensionDisable(client, ["my.ext"]);
    expect(calls[0]?.method).toBe("extension.disable");
    expect(calls[0]?.params).toEqual({ id: "my.ext" });
  });

  test("propagates IPC errors", async () => {
    const { client } = mockClient([new Error("disable failed")]);
    await expect(runExtensionDisable(client, ["x"])).rejects.toThrow(/disable failed/);
  });
});

// ----------------------------- runExtensionRemove -------------------------

describe("runExtensionRemove", () => {
  const origIsTty = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: origIsTty,
    });
  });

  test("throws on missing id", async () => {
    const { client } = mockClient([]);
    await expect(runExtensionRemove(client, ["remove"], [])).rejects.toThrow(/extension remove/);
  });

  test("refuses to remove without --yes in non-TTY mode", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client } = mockClient([]);
    await expect(runExtensionRemove(client, ["remove", "my.ext"], ["my.ext"])).rejects.toThrow(
      /Refusing to remove without confirmation/,
    );
  });

  test("--yes happy path prints ok envelope", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client, calls } = mockClient([{ ok: true }]);
    await runExtensionRemove(client, ["remove", "my.ext", "--yes"], ["my.ext"]);
    expect(calls[0]?.method).toBe("extension.remove");
    expect(calls[0]?.params).toEqual({ id: "my.ext" });
  });

  test("propagates IPC errors with --yes", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client } = mockClient([new Error("remove failed")]);
    await expect(
      runExtensionRemove(client, ["remove", "my.ext", "--yes"], ["my.ext"]),
    ).rejects.toThrow(/remove failed/);
  });

  test("-y short flag also bypasses prompt", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client, calls } = mockClient([{ ok: true }]);
    await runExtensionRemove(client, ["remove", "x", "-y"], ["x"]);
    expect(calls.length).toBe(1);
  });

  test("TTY mode with confirm-true completes removal", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    nextConfirmAnswer = true;
    const { client, calls } = mockClient([{ ok: true }]);
    await runExtensionRemove(client, ["remove", "my.ext"], ["my.ext"]);
    expect(calls.length).toBe(1);
  });

  test("TTY mode with confirm-false aborts removal (prints Cancelled)", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    nextConfirmAnswer = false;
    const { client, calls } = mockClient([]);
    await runExtensionRemove(client, ["remove", "my.ext"], ["my.ext"]);
    expect(calls.length).toBe(0);
    expect(captured.join("\n")).toContain("Cancelled.");
  });
});

// ----------------------------- runExtension (top-level dispatcher) ----------

describe("runExtension top-level dispatcher", () => {
  test("throws when gateway state is unreadable", async () => {
    nextGatewayState = undefined;
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

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: origIsTty,
    });
  });

  test("forwards --publisher-key path through to extension.install IPC params", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client, calls } = mockClient([{ id: "ext-a", version: "1.0.0", installPath: "/p" }]);
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
    const { client, calls } = mockClient([{ id: "ext-a", version: "1.0.0", installPath: "/p" }]);
    await runExtensionInstall(client, ["install", "/path/to/ext", "--yes"], ["/path/to/ext"]);
    expect(calls[0]?.method).toBe("extension.install");
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params["publisherKeyPath"]).toBeUndefined();
  });
});

// ----------------------------- formatExtensionListTable (T2 PR 2) ----------

describe("formatExtensionListTable (T2 PR 2)", () => {
  test("renders header with ID | Version | Publisher | Status", () => {
    const out = formatExtensionListTable(
      [
        { id: "ext-a", version: "1.0.0", enabled: 1, publisher: { id: "pub-a", key: "AAA" } },
        { id: "ext-b", version: "0.5.1", enabled: 1 },
      ],
      { isTty: false, noColor: true },
    );
    expect(out).toMatch(/ID\s+Version\s+Publisher\s+Status/);
    expect(out).toContain("ext-a");
    expect(out).toContain("pub-a");
    expect(out).toContain("(unverified)");
  });

  test("(unverified) is wrapped in ANSI dim-yellow on TTY with NO_COLOR unset", () => {
    const out = formatExtensionListTable([{ id: "ext-b", version: "0.5.1", enabled: 1 }], {
      isTty: true,
      noColor: false,
    });
    // ESC = U+001B; build via String.fromCharCode so the literal regex doesn't
    // carry a control character (Biome `noControlCharactersInRegex`).
    const ESC = String.fromCharCode(27);
    expect(out).toMatch(new RegExp(`${ESC}\\[2;33m\\(unverified\\)\\s*${ESC}\\[0m`));
  });

  test("NO_COLOR=1 (noColor=true) disables ANSI codes even on TTY", () => {
    const out = formatExtensionListTable([{ id: "ext-b", version: "0.5.1", enabled: 1 }], {
      isTty: true,
      noColor: true,
    });
    const ESC = String.fromCharCode(27);
    expect(out).not.toMatch(new RegExp(`${ESC}\\[`));
  });

  test("disabled row shows 'disabled' in Status column", () => {
    const out = formatExtensionListTable([{ id: "ext-c", version: "1.0.0", enabled: 0 }], {
      isTty: false,
      noColor: true,
    });
    expect(out).toContain("disabled");
  });
});

// ----------------------------- formatExtensionInfoHuman (T2 PR 2) ----------

describe("formatExtensionInfoHuman (T2 PR 2)", () => {
  test("shows Publisher section with id + truncated key for signed extensions", () => {
    const out = formatExtensionInfoHuman({
      id: "ext-a",
      version: "1.0.0",
      publisher: { id: "pub-a", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    });
    expect(out).toMatch(/Publisher:\s+pub-a/);
    expect(out).toContain("AAAAAAAAAAAAAAAA…");
  });

  test("shows (unverified) for unsigned extensions", () => {
    const out = formatExtensionInfoHuman({ id: "ext-b", version: "0.5.1" });
    expect(out).toMatch(/Publisher:\s+\(unverified\)/);
  });
});

// ----------------------------- runExtensionInfo --json (T2 PR 2) ----------

describe("runExtensionInfo publisher (T2 PR 2)", () => {
  test("human output includes Publisher section with truncated key", async () => {
    const fullKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const { client } = mockClient([
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
    const out = captured.join("\n");
    expect(out).toMatch(/Publisher:\s+pub-a/);
    expect(out).toContain("AAAAAAAAAAAAAAAA…");
    // Truncated, not full
    expect(out).not.toContain(fullKey);
  });

  test("human output shows (unverified) when publisher absent", async () => {
    const { client } = mockClient([
      { extension: { id: "ext-b", version: "0.5.1", enabled: 1 } },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-b"], ["info", "ext-b"]);
    expect(captured.join("\n")).toMatch(/Publisher:\s+\(unverified\)/);
  });

  test("--json output includes full publisher.key (not truncated)", async () => {
    const fullKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const { client } = mockClient([
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
    const parsed = JSON.parse(captured.join("\n")) as {
      extension: { publisher: { id: string; key: string } };
    };
    expect(parsed.extension.publisher.id).toBe("pub-a");
    expect(parsed.extension.publisher.key).toBe(fullKey);
  });
});
