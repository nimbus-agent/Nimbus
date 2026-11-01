import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  parseExtensionManifestForRegistry,
  publisherKeyFingerprint,
} from "@nimbus-dev/registry-format";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import {
  decodeBase64,
  encodeBase64,
  generateEd25519Keypair,
  verifyManifestSignature,
} from "../lib/extension-signing.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import type { AvailableUpdateCli, CredentialCliIo, UpdateApplyResultCli } from "./extension.ts";

const extensionMod = await import("./extension.ts");
const {
  fetchSandboxPosture,
  formatEnabledLine,
  formatBlockLines,
  formatRunLine,
  formatExtensionInfoHuman,
  formatExtensionListTable,
  hasFlag,
  runExtension,
  runExtensionApprove,
  runExtensionCredential,
  runExtensionDisable,
  runExtensionEnable,
  runExtensionInfo,
  runExtensionInstall,
  runExtensionKeygen,
  runExtensionList,
  runExtensionRehash,
  runExtensionRemove,
  runExtensionRevoke,
  runExtensionSign,
  runExtensionUpdateWithCaller,
  runExtensionDowngradeWithCaller,
  runExtensionDowngrade,
  runExtensionUpdate,
  rpcTimeoutForExtensionSub,
  stripFlags,
  takeFlagValue,
} = extensionMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
  // This file redefines process.stdout.isTTY many times via Object.defineProperty.
  // Reset it to the writable non-TTY default so the pollution can't leak into other
  // test files in the combined `bun test packages/cli/src` run (it was breaking the
  // query non-TTY tests on Linux/macOS).
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    writable: true,
    value: undefined,
  });
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
    // `approve --model <id>` must not send "--model" as the id.
    expect(stripFlags(["--model", "a.b"])).toEqual(["a.b"]);
    expect(stripFlags(["a.b", "--model"])).toEqual(["a.b"]);
    // `remove --clean-deps <id>` must not send "--clean-deps" as the id.
    expect(stripFlags(["--clean-deps", "pack"])).toEqual(["pack"]);
  });
  test("removes --filter + value pair", () => {
    expect(stripFlags(["info", "--filter", "needs-reinstall", "id"])).toEqual(["info", "id"]);
  });
  test("removes --publisher-key + value pair", () => {
    expect(stripFlags(["install", "/p", "--publisher-key", "/tmp/k"])).toEqual(["install", "/p"]);
  });
  test("stripFlags keeps the id when --registry and --version precede it", () => {
    expect(stripFlags(["info", "--registry", "main", "--version", "1.0.0", "acme.tool"])).toEqual([
      "info",
      "acme.tool",
    ]);
    expect(
      stripFlags(["install", "--channel", "beta", "--to", "2.0.0", "--remote", "a.b"]),
    ).toEqual(["install", "a.b"]);
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
    expect(out.stdout).toContain("(unsigned)");
    expect(out.stdout).toContain("e.f@3.0.0 [needs-reinstall]");
  });

  test("annotates a signature-disabled row with its reason, distinctly from needs-reinstall", async () => {
    const { client } = createMockIpcClient([
      {
        extensions: [
          { id: "a.b", version: "1.0.0", enabled: 0 },
          { id: "c.d", version: "2.0.0", enabled: 1, needs_reinstall: true },
          {
            id: "e.f",
            version: "3.0.0",
            enabled: 0,
            signature_disabled: true,
            disabled_reason: "signature_failed",
          },
        ],
      },
    ]);
    await runExtensionList(client, ["list"]);
    expect(out.stdout).toContain("c.d@2.0.0 [needs-reinstall]");
    expect(out.stdout).toContain("e.f@3.0.0 [signature: signature_failed]");
    // The plainly-disabled row gets no annotation line at all — that is the contrast the whole
    // feature exists to draw.
    expect(out.stdout).not.toContain("a.b@1.0.0 [");
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

const REQ = {
  connector: "github",
  state: "not_connected",
  owner: { kind: "bundled" },
  fix: ["nimbus connector auth github"],
  interactive: false,
  requiredBy: [],
};

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

  test("asks extension.info for connector requirements", async () => {
    const { client, calls } = createMockIpcClient([
      { extension: { id: "ext1", version: "1.2.3", enabled: 1 } },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext1"], ["info", "ext1"]);
    expect(calls[0]).toEqual({
      method: "extension.info",
      params: { id: "ext1", includeRequires: true },
    });
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

  // The object the gateway test (`automation-rpc.test.ts`, "runs the self-write check") asserted.
  const GATEWAY_ACCESS = {
    networkReach: "network access to a.com",
    fileAccess:
      "reads none · writes /x/installed (can't run here: overlaps the extension's own files)",
    canRunHere: false,
    checked: true,
  };

  test("prints reach and files above the network isolation line, escaped", async () => {
    const { client } = createMockIpcClient([
      {
        extension: {
          id: "ext1",
          version: "1.2.3",
          enabled: 1,
          access: {
            ...GATEWAY_ACCESS,
            networkReach: "network access to a.com\u001b[2J\nFiles: forged",
          },
        },
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext1"], ["info", "ext1"]);
    const lines = out.stdout.split("\n");
    const reach = lines.findIndex((l) => l.startsWith("Reach on this machine: "));
    expect(reach).toBeGreaterThan(-1);
    expect(lines[reach]).not.toContain("\u001b");
    expect(lines.filter((l) => l.startsWith("Files: "))).toEqual([
      `Files: ${GATEWAY_ACCESS.fileAccess}`,
    ]);
    expect(lines.findIndex((l) => l.startsWith("Files: "))).toBe(reach + 1);
    expect(lines[reach + 2]).toContain("Network isolation: per-host");
  });

  test("an older gateway sends no access and no reach line prints", async () => {
    const { client } = createMockIpcClient([
      { extension: { id: "ext1", version: "1.2.3", enabled: 1 } },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext1"], ["info", "ext1"]);
    expect(out.stdout).not.toContain("Reach on this machine");
    expect(out.stdout).not.toContain("Files:");
  });

  test("prints Requires: with the requirement lines when the extension has some", async () => {
    const { client } = createMockIpcClient([
      { extension: { id: "ext5", version: "1.0", enabled: 1, requires: [REQ] } },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext5"], ["info", "ext5"]);
    expect(out.stdout).toContain(
      "Requires:\n  github: not connected — run: nimbus connector auth github",
    );
  });

  test("prints no Requires: block when there is none", async () => {
    const { client } = createMockIpcClient([
      { extension: { id: "ext6", version: "1.0", enabled: 1, requires: [] } },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext6"], ["info", "ext6"]);
    expect(out.stdout).not.toContain("Requires:");
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
    await expect(runExtensionInstall(client, ["install", "."], ["."])).rejects.toThrow(
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
    await runExtensionInstall(client, ["install", ".", "--yes"], ["."]);
    expect(calls[0]?.method).toBe("extension.install");
    expect(out.stdout).toContain("new.ext");
    expect(out.stdout).toContain("/somewhere");
  });

  test("a local install prints Needs: before the JSON when the result carries requirements", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const { client } = createMockIpcClient([
      { id: "new.ext", version: "1.0.0", installPath: "/somewhere", connectorRequirements: [REQ] },
    ]);
    await runExtensionInstall(client, ["install", ".", "--yes"], ["."]);
    const needs = out.stdout.indexOf(
      "Needs:\n  github: not connected — run: nimbus connector auth github",
    );
    expect(needs).toBe(0);
  });

  test("propagates IPC errors with --yes", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client } = createMockIpcClient([new Error("install denied")]);
    await expect(runExtensionInstall(client, ["install", ".", "--yes"], ["."])).rejects.toThrow(
      /install denied/,
    );
  });

  test("-y short flag is honoured", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const { client, calls } = createMockIpcClient([{ id: "x", version: "1", installPath: "/p" }]);
    await runExtensionInstall(client, ["install", ".", "-y"], ["."]);
    expect(calls).toHaveLength(1);
  });

  test("TTY mode answers the GATEWAY's prompt interactively — no client-side confirm first", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    const handlers = new Map<string, (params: unknown) => void>();
    const { client, calls } = createMockIpcClient(
      [{ id: "ext", version: "1", installPath: "/p" }],
      handlers,
    );
    await runExtensionInstall(client, ["install", "."], ["."]);
    expect(calls.map((c) => c.method)).toEqual(["extension.install"]);
    expect(handlers.has("consent.request")).toBe(true);
  });

  test("--yes approves the gateway's prompt on the owner's behalf", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const handlers = new Map<string, (params: unknown) => void>();
    const { client, calls, emit } = createMockIpcClient(
      [{ id: "ext", version: "1", installPath: "/p" }, {}],
      handlers,
    );
    await runExtensionInstall(client, ["install", ".", "--yes"], ["."]);
    emit("consent.request", { requestId: "r-1", prompt: "Type: extension.install" });
    await Bun.sleep(0);
    expect(calls[1]).toEqual({
      method: "consent.respond",
      params: { requestId: "r-1", approved: true },
    });
  });
});

describe("runExtensionInstall — path versus registry id", () => {
  const origIsTty = process.stdout.isTTY;
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: origIsTty });
  });

  test("install arg that looks like a path but does not exist reports a missing path", async () => {
    const { client, calls } = createMockIpcClient([]);
    for (const arg of ["./nope-ext", "../nope-ext", "~/nope-ext", "/nope/ext", "C:nope", "a\\b"]) {
      await expect(runExtensionInstall(client, ["install", arg], [arg])).rejects.toThrow(
        `no such file or directory: ${arg}`,
      );
    }
    expect(calls).toHaveLength(0);
  });

  test("--registry with an existing path is refused", async () => {
    const { client, calls } = createMockIpcClient([]);
    await expect(
      runExtensionInstall(client, ["install", ".", "--registry", "main"], ["."]),
    ).rejects.toThrow(/--registry applies to a registry install/);
    await expect(
      runExtensionInstall(client, ["install", ".", "--version", "1.0.0"], ["."]),
    ).rejects.toThrow(/--version applies to a registry install/);
    await expect(
      runExtensionInstall(
        client,
        ["install", ".", "--accept-publisher-key", "b".repeat(32)],
        ["."],
      ),
    ).rejects.toThrow(/--accept-publisher-key applies to a registry install/);
    expect(calls).toHaveLength(0);
  });

  test("an id goes to registry.install with its flags, answered by the interactive prompt", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const handlers = new Map<string, (params: unknown) => void>();
    const { client, calls } = createMockIpcClient(
      [
        {
          id: "acme.tool",
          version: "1.0.0",
          sourceRegistry: "main",
          rootFingerprint: "r".repeat(32),
          publisher: { id: "acme", fingerprint: "p".repeat(32) },
          installPath: "/p",
        },
      ],
      handlers,
    );
    await runExtensionInstall(
      client,
      [
        "install",
        "acme.tool",
        "--registry",
        "main",
        "--version",
        "1.0.0",
        "--channel",
        "beta",
        "--accept-publisher-key",
        "b".repeat(32),
      ],
      ["acme.tool"],
    );
    expect(calls).toEqual([
      {
        method: "registry.install",
        params: {
          id: "acme.tool",
          registry: "main",
          version: "1.0.0",
          channel: "beta",
          acceptPublisherKey: "b".repeat(32),
        },
      },
    ]);
    expect(handlers.has("consent.request")).toBe(true);
    expect(out.stdout).toContain(
      `installed acme.tool@1.0.0 from registry main (root ${"r".repeat(32)}), publisher acme (${"p".repeat(32)})`,
    );
  });

  test("a registry install prints Needs: after the approve line, before the JSON", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const { client } = createMockIpcClient([
      {
        id: "acme.tool",
        version: "1.0.0",
        sourceRegistry: "main",
        installPath: "/p",
        connectorRequirements: [REQ],
      },
    ]);
    await runExtensionInstall(client, ["install", "acme.tool"], ["acme.tool"]);
    const text = out.stdout;
    const approve = text.indexOf("Nothing runs until you approve it");
    const needs = text.indexOf(
      "Needs:\n  github: not connected — run: nimbus connector auth github",
    );
    expect(approve).toBeGreaterThanOrEqual(0);
    expect(needs).toBeGreaterThan(approve);
    expect(text.indexOf("{", needs)).toBeGreaterThan(needs);
  });

  test("a registry install with no requirements prints no Needs:", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const { client } = createMockIpcClient([
      { id: "acme.tool", version: "1.0.0", sourceRegistry: "main", installPath: "/p" },
    ]);
    await runExtensionInstall(client, ["install", "acme.tool"], ["acme.tool"]);
    expect(out.stdout).not.toContain("Needs:");
  });

  test("a registry install without a TTY still goes to the gateway prompt", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const { client, calls } = createMockIpcClient([
      { id: "acme.tool", version: "1.0.0", sourceRegistry: "main", installPath: "/p" },
    ]);
    await runExtensionInstall(client, ["install", "acme.tool"], ["acme.tool"]);
    expect(calls.map((c) => c.method)).toEqual(["registry.install"]);
  });

  test("prints each dependency and one approve hint", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const { client } = createMockIpcClient([
      {
        id: "com.example.tool",
        version: "2.0.0",
        sourceRegistry: "main",
        installPath: "/p",
        dependencies: [{ id: "com.example.dep", version: "1.2.0", registry: "main" }],
      },
    ]);
    await runExtensionInstall(client, ["install", "com.example.tool"], ["com.example.tool"]);
    expect(out.stdout).toContain(
      "  + com.example.dep@1.2.0 from registry main (installed as a dependency)",
    );
    expect(out.stdout).toContain(
      "Nothing runs until you approve it: nimbus extension approve com.example.dep && nimbus extension approve com.example.tool",
    );
  });

  test("prints the single approve hint with no dependencies", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const { client } = createMockIpcClient([
      {
        id: "com.example.tool",
        version: "2.0.0",
        sourceRegistry: "main",
        installPath: "/p",
        dependencies: [],
      },
    ]);
    await runExtensionInstall(client, ["install", "com.example.tool"], ["com.example.tool"]);
    expect(out.stdout).toContain(
      "Nothing runs until you approve it: nimbus extension approve com.example.tool",
    );
    expect(out.stdout).not.toContain("installed as a dependency");
  });

  test("--yes is refused for a registry install, before any call", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const { client, calls } = createMockIpcClient([]);
    await expect(
      runExtensionInstall(client, ["install", "acme.tool", "--yes"], ["acme.tool"]),
    ).rejects.toThrow(/--yes is not accepted for a registry install/);
    expect(calls).toHaveLength(0);
  });
});

describe("runExtensionRehash", () => {
  const origIsTty = process.stdout.isTTY;
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: origIsTty });
  });

  test("throws when the id is missing", async () => {
    const { client } = createMockIpcClient([]);
    await expect(runExtensionRehash(client, ["rehash"], [])).rejects.toThrow(/extension rehash/);
  });

  test("refuses without --yes in non-TTY mode, before any call", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const { client, calls } = createMockIpcClient([]);
    await expect(runExtensionRehash(client, ["rehash", "x"], ["x"])).rejects.toThrow(
      /Refusing to rehash without confirmation/,
    );
    expect(calls).toHaveLength(0);
  });

  test("--yes calls extension.rehash, answers the gateway prompt, and reports the adoption", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const handlers = new Map<string, (params: unknown) => void>();
    const { client, calls } = createMockIpcClient(
      [{ id: "x", treeDigest: "ab".repeat(32), changed: true }],
      handlers,
    );
    await runExtensionRehash(client, ["rehash", "x", "--yes"], ["x"]);
    expect(calls[0]).toEqual({ method: "extension.rehash", params: { id: "x" } });
    expect(handlers.has("consent.request")).toBe(true);
    expect(out.stdout).toContain("adopted tree digest");
  });

  test("an unchanged tree says so", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const { client } = createMockIpcClient([
      { id: "x", treeDigest: "cd".repeat(32), changed: false },
    ]);
    await runExtensionRehash(client, ["rehash", "x"], ["x"]);
    expect(out.stdout).toContain("unchanged");
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
  const origStdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  /** The remove offer needs both ends to be a terminal (attended). */
  function setStdinTty(value: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  }

  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: origIsTty,
    });
    if (origStdinTty === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdin, "isTTY", origStdinTty);
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
    expect(calls).toHaveLength(1);
  });

  test("TTY mode with confirm-true completes removal", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    setFixture({ clackAnswer: true });
    const { client, calls } = createMockIpcClient([{ ok: true }]);
    await runExtensionRemove(client, ["remove", "my.ext"], ["my.ext"]);
    expect(calls).toHaveLength(1);
  });

  test("TTY mode with confirm-false aborts removal (prints Cancelled)", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    setFixture({ clackAnswer: false });
    const { client, calls } = createMockIpcClient([]);
    await runExtensionRemove(client, ["remove", "my.ext"], ["my.ext"]);
    expect(calls).toHaveLength(0);
    expect(out.stdout).toContain("Cancelled.");
  });

  const orphaned = { ok: true, orphanedDependencies: ["inner", "code.a"] };
  const offer = "Also remove 2 package(s) installed only for pack: inner, code.a? [y/N] ";
  const kept =
    "Kept inner, code.a, installed only for pack; remove them with: nimbus extension remove inner && nimbus extension remove code.a";
  const mustNotAsk = {
    confirm: async (): Promise<boolean> => {
      throw new Error("must not ask");
    },
  };

  /** Runs `fn` with stderr captured; returns what it wrote. */
  async function withStderr(fn: () => Promise<void>): Promise<string> {
    const errs: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      errs.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      await fn();
    } finally {
      process.stderr.write = origWrite;
    }
    return errs.join("");
  }

  test("TTY: the offer answered yes removes each orphan in order, with no further offer", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    setStdinTty(true);
    setFixture({ clackAnswer: true });
    const questions: string[] = [];
    const { client, calls } = createMockIpcClient([
      orphaned,
      { ok: true, orphanedDependencies: ["ignored"] },
      { ok: true, orphanedDependencies: [] },
    ]);
    const err = await withStderr(() =>
      runExtensionRemove(client, ["remove", "pack"], ["pack"], {
        confirm: async (q) => {
          questions.push(q);
          return true;
        },
      }),
    );
    expect(questions).toEqual([offer]);
    expect(calls.map((c) => c.params)).toEqual([{ id: "pack" }, { id: "inner" }, { id: "code.a" }]);
    expect(err).toContain("Removed inner.");
    expect(err).toContain("Removed code.a.");
  });

  test("TTY: the offer answered no keeps the orphans and names them", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    setStdinTty(true);
    setFixture({ clackAnswer: true });
    const questions: string[] = [];
    const { client, calls } = createMockIpcClient([orphaned]);
    const err = await withStderr(() =>
      runExtensionRemove(client, ["remove", "pack"], ["pack"], {
        confirm: async (q) => {
          questions.push(q);
          return false;
        },
      }),
    );
    expect(questions).toEqual([offer]);
    expect(calls).toHaveLength(1);
    expect(err).toContain(kept);
  });

  test("stdout a TTY but stdin not: no offer, and the Kept line names the removals", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    setStdinTty(false);
    setFixture({ clackAnswer: true });
    const { client, calls } = createMockIpcClient([orphaned]);
    const err = await withStderr(() =>
      runExtensionRemove(client, ["remove", "pack"], ["pack"], mustNotAsk),
    );
    expect(calls).toHaveLength(1);
    expect(err).toContain(kept);
  });

  test("the default offer asks on stderr, so stdout stays JSON after a no", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    setFixture({ clackAnswer: true });
    const input = new Readable({ read() {} });
    Object.defineProperty(input, "isTTY", { configurable: true, value: true });
    const origStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: input, configurable: true });
    const rawStdout: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      rawStdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      const { client, calls } = createMockIpcClient([orphaned]);
      const err = await withStderr(async () => {
        const pending = runExtensionRemove(client, ["remove", "pack"], ["pack"]);
        setTimeout(() => input.push("n\n"), 10);
        await pending;
      });
      expect(calls).toHaveLength(1);
      expect(err).toContain(offer);
      expect(err).toContain(kept);
      expect(rawStdout.join("")).toBe("");
      expect(JSON.parse(out.stdout)).toEqual(orphaned);
    } finally {
      process.stdout.write = origStdoutWrite;
      Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
    }
  });

  test("TTY: --clean-deps keeps the removal's confirmation and removes the orphans without the offer", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    setFixture({ clackAnswer: true });
    const { client, calls } = createMockIpcClient([orphaned, { ok: true }, { ok: true }]);
    await withStderr(() =>
      runExtensionRemove(client, ["remove", "pack", "--clean-deps"], ["pack"], mustNotAsk),
    );
    expect(calls.map((c) => c.params)).toEqual([{ id: "pack" }, { id: "inner" }, { id: "code.a" }]);
  });

  test("TTY: --clean-deps with the removal declined removes nothing", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    setFixture({ clackAnswer: false });
    const { client, calls } = createMockIpcClient([]);
    await runExtensionRemove(client, ["remove", "pack", "--clean-deps"], ["pack"], mustNotAsk);
    expect(calls).toHaveLength(0);
    expect(out.stdout).toContain("Cancelled.");
  });

  test("TTY: no orphans asks nothing", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    setFixture({ clackAnswer: true });
    const { client, calls } = createMockIpcClient([{ ok: true, orphanedDependencies: [] }]);
    await runExtensionRemove(client, ["remove", "pack"], ["pack"], mustNotAsk);
    expect(calls).toHaveLength(1);
  });

  test("--yes --json without --clean-deps names the orphans on stderr; stdout stays JSON", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const { client, calls } = createMockIpcClient([orphaned]);
    const err = await withStderr(() =>
      runExtensionRemove(client, ["remove", "pack", "--yes", "--json"], ["pack"], mustNotAsk),
    );
    expect(calls).toHaveLength(1);
    expect(err).toContain(kept);
    expect(JSON.parse(out.stdout)).toEqual(orphaned);
  });

  test("--clean-deps --yes removes the orphans without asking, in a script; stdout stays JSON", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const { client, calls } = createMockIpcClient([orphaned, { ok: true }, { ok: true }]);
    const err = await withStderr(() =>
      runExtensionRemove(client, ["remove", "pack", "--yes", "--clean-deps"], ["pack"], mustNotAsk),
    );
    expect(calls.map((c) => c.params)).toEqual([{ id: "pack" }, { id: "inner" }, { id: "code.a" }]);
    expect(err).toContain("Removed code.a.");
    expect(JSON.parse(out.stdout)).toEqual(orphaned);
  });

  test("an orphan that fails to remove is reported, the rest still go, and the exit code is 1", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const { client, calls } = createMockIpcClient([
        orphaned,
        new Error("Extension not found"),
        { ok: true },
      ]);
      const err = await withStderr(() =>
        runExtensionRemove(client, ["remove", "pack", "--yes", "--clean-deps"], ["pack"]),
      );
      expect(calls.map((c) => c.params)).toEqual([
        { id: "pack" },
        { id: "inner" },
        { id: "code.a" },
      ]);
      expect(err).toContain("Could not remove inner: Extension not found");
      expect(err).toContain("Removed code.a.");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode ?? 0;
    }
  });

  test("every orphan removed leaves the exit code alone", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const { client } = createMockIpcClient([orphaned, { ok: true }, { ok: true }]);
      await withStderr(() =>
        runExtensionRemove(client, ["remove", "pack", "--yes", "--clean-deps"], ["pack"]),
      );
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = priorExitCode ?? 0;
    }
  });

  test("an older gateway's result without orphanedDependencies offers nothing", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const { client, calls } = createMockIpcClient([{ ok: true }]);
    const err = await withStderr(() =>
      runExtensionRemove(client, ["remove", "pack", "--yes", "--clean-deps"], ["pack"]),
    );
    expect(calls).toHaveLength(1);
    expect(err).not.toContain("Kept");
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

  test("publish --channel beta reaches runExtensionPublish intact", async () => {
    // `stripFlags` would drop `--channel <v>`; an invalid value proves the flag arrived, because
    // only runExtensionPublish itself can refuse it — before any git or network call.
    const origExit = process.exit.bind(process);
    const origErr = process.stderr.write.bind(process.stderr);
    const errChunks: string[] = [];
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? ""})`);
    }) as typeof process.exit;
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      errChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      await expect(
        runExtension([
          "publish",
          "ext-dir",
          "--registry-repo",
          "acme/registry",
          "--channel",
          "gamma",
        ]),
      ).rejects.toThrow("process.exit(2)");
      expect(errChunks.join("")).toContain("--channel must be stable or beta");
    } finally {
      process.exit = origExit;
      process.stderr.write = origErr;
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

  test("the removed 'sync' subcommand is refused with the usage text and calls nothing", async () => {
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
    await expect(runExtension(["sync"])).rejects.toThrow(/^Usage: nimbus extension/);
    expect(ipcCalls).toEqual([]);
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
      await runExtension(["install", ".", "--yes"]);
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

  test("dispatches 'report' through the gateway: extension.info, then registry.info for its source", async () => {
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "fake.sock" },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          ipcCalls.push({ method, params });
          if (method === "extension.info") {
            return { extension: { id: "acme/tool", version: "1.0.0", source_registry: "main" } };
          }
          if (method === "registry.info") return { reportUrl: "https://reports.example.com/form" };
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await runExtension(["report", "acme/tool"]);
    expect(ipcCalls.map((c) => c.method)).toEqual(["extension.info", "registry.info"]);
    expect(ipcCalls[1]?.params).toEqual({ id: "acme/tool", registry: "main", reportOnly: true });
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
      ["install", ".", "--publisher-key", "/tmp/pub.key", "--yes"],
      ["."],
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
    await runExtensionInstall(client, ["install", ".", "--yes"], ["."]);
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
    expect(formatted).toContain("(unsigned)");
  });

  test("a verified publisher is marked after its id (R6)", () => {
    const formatted = formatExtensionListTable(
      [
        {
          id: "ext-a",
          version: "1.0.0",
          enabled: 1,
          publisher: { id: "pub-a", key: "AAA" },
          verifiedPublisher: { github: "pub-dev", verifiedAt: "2026-10-20T00:00:00Z" },
        },
        { id: "ext-c", version: "1.0.0", enabled: 1, publisher: { id: "pub-c", key: "CCC" } },
      ],
      { isTty: false, noColor: true },
    );
    expect(formatted).toContain("pub-a ✓ @pub-dev");
    expect(formatted).not.toContain("pub-c ✓");
  });

  test("(unsigned) is wrapped in ANSI dim-yellow on TTY with NO_COLOR unset", () => {
    const formatted = formatExtensionListTable([{ id: "ext-b", version: "0.5.1", enabled: 1 }], {
      isTty: true,
      noColor: false,
    });
    const ESC = String.fromCodePoint(27);
    expect(formatted).toMatch(new RegExp(String.raw`${ESC}\[2;33m\(unsigned\)\s*${ESC}\[0m`));
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

describe("formatExtensionListTable — signature-disabled is distinguishable (I16)", () => {
  // The acceptance criterion for closing the I16 surfacing gap: a user must be able to tell
  // "I disabled this" from "this failed integrity verification at startup" without reading the
  // audit log. Both rows below are `enabled: 0`; the ONLY difference is signatureDisabled.
  const ROWS = [
    { id: "ext.manual", version: "1.0.0", enabled: 0 },
    { id: "ext.tampered", version: "2.0.0", enabled: 0, signatureDisabled: true },
  ] as const;

  test("the two disabled rows do not render the same Status", () => {
    const formatted = formatExtensionListTable([...ROWS], { isTty: false, noColor: true });
    const manual = formatted.split("\n").find((l) => l.startsWith("ext.manual")) ?? "";
    const tampered = formatted.split("\n").find((l) => l.startsWith("ext.tampered")) ?? "";
    expect(manual).not.toBe("");
    expect(tampered).not.toBe("");
    expect(manual.trimEnd().endsWith("disabled")).toBe(true);
    expect(tampered).toContain("disabled (signature)");
  });

  test("the publisher column is NOT the signal — an unsigned row is not signature-disabled", () => {
    // `(unsigned)` means "this manifest declares no publisher", which is the normal state of
    // every unsigned extension and says nothing about verification having FAILED. Conflating the
    // two would mark most of a healthy install red.
    const formatted = formatExtensionListTable(
      [{ id: "ext.manual", version: "1.0.0", enabled: 0 }],
      {
        isTty: false,
        noColor: true,
      },
    );
    expect(formatted).toContain("(unsigned)");
    expect(formatted).not.toContain("disabled (signature)");
  });

  test("signature-disabled status is ANSI red on a TTY and plain under NO_COLOR", () => {
    const ESC = String.fromCodePoint(27);
    const colored = formatExtensionListTable(
      [{ id: "ext.tampered", version: "2.0.0", enabled: 0, signatureDisabled: true }],
      { isTty: true, noColor: false },
    );
    expect(colored).toMatch(new RegExp(String.raw`${ESC}\[1;31mdisabled \(signature\)`));
    const plain = formatExtensionListTable(
      [{ id: "ext.tampered", version: "2.0.0", enabled: 0, signatureDisabled: true }],
      { isTty: true, noColor: true },
    );
    expect(plain).not.toMatch(new RegExp(String.raw`${ESC}\[`));
    expect(plain).toContain("disabled (signature)");
  });
});

describe("formatEnabledLine (I16)", () => {
  test("enabled reads 'yes'", () => {
    expect(formatEnabledLine({ enabled: 1 })).toBe("yes");
  });

  test("owner-disabled reads exactly 'no', with no reason invented", () => {
    expect(formatEnabledLine({ enabled: 0 })).toBe("no");
  });

  test("signature-disabled names the reason on the same line", () => {
    expect(
      formatEnabledLine({
        enabled: 0,
        signature_disabled: true,
        disabled_reason: "publisher_key_mismatch",
      }),
    ).toBe("no  (signature verification failed: publisher_key_mismatch)");
  });

  test("a signature_disabled row with no reason still says a check failed", () => {
    // Defensive: the gateway always sends both together, but printing a bare `no` here would
    // silently re-open the exact gap this closes.
    expect(formatEnabledLine({ enabled: 0, signature_disabled: true })).toBe(
      "no  (signature verification failed: unknown)",
    );
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

  test("shows (unsigned) for unsigned extensions", () => {
    const formatted = formatExtensionInfoHuman({ id: "ext-b", version: "0.5.1" });
    expect(formatted).toMatch(/Publisher:\s+\(unsigned\)/);
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

  test("human output shows (unsigned) when publisher absent", async () => {
    const { client } = createMockIpcClient([
      { extension: { id: "ext-b", version: "0.5.1", enabled: 1 } },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-b"], ["info", "ext-b"]);
    expect(out.stdout).toMatch(/Publisher:\s+\(unsigned\)/);
  });

  test("a signature-disabled extension says WHY next to Enabled: no", async () => {
    const { client } = createMockIpcClient([
      {
        extension: {
          id: "ext-tampered",
          version: "2.0.0",
          enabled: 0,
          signature_disabled: true,
          disabled_reason: "signature_failed",
          publisher: { id: "pub-a", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
        },
        message: "Extension ext-tampered v2.0.0 failed signature verification (signature_failed).",
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-tampered"], ["info", "ext-tampered"]);
    expect(out.stdout).toMatch(
      /Enabled:\s+no\s+\(signature verification failed: signature_failed\)/,
    );
    // The gateway's remediation text is printed verbatim rather than re-authored here — one
    // definition of the advice, in `hard-disable.ts`.
    expect(out.stdout).toContain("failed signature verification (signature_failed)");
  });

  test("a plainly-disabled extension says only 'no'", async () => {
    const { client } = createMockIpcClient([
      { extension: { id: "ext-off", version: "1.0.0", enabled: 0 } },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-off"], ["info", "ext-off"]);
    expect(out.stdout).toMatch(/Enabled:\s+no\s*\n/);
    expect(out.stdout).not.toContain("signature verification failed");
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
    expect(calls).toHaveLength(3);
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

  test("table row with publisher set renders publisher id (not (unsigned))", async () => {
    const { client } = createMockIpcClient([
      {
        extensions: [
          { id: "pub.ext", version: "2.0.0", enabled: 1, publisher: { id: "acme", key: "k" } },
        ],
      },
    ]);
    await runExtensionList(client, ["list"]);
    expect(out.stdout).toContain("acme");
    expect(out.stdout).not.toContain("(unsigned)");
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
// runExtensionInfo — publisher with no key string (the unsigned branch in print)
// ---------------------------------------------------------------------------
describe("runExtensionInfo — publisher without key", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("shows (unsigned) when publisher exists but key is not a string", async () => {
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
    expect(out.stdout).toContain("Publisher: (unsigned)");
  });

  test("a signed extension states whether its publisher is verified (R6)", async () => {
    const { client } = createMockIpcClient([
      {
        extension: {
          id: "ext-v",
          version: "1.0.0",
          enabled: 1,
          publisher: { id: "pub-a", key: "A".repeat(43) + "=" },
          verifiedPublisher: { github: "pub-dev", verifiedAt: "2026-10-20T00:00:00Z" },
        },
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    await runExtensionInfo(client, ["ext-v"], ["info", "ext-v"]);
    expect(out.stdout).toContain("Verified publisher: @pub-dev (verified 2026-10-20)");
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
      sourceRegistry: "main",
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
    expect(stdoutChunks.join("")).toContain("from main");
    expect(stdoutChunks.join("")).not.toContain("publisher key changed");
  });

  test("a publisher_key_conflict row carries a 'publisher key changed' marker", async () => {
    const stdoutChunks: string[] = [];
    await runExtensionUpdateWithCaller({
      args: [],
      caller: async () => [
        makeUpdate({ verificationStatus: "publisher_key_conflict", publisherStatus: "unverified" }),
      ],
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    expect(stdoutChunks.join("")).toBe(
      "ext-a\t1.0.0 → 1.1.0\t[stable]\tfrom main\tpublisher key changed\n",
    );
  });

  test("a row labels the SIGNATURE, and names a verified publisher when there is one (R6)", async () => {
    const stdoutChunks: string[] = [];
    await runExtensionUpdateWithCaller({
      args: [],
      caller: async () => [
        {
          ...makeUpdate(),
          verifiedPublisher: { github: "acme-dev", verifiedAt: "2026-10-20T00:00:00Z" },
        },
        makeUpdate({
          id: "ext-b",
          verificationStatus: "signature_failed",
          publisherStatus: "unverified",
        }),
      ],
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: () => {},
    });
    const out = stdoutChunks.join("");
    expect(out).toContain(
      "ext-a\t1.0.0 → 1.1.0\t[stable]\tfrom main\tsignature verified\t✓ @acme-dev\n",
    );
    expect(out).toContain("ext-b\t1.0.0 → 1.1.0\t[stable]\tfrom main\tsignature failed\n");
    expect(out).not.toContain("publisher: verified");
    expect(out).not.toMatch(/\tverified\t/);
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
      sourceRegistry: "main",
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

describe("runExtensionSign publisher key", () => {
  const root = mkdtempSync(join(tmpdir(), "nimbus-sign-pub-"));
  const makeKey = (): { path: string; pub: string } => {
    const { privkey, pubkey } = generateEd25519Keypair();
    const path = join(root, `key-${Math.random().toString(36).slice(2)}`);
    writeFileSync(path, encodeBase64(privkey));
    return { path, pub: encodeBase64(pubkey) };
  };
  const makeExt = (manifest: Record<string, unknown>): { dir: string; manifestPath: string } => {
    const dir = mkdtempSync(join(root, "ext-"));
    const manifestPath = join(dir, "nimbus.extension.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    return { dir, manifestPath };
  };
  const readManifest = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

  beforeEach(() => {
    out.reset();
  });

  test("fills publisher.key from the signing key, then signs a manifest the registry parser accepts", async () => {
    const key = makeKey();
    const { dir, manifestPath } = makeExt({
      id: "acme/echo",
      version: "0.1.0",
      publisher: { id: "acme" },
    });
    expect(await runExtensionSign([dir, "--key", key.path])).toBe(0);
    const written = readManifest(manifestPath);
    expect(written["publisher"]).toEqual({ id: "acme", key: key.pub });
    const { manifest } = parseExtensionManifestForRegistry(readFileSync(manifestPath, "utf8"));
    expect(manifest.publisher?.key).toBe(key.pub);
    await verifyManifestSignature(
      written as { publisher?: { id: string; key: string }; signature?: string },
      decodeBase64(key.pub),
    );
  });

  test("a matching publisher.key is left alone and signing succeeds", async () => {
    const key = makeKey();
    const { dir, manifestPath } = makeExt({
      id: "acme/echo",
      version: "0.1.0",
      publisher: { id: "acme", key: key.pub },
    });
    expect(await runExtensionSign([dir, "--key", key.path])).toBe(0);
    expect(readManifest(manifestPath)["publisher"]).toEqual({ id: "acme", key: key.pub });
    expect(typeof readManifest(manifestPath)["signature"]).toBe("string");
  });

  test("a differing publisher.key is refused with both fingerprints and the file untouched", async () => {
    const signing = makeKey();
    const other = makeKey();
    const { dir, manifestPath } = makeExt({
      id: "acme/echo",
      version: "0.1.0",
      publisher: { id: "acme", key: other.pub },
    });
    const before = readFileSync(manifestPath, "utf8");
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      expect(await runExtensionSign([dir, "--key", signing.path])).toBe(2);
    } finally {
      process.stderr.write = orig;
    }
    const msg = chunks.join("");
    expect(msg).toContain(publisherKeyFingerprint(other.pub));
    expect(msg).toContain(publisherKeyFingerprint(signing.pub));
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  test("a manifest with no publisher is signed as before, gaining no publisher", async () => {
    const key = makeKey();
    const { dir, manifestPath } = makeExt({ id: "plain.ext", version: "1.0.0" });
    expect(await runExtensionSign([dir, "--key", key.path])).toBe(0);
    const written = readManifest(manifestPath);
    expect(written["publisher"]).toBeUndefined();
    expect(typeof written["signature"]).toBe("string");
  });
});

describe("runExtensionApprove", () => {
  const origOut = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const origIn = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const restore = (
    s: NodeJS.ReadStream | NodeJS.WriteStream,
    d: PropertyDescriptor | undefined,
  ): void => {
    if (d === undefined) delete (s as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(s, "isTTY", d);
  };
  const setTty = (v: boolean): void => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: v });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: v });
  };
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    restore(process.stdout, origOut);
    restore(process.stdin, origIn);
  });

  test("throws when the id is missing", async () => {
    setTty(true);
    const { client } = createMockIpcClient([]);
    await expect(runExtensionApprove(client, ["approve"], [])).rejects.toThrow(
      /extension approve <id>/,
    );
  });

  test("refuses in non-TTY mode before any call — there is no --yes", async () => {
    setTty(false);
    const { client, calls } = createMockIpcClient([]);
    await expect(runExtensionApprove(client, ["approve", "x"], ["x"])).rejects.toThrow(
      /must be answered at a terminal/,
    );
    expect(calls).toHaveLength(0);
  });

  test("refuses --yes outright", async () => {
    setTty(true);
    const { client, calls } = createMockIpcClient([]);
    await expect(runExtensionApprove(client, ["approve", "x", "--yes"], ["x"])).rejects.toThrow(
      /no --yes/,
    );
    expect(calls).toHaveLength(0);
  });

  test("calls extension.approveRun, answers the prompt itself, and says how it starts", async () => {
    setTty(true);
    const handlers = new Map<string, (params: unknown) => void>();
    const { client, calls } = createMockIpcClient(
      [{ id: "x", serviceId: "ext_x", treeDigest: "ab".repeat(32), changed: true }],
      handlers,
    );
    await runExtensionApprove(client, ["approve", "x"], ["x"]);
    expect(calls[0]).toEqual({
      method: "extension.approveRun",
      params: { id: "x", modelAccess: false },
    });
    expect(handlers.has("consent.request")).toBe(true);
    expect(out.stdout).toContain("approved to run as ext_x");
    expect(out.stdout).not.toContain("Nothing runs it yet");
    expect(out.stdout).toContain("nimbus connector tools ext_x");
  });

  test("NIMBUS_SCRIPT_CONSENT_SOURCE cannot answer it", async () => {
    // `registerConsentFor({ kind: "prompt" })` would read this path at registration and throw
    // "script consent source not found". The prompt handler ignores it, so the call goes through.
    setTty(true);
    const prev = process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"];
    process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"] = join(tmpdir(), "nimbus-no-such-consent.jsonl");
    try {
      const { client, calls } = createMockIpcClient([
        { id: "x", serviceId: "ext_x", treeDigest: "ab".repeat(32), changed: true },
      ]);
      await runExtensionApprove(client, ["approve", "x"], ["x"]);
      expect(calls[0]?.method).toBe("extension.approveRun");
    } finally {
      if (prev === undefined) delete process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"];
      else process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"] = prev;
    }
  });

  test("an unchanged approval says so", async () => {
    setTty(true);
    const { client } = createMockIpcClient([
      { id: "x", serviceId: "ext_x", treeDigest: "ab".repeat(32), changed: false },
    ]);
    await runExtensionApprove(client, ["approve", "x"], ["x"]);
    expect(out.stdout).toContain("already approved");
  });

  test("--model, before or after the id, asks for model access and the output says it is on", async () => {
    setTty(true);
    for (const args of [
      ["approve", "--model", "a.b"],
      ["approve", "a.b", "--model"],
    ]) {
      out.reset();
      const { client, calls } = createMockIpcClient([
        {
          id: "a.b",
          serviceId: "ext_a_b",
          treeDigest: "ab".repeat(32),
          changed: true,
          modelAccess: true,
        },
      ]);
      await runExtensionApprove(client, args, stripFlags(args.slice(1)));
      expect(calls[0]).toEqual({
        method: "extension.approveRun",
        params: { id: "a.b", modelAccess: true },
      });
      expect(out.stdout).toContain("model access: on");
    }
  });

  test("an unchanged approval without --model says model access is off", async () => {
    setTty(true);
    const { client } = createMockIpcClient([
      {
        id: "x",
        serviceId: "ext_x",
        treeDigest: "ab".repeat(32),
        changed: false,
        modelAccess: false,
      },
    ]);
    await runExtensionApprove(client, ["approve", "x"], ["x"]);
    expect(out.stdout).toContain("already approved");
    expect(out.stdout).toContain("model access: off");
  });

  test("a missing id names the --model flag in the usage", async () => {
    setTty(true);
    const { client } = createMockIpcClient([]);
    await expect(runExtensionApprove(client, ["approve"], [])).rejects.toThrow(
      "Usage: nimbus extension approve <id> [--model]",
    );
  });

  describe("the extension's sync status", () => {
    const DIGEST = "ab".repeat(32);
    const APPROVED_LINE = `x: approved to run as ext_x (tree digest ${DIGEST}; model access: off). It starts on first use: \`nimbus connector tools ext_x\`.\n`;
    const approved = (syncServiceId?: string, changed = true): Record<string, unknown> => ({
      id: "x",
      serviceId: "ext_x",
      treeDigest: DIGEST,
      changed,
      modelAccess: false,
      ...(syncServiceId !== undefined && { syncServiceId }),
    });

    test("a paused sync says so, after the approval line", async () => {
      setTty(true);
      const { client, calls } = createMockIpcClient([
        approved("ext_x"),
        [{ serviceId: "ext_x", status: "paused", lastError: "sandbox helper missing" }],
      ]);
      await runExtensionApprove(client, ["approve", "x"], ["x"]);
      expect(calls[1]?.method).toBe("connector.listStatus");
      expect(out.stdout).toContain("approved to run as ext_x");
      expect(out.stdout).toContain("sync is paused: sandbox helper missing");
      expect(out.stdout).toBe(
        `${APPROVED_LINE}x: approved, but sync is paused: sandbox helper missing. Run \`nimbus connector status ext_x\` for details.\n`,
      );
    });

    test("an unchanged approval also says the sync is paused", async () => {
      setTty(true);
      const { client } = createMockIpcClient([
        approved("ext_x", false),
        [{ serviceId: "ext_x", healthState: "paused", lastError: null }],
      ]);
      await runExtensionApprove(client, ["approve", "x"], ["x"]);
      expect(out.stdout).toContain("already approved");
      expect(out.stdout).toContain(
        "x: approved, but sync is paused. Run `nimbus connector status ext_x` for details.",
      );
    });

    test("a bound extension's sync is read under its index id", async () => {
      setTty(true);
      const { client } = createMockIpcClient([
        { ...approved("readwise"), serviceId: "ext_readwise" },
        [
          { serviceId: "ext_readwise", status: "running" },
          { serviceId: "readwise", status: "paused", lastError: "no sandbox" },
        ],
      ]);
      await runExtensionApprove(client, ["approve", "x"], ["x"]);
      expect(out.stdout).toContain(
        "x: approved, but sync is paused: no sandbox. Run `nimbus connector status readwise` for details.",
      );
    });

    test("a running sync adds nothing", async () => {
      setTty(true);
      const { client, calls } = createMockIpcClient([
        approved("ext_x"),
        [{ serviceId: "ext_x", status: "ok" }],
      ]);
      await runExtensionApprove(client, ["approve", "x"], ["x"]);
      expect(calls).toHaveLength(2);
      expect(out.stdout).toBe(APPROVED_LINE);
    });

    test("no sync means no status call and the same output", async () => {
      setTty(true);
      const { client, calls } = createMockIpcClient([approved()]);
      await runExtensionApprove(client, ["approve", "x"], ["x"]);
      expect(calls).toHaveLength(1);
      expect(out.stdout).toBe(APPROVED_LINE);
    });

    test("a failing status read adds nothing and does not fail the approval", async () => {
      setTty(true);
      const { client, calls } = createMockIpcClient([
        approved("ext_x"),
        new Error("gateway went away"),
      ]);
      await runExtensionApprove(client, ["approve", "x"], ["x"]);
      expect(calls).toHaveLength(2);
      expect(out.stdout).toBe(APPROVED_LINE);
    });

    test("the paused reason is control-stripped", async () => {
      setTty(true);
      const { client } = createMockIpcClient([
        approved("ext_x"),
        [{ serviceId: "ext_x", status: "paused", lastError: "\u001b[31mred\u001b[0m reason" }],
      ]);
      await runExtensionApprove(client, ["approve", "x"], ["x"]);
      expect(out.stdout).toContain("sync is paused: ");
      expect(out.stdout).not.toContain("\u001b");
    });
  });
});

describe("runExtensionRevoke", () => {
  beforeEach(() => {
    out.reset();
  });

  test("throws when the id is missing", async () => {
    const { client } = createMockIpcClient([]);
    await expect(runExtensionRevoke(client, [])).rejects.toThrow(/extension revoke <id>/);
  });

  test("calls extension.revokeRun and reports both outcomes", async () => {
    const { client, calls } = createMockIpcClient([
      { id: "x", revoked: true },
      { id: "x", revoked: false },
    ]);
    await runExtensionRevoke(client, ["x"]);
    await runExtensionRevoke(client, ["x"]);
    expect(calls[0]).toEqual({ method: "extension.revokeRun", params: { id: "x" } });
    expect(out.stdout).toContain("run approval revoked");
    expect(out.stdout).toContain("had no run approval");
  });
});

describe("run state in human output", () => {
  test("the Run column appears only when rows carry a runState", () => {
    const withRun = formatExtensionListTable(
      [{ id: "ext-a", version: "1.0.0", enabled: 1, runState: "grant_stale" }],
      { isTty: false, noColor: true },
    );
    expect(withRun).toMatch(/ID\s+Version\s+Publisher\s+Status\s+Run/);
    expect(withRun).toContain("grant_stale");
    const without = formatExtensionListTable([{ id: "ext-a", version: "1.0.0", enabled: 1 }], {
      isTty: false,
      noColor: true,
    });
    expect(without).not.toMatch(/\bRun\b/);
  });

  test("formatBlockLines: a starter pack's blocks never suggest approving it", () => {
    const block = {
      statementId: "s1",
      kind: "extension.takedown",
      issuer: "nimbus",
      registry: null,
      reason: "malware",
      issuedAt: "2026-10-26T12:00:00Z",
    };
    const lines = formatBlockLines("acme.pack", [block], "starter-pack");
    expect(lines).toHaveLength(1);
    expect(lines.join(" ")).not.toContain("approve");
    expect(formatBlockLines("acme.tool", [block], "extension").at(-1)).toContain(
      "nimbus extension approve acme.tool",
    );
  });

  test("formatBlockLines (I48): one line per block, issuer named, the override last", () => {
    expect(formatBlockLines("a", [])).toEqual([]);
    const lines = formatBlockLines("acme.tool", [
      {
        statementId: "s1",
        kind: "key.revoke",
        issuer: "nimbus",
        registry: null,
        reason: "leaked[2J",
        issuedAt: "2026-10-26T12:00:00Z",
      },
      {
        statementId: "s2",
        kind: "extension.takedown",
        issuer: "registry",
        registry: "community",
        reason: "malware",
        issuedAt: "2026-10-26T13:00:00Z",
      },
      {
        statementId: "s3",
        kind: "key.revoke",
        issuer: "publisher",
        registry: null,
        reason: "rotated away",
        issuedAt: "2026-10-26T14:00:00Z",
      },
    ]);
    expect(lines[0]).toBe(
      "Blocked:   publisher key revoked by Nimbus on 2026-10-26T12:00:00Z: leaked[2J",
    );
    expect(lines[1]).toContain('taken down by the maintainer of registry "community"');
    expect(lines[2]).toContain("by its publisher");
    expect(lines[3]).toContain("nimbus extension approve acme.tool");
  });

  test("formatRunLine", () => {
    expect(formatRunLine({})).toBeNull();
    expect(formatRunLine({ runState: "no_grant", runGrant: null })).toBe("no_grant");
    expect(
      formatRunLine({
        runState: "ready",
        runGrant: { serviceId: "ext_a", approvedAt: 0, modelAccess: false },
      }),
    ).toBe("ready (ext_a, approved 1970-01-01T00:00:00.000Z, model: no)");
    expect(
      formatRunLine({
        runState: "ready",
        runGrant: { serviceId: "ext_a", approvedAt: 0, modelAccess: true },
      }),
    ).toBe("ready (ext_a, approved 1970-01-01T00:00:00.000Z, model: yes)");
    const running = formatRunLine({
      runState: "running",
      runGrant: { serviceId: "ext_a", approvedAt: 0, modelAccess: false },
    });
    expect(running).toBe("running (ext_a, approved 1970-01-01T00:00:00.000Z, model: no)");
    expect(running).not.toContain("not executed");
  });
});

describe("extension update/downgrade owner prompt", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
  });

  test("update registers a consent prompt handler and uses the interactive timeout", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const mock = createMockIpcClient(
      [[{ id: "ext-a", toVersion: "2.0.0" }], { applied: true }],
      handlers,
    );
    await runExtensionUpdate(mock.client, ["update", "ext-a", "--to", "2.0.0"]);
    expect(handlers.has("consent.request")).toBe(true);
    expect(mock.calls.map((c) => c.method)).toContain("extension.update");
    expect(rpcTimeoutForExtensionSub("update", ["ext-a"])).toBe(INTERACTIVE_RPC_TIMEOUT_MS);
  });

  test("update --check registers nothing and keeps the default timeout", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const mock = createMockIpcClient([[]], handlers);
    await runExtensionUpdate(mock.client, ["update", "--check"]);
    expect(handlers.size).toBe(0);
    expect(rpcTimeoutForExtensionSub("update", ["--check"])).toBeUndefined();
  });

  test("update with no id registers no handler, keeps the default timeout, lists only", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const mock = createMockIpcClient([[]], handlers);
    await runExtensionUpdate(mock.client, ["update"]);
    expect(handlers.size).toBe(0);
    expect(mock.calls.map((c) => c.method)).toEqual(["extension.checkForUpdates"]);
    expect(rpcTimeoutForExtensionSub("update", [])).toBeUndefined();
  });

  test("update <id> --check never calls extension.update and registers no handler", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const mock = createMockIpcClient([[{ id: "ext-a", toVersion: "2.0.0" }]], handlers);
    await runExtensionUpdate(mock.client, ["update", "ext-a", "--check"]);
    expect(handlers.size).toBe(0);
    expect(mock.calls.map((c) => c.method)).toEqual(["extension.checkForUpdates"]);
    expect(rpcTimeoutForExtensionSub("update", ["ext-a", "--check"])).toBeUndefined();
  });

  test("downgrade registers a consent prompt handler and uses the interactive timeout", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const mock = createMockIpcClient([{ applied: true }], handlers);
    await runExtensionDowngrade(mock.client, ["downgrade", "ext-a", "--to", "1.0.0"]);
    expect(handlers.has("consent.request")).toBe(true);
    expect(mock.calls[0]?.method).toBe("extension.update");
    expect(rpcTimeoutForExtensionSub("downgrade", ["ext-a"])).toBe(INTERACTIVE_RPC_TIMEOUT_MS);
  });

  test("read-only subcommands keep the default timeout", () => {
    expect(rpcTimeoutForExtensionSub("list", [])).toBeUndefined();
  });
});

describe("runExtensionCredential", () => {
  const SECRET = "s3cr3t-value-do-not-leak";

  beforeEach(() => {
    out.reset();
  });

  function io(
    over: Partial<CredentialCliIo> = {},
  ): CredentialCliIo & { readonly state: { consentRegistered: number } } {
    const state = { consentRegistered: 0 };
    return {
      stdinIsTty: true,
      scriptConsentSource: undefined,
      readHidden: async () => SECRET,
      readStdin: async () => {
        throw new Error("stdin must not be read at a terminal");
      },
      registerConsent: () => {
        state.consentRegistered += 1;
      },
      ...over,
      state,
    };
  }

  test("set reads the value from the hidden prompt and calls extension.credentialSet", async () => {
    const { client, calls } = createMockIpcClient([{ name: "token", set: true }]);
    const i = io();
    await runExtensionCredential(client, ["set", "com.x", "token"], i);
    expect(calls).toEqual([
      { method: "extension.credentialSet", params: { id: "com.x", name: "token", value: SECRET } },
    ]);
    expect(i.state.consentRegistered).toBe(1);
    expect(out.stdout).toContain("com.x: token stored");
    expect(out.stdout).toContain("takes effect the next time the extension starts");
    expect(out.stdout).not.toContain("sync");
    expect(out.stdout).not.toContain(SECRET);
  });

  test("set never takes the value from argv", async () => {
    const { client, calls } = createMockIpcClient([]);
    await expect(
      runExtensionCredential(client, ["set", "com.x", "token", SECRET], io()),
    ).rejects.toThrow(/never takes the value as an argument/);
    expect(calls).toHaveLength(0);
  });

  test("set reads stdin when it is not a terminal, dropping one trailing newline", async () => {
    const { client, calls } = createMockIpcClient([{ name: "token", set: true }]);
    await runExtensionCredential(
      client,
      ["set", "com.x", "token"],
      io({
        stdinIsTty: false,
        scriptConsentSource: "/tmp/consent.jsonl",
        readHidden: async () => {
          throw new Error("no hidden prompt off a terminal");
        },
        readStdin: async () => `${SECRET}\r\n`,
      }),
    );
    expect(calls[0]?.params).toEqual({ id: "com.x", name: "token", value: SECRET });
  });

  test("piped stdin without NIMBUS_SCRIPT_CONSENT_SOURCE refuses before reading or calling", async () => {
    const { client, calls } = createMockIpcClient([]);
    let read = false;
    await expect(
      runExtensionCredential(
        client,
        ["set", "com.x", "token"],
        io({
          stdinIsTty: false,
          readStdin: async () => {
            read = true;
            return SECRET;
          },
        }),
      ),
    ).rejects.toThrow(/NIMBUS_SCRIPT_CONSENT_SOURCE/);
    expect(read).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a blank value and a cancelled prompt store nothing", async () => {
    for (const readHidden of [async () => "  ", async () => undefined]) {
      const { client, calls } = createMockIpcClient([]);
      await expect(
        runExtensionCredential(client, ["set", "com.x", "token"], io({ readHidden })),
      ).rejects.toThrow(/nothing was stored/);
      expect(calls).toHaveLength(0);
    }
  });

  test("status prints set / not set per name", async () => {
    const { client, calls } = createMockIpcClient([
      {
        credentials: [
          { name: "api_secret", set: false },
          { name: "token", set: true },
        ],
      },
    ]);
    await runExtensionCredential(client, ["status", "com.x"], io());
    expect(calls).toEqual([{ method: "extension.credentialStatus", params: { id: "com.x" } }]);
    expect(out.stdout).toContain("api_secret: not set");
    expect(out.stdout).toContain("token: set");
  });

  test("status with no declared credentials says so", async () => {
    const { client } = createMockIpcClient([{ credentials: [] }]);
    await runExtensionCredential(client, ["status", "com.x"], io());
    expect(out.stdout).toContain("com.x: declares no credentials");
  });

  test("an unknown action or missing args is the usage", async () => {
    for (const rest of [[], ["nope"], ["set", "com.x"], ["status"]]) {
      const { client } = createMockIpcClient([]);
      await expect(runExtensionCredential(client, rest, io())).rejects.toThrow(
        /extension credential set <id> <name>/,
      );
    }
  });

  test("credential set gets the interactive RPC budget; status keeps the default", () => {
    expect(rpcTimeoutForExtensionSub("credential", ["set", "com.x", "token"])).toBe(
      INTERACTIVE_RPC_TIMEOUT_MS,
    );
    expect(rpcTimeoutForExtensionSub("credential", ["status", "com.x"])).toBeUndefined();
  });
});

describe("runExtensionInstall — the post-install walk", () => {
  const origOut = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const origIn = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const restore = (
    s: NodeJS.ReadStream | NodeJS.WriteStream,
    d: PropertyDescriptor | undefined,
  ): void => {
    if (d === undefined) delete (s as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(s, "isTTY", d);
  };
  const setTty = (v: boolean): void => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: v });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: v });
  };
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    restore(process.stdout, origOut);
    restore(process.stdin, origIn);
  });

  /** A mock client that COUNTS notification handlers per event (the shared mock keeps only one). */
  type CountingClient = ReturnType<typeof createMockIpcClient> & {
    handlerCount: Map<string, number>;
  };
  function countingClient(responses: unknown[]): CountingClient {
    const mock = createMockIpcClient(responses);
    const handlerCount = new Map<string, number>();
    const inner = mock.client.onNotification.bind(mock.client);
    Object.assign(mock.client, {
      onNotification: (event: string, h: (params: unknown) => void): void => {
        handlerCount.set(event, (handlerCount.get(event) ?? 0) + 1);
        inner(event, h);
      },
    });
    return Object.assign(mock, { handlerCount });
  }

  test("no walk under --yes", async () => {
    setTty(true);
    const install = countingClient([
      {
        id: "new.ext",
        version: "1.0.0",
        installPath: "/p",
        connectorRequirements: [{ ...REQ, interactive: true }],
      },
    ]);
    const made: string[] = [];
    const asked: string[] = [];
    await runExtensionInstall(install.client, ["install", ".", "--yes"], ["."], {
      socketPath: "/sock",
      makeClient: (p) => {
        made.push(p);
        return countingClient([]).client;
      },
      confirm: async (q) => {
        asked.push(q);
        return true;
      },
      connectorAuth: async (id) => {
        asked.push(`auth ${id}`);
      },
    });
    expect(made).toEqual([]);
    expect(asked).toEqual([]);
    expect(install.calls.map((c) => c.method)).toEqual(["extension.install"]);
    expect(out.stdout).not.toContain("Approve each package to run");
  });

  for (const [name, stdinTty, args] of [
    ["no walk when stdin is not a terminal", false, ["install", "."]],
    ["no walk under -y", true, ["install", ".", "-y"]],
  ] as const) {
    test(name, async () => {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinTty });
      const install = countingClient([
        {
          id: "new.ext",
          version: "1.0.0",
          installPath: "/p",
          connectorRequirements: [{ ...REQ, interactive: true }],
        },
      ]);
      const made: string[] = [];
      const asked: string[] = [];
      await runExtensionInstall(install.client, [...args], ["."], {
        socketPath: "/sock",
        makeClient: (p) => {
          made.push(p);
          return countingClient([]).client;
        },
        confirm: async (q) => {
          asked.push(q);
          return true;
        },
        connectorAuth: async (id) => {
          asked.push(`auth ${id}`);
        },
      });
      expect(made).toEqual([]);
      expect(asked).toEqual([]);
      expect(install.calls.map((c) => c.method)).toEqual(["extension.install"]);
    });
  }

  const PROMOTE_COPY =
    "acme.dep is already installed (it came in as a dependency); it is now kept even if what needed it is removed.";

  for (const [name, args, rest] of [
    [
      "a registry install of a dependency prints the promote copy and walks nothing",
      ["install", "acme.dep"],
      ["acme.dep"],
    ],
    [
      "a local install of a dependency prints the promote copy and walks nothing",
      ["install", "."],
      ["."],
    ],
  ] as const) {
    test(name, async () => {
      setTty(true);
      const install = countingClient([
        { id: "acme.dep", version: "1.0.0", promoted: true, sourceRegistry: "main" },
      ]);
      const made: string[] = [];
      const asked: string[] = [];
      await runExtensionInstall(install.client, [...args], [...rest], {
        socketPath: "/sock",
        makeClient: (p) => {
          made.push(p);
          return countingClient([]).client;
        },
        confirm: async (q) => {
          asked.push(q);
          return true;
        },
        connectorAuth: async (id) => {
          asked.push(`auth ${id}`);
        },
      });
      expect(out.stdout.split("\n")[0]).toBe(PROMOTE_COPY);
      // The JSON names the registry the kept copy came from.
      expect(out.stdout).toContain('"sourceRegistry": "main"');
      expect(out.stdout).not.toContain("Nothing runs until you approve it");
      expect(out.stdout).not.toContain("installed acme.dep");
      expect(out.stdout).not.toContain("Needs:");
      expect(made).toEqual([]);
      expect(asked).toEqual([]);
      expect(install.calls).toHaveLength(1);
    });
  }

  test("the walk never approves on the install's client", async () => {
    setTty(true);
    const install = countingClient([
      {
        id: "com.example.tool",
        version: "2.0.0",
        sourceRegistry: "main",
        installPath: "/p",
        dependencies: [{ id: "com.example.dep", version: "1.2.0", registry: "main" }],
      },
    ]);
    const fresh: CountingClient[] = [];
    const timeouts: number[] = [];
    const asked: string[] = [];
    await runExtensionInstall(
      install.client,
      ["install", "com.example.tool"],
      ["com.example.tool"],
      {
        socketPath: "/sock",
        makeClient: (p, t) => {
          expect(p).toBe("/sock");
          timeouts.push(t);
          const c = countingClient([
            { id: "x", serviceId: "ext_x", treeDigest: "ab".repeat(32), changed: true },
          ]);
          fresh.push(c);
          return c.client;
        },
        confirm: async (q) => {
          asked.push(q);
          // The one opening question; each package's own decision is its gateway prompt.
          if (q === "Approve the 2 new packages to run now? [y/N] ") return true;
          throw new Error("no walk question for an approval");
        },
      },
    );
    expect(install.calls.map((c) => c.method)).toEqual(["registry.install"]);
    expect(asked).toEqual(["Approve the 2 new packages to run now? [y/N] "]);
    expect(fresh).toHaveLength(2);
    expect(fresh.map((c) => c.calls)).toEqual([
      [{ method: "extension.approveRun", params: { id: "com.example.dep", modelAccess: false } }],
      [{ method: "extension.approveRun", params: { id: "com.example.tool", modelAccess: false } }],
    ]);
    for (const c of fresh) expect(c.handlerCount.get("consent.request")).toBe(1);
    expect(timeouts).toEqual([INTERACTIVE_RPC_TIMEOUT_MS, INTERACTIVE_RPC_TIMEOUT_MS]);
    expect(out.stdout).toContain("Approve each package to run (you can decline any):");
  });

  describe("a starter pack has no code to approve", () => {
    const PACK_REQ = {
      connector: "github",
      state: "not_connected",
      owner: { kind: "bundled" },
      fix: ["nimbus connector auth github"],
      requiredBy: ["acme.pack"],
      interactive: false,
    };
    const walkDeps = (asked: string[], approved: string[]) => ({
      socketPath: "/sock",
      makeClient: () => {
        const c = createMockIpcClient([
          { id: "x", serviceId: "ext_x", treeDigest: "ab".repeat(32), changed: true },
        ]);
        approved.push("fresh");
        return c.client;
      },
      confirm: async (q: string) => {
        asked.push(q);
        return true;
      },
      connectorAuth: async (id: string) => {
        asked.push(`auth ${id}`);
      },
    });

    test("a registry pack approves only its code members, dependencies first", async () => {
      setTty(true);
      const { client } = createMockIpcClient([
        {
          id: "acme.pack",
          version: "1.0.0",
          sourceRegistry: "main",
          installPath: "/p",
          kind: "starter-pack",
          dependencies: [
            { id: "acme.sub", version: "1.0.0", registry: "main", kind: "starter-pack" },
            { id: "acme.dep", version: "1.0.0", registry: "main", kind: "extension" },
          ],
        },
      ]);
      const asked: string[] = [];
      const fresh: string[] = [];
      await runExtensionInstall(
        client,
        ["install", "acme.pack"],
        ["acme.pack"],
        walkDeps(asked, fresh),
      );
      expect(out.stdout).toContain("Installed starter pack acme.pack@1.0.0.");
      expect(out.stdout).toContain("Added 2 package(s) it needs.");
      expect(out.stdout).toContain(
        "Nothing runs until you approve it: nimbus extension approve acme.dep",
      );
      expect(out.stdout).not.toContain("approve acme.pack");
      expect(out.stdout).not.toContain("approve acme.sub");
      // One code package: the single-package question, one approval.
      expect(asked).toEqual(["Approve acme.dep to run now? [y/N] "]);
      expect(fresh).toHaveLength(1);
    });

    test("a pack whose members were all installed already prints no Nothing-runs line and asks nothing", async () => {
      setTty(true);
      const { client } = createMockIpcClient([
        {
          id: "acme.pack",
          version: "1.0.0",
          sourceRegistry: "main",
          installPath: "/p",
          kind: "starter-pack",
          dependencies: [],
        },
      ]);
      const asked: string[] = [];
      await runExtensionInstall(
        client,
        ["install", "acme.pack"],
        ["acme.pack"],
        walkDeps(asked, []),
      );
      expect(out.stdout).toContain("Installed starter pack acme.pack@1.0.0.");
      expect(out.stdout).not.toContain("Added ");
      expect(out.stdout).not.toContain("Nothing runs until you approve it");
      expect(asked).toEqual([]);
    });

    test("a pack's own connector requirement is still offered, and never as a pack approval", async () => {
      setTty(true);
      const { client } = createMockIpcClient([
        {
          id: "acme.pack",
          version: "1.0.0",
          sourceRegistry: "main",
          installPath: "/p",
          kind: "starter-pack",
          dependencies: [],
          connectorRequirements: [PACK_REQ],
        },
      ]);
      const asked: string[] = [];
      await runExtensionInstall(
        client,
        ["install", "acme.pack"],
        ["acme.pack"],
        walkDeps(asked, []),
      );
      expect(out.stdout).toContain("Needs:");
      expect(out.stdout).not.toContain("extension approve acme.pack");
      expect(asked.some((q) => q.includes("Approve"))).toBe(false);
    });

    test("a gateway that reports no kind is treated as an extension", async () => {
      setTty(true);
      const { client } = createMockIpcClient([
        { id: "acme.tool", version: "1.0.0", sourceRegistry: "main", installPath: "/p" },
      ]);
      await runExtensionInstall(client, ["install", "acme.tool"], ["acme.tool"]);
      expect(out.stdout).toContain(
        "Nothing runs until you approve it: nimbus extension approve acme.tool",
      );
      expect(out.stdout).not.toContain("starter pack");
    });

    test("a local pack install walks no approvals", async () => {
      setTty(true);
      const { client } = createMockIpcClient([
        { id: "acme.pack", version: "1.0.0", installPath: "/p", kind: "starter-pack" },
      ]);
      const asked: string[] = [];
      await runExtensionInstall(client, ["install", ".", "--yes"], ["."], walkDeps(asked, []));
      expect(asked).toEqual([]);
    });
  });

  test("a failing walk never fails the install", async () => {
    setTty(true);
    const install = countingClient([{ id: "new.ext", version: "1.0.0", installPath: "/p" }]);
    await runExtensionInstall(install.client, ["install", "."], ["."], {
      socketPath: "/sock",
      makeClient: () => {
        throw new Error("socket gone");
      },
      confirm: async () => true,
    });
    // Not a denial: the walk says it could not ask, and stops.
    expect(out.stdout).toContain("  new.ext: could not ask (socket gone)");
    expect(out.stdout).not.toContain("not approved");
  });

  test("a no to the opening question approves nothing and opens no client", async () => {
    setTty(true);
    const install = countingClient([{ id: "new.ext", version: "1.0.0", installPath: "/p" }]);
    const made: string[] = [];
    const asked: string[] = [];
    await runExtensionInstall(install.client, ["install", "."], ["."], {
      socketPath: "/sock",
      makeClient: (p) => {
        made.push(p);
        return countingClient([]).client;
      },
      confirm: async (q) => {
        asked.push(q);
        return false;
      },
    });
    expect(asked).toEqual(["Approve new.ext to run now? [y/N] "]);
    expect(made).toEqual([]);
    expect(out.stdout).toContain(
      "Not approved now; approve later with: nimbus extension approve new.ext",
    );
  });

  test("without walk deps an attended install only prints", async () => {
    setTty(true);
    const install = countingClient([{ id: "new.ext", version: "1.0.0", installPath: "/p" }]);
    await runExtensionInstall(install.client, ["install", "."], ["."]);
    expect(out.stdout).not.toContain("Approve each package to run");
  });
});

describe("a starter pack in extension list / info", () => {
  test("the Run column shows `pack (no code)` for a pack", () => {
    const formatted = formatExtensionListTable(
      [
        { id: "fx.pack.top", version: "1.0.0", enabled: 1, runState: "pack" },
        { id: "fx.code.a", version: "1.0.0", enabled: 1, runState: "no_grant" },
      ],
      { isTty: false, noColor: true },
    );
    const packLine = formatted.split("\n").find((l) => l.startsWith("fx.pack.top"));
    expect(packLine).toMatch(/\spack \(no code\)\s*$/);
    const codeLine = formatted.split("\n").find((l) => l.startsWith("fx.code.a"));
    expect(codeLine).toMatch(/\sno_grant\s*$/);
  });

  test("the info run line names a pack the same way", () => {
    expect(formatRunLine({ runState: "pack", runGrant: null })).toBe("pack (no code)");
  });
});
