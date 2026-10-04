import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolatePlatformEnv } from "../../test/helpers/isolate-platform-env.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import type { IPCClient } from "../ipc-client/index.ts";
import { decodeBase64 } from "../lib/extension-signing.ts";
import {
  runExtension,
  runExtensionDowngrade,
  runExtensionInfo,
  runExtensionKeygen,
  runExtensionList,
  runExtensionRemove,
  runExtensionSync,
  runExtensionUpdate,
} from "./extension.ts";

/**
 * Branches the sibling extension test files leave unexercised, driven through injected fake
 * clients (no `mock.module`): the production stdout/stderr wiring of `sync`/`update`/`downgrade`,
 * the list renderer's colour and missing-field edges, non-Error removal failures, the keygen
 * rethrow, and `runExtension`'s offline exit codes. Nothing here reaches a gateway.
 */

const cap = createStreamCapture({ captureExit: true });
const stdout = (): string => cap.stdoutChunks.join("");
const stderr = (): string => cap.stderrChunks.join("");

const roots: string[] = [];
function tempRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "nimbus-ext-cov-"));
  roots.push(r);
  return r;
}

beforeEach(() => {
  cap.stdoutChunks.length = 0;
  cap.stderrChunks.length = 0;
  cap.install();
});
afterEach(() => {
  cap.restore();
});
afterAll(() => {
  for (const r of roots)
    rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

/** A client whose `call` throws `thrown` — `createMockIpcClient` can only throw Error instances. */
function throwingClient(thrown: unknown): IPCClient {
  return {
    call: async () => {
      throw thrown;
    },
  } as unknown as IPCClient;
}

describe("runExtensionList — edges", () => {
  test("a signature-disabled row with no reason says 'unknown' rather than printing undefined", async () => {
    const ipc = createMockIpcClient([
      {
        extensions: [{ id: "acme.notes", version: "1.0.0", enabled: 0, signature_disabled: true }],
      },
    ]);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => {
      lines.push(s);
    };
    try {
      await runExtensionList(ipc.client, []);
    } finally {
      console.log = origLog;
    }
    expect(lines.at(-1)).toBe("  acme.notes@1.0.0 [signature: unknown]");
    expect(lines.join("\n")).toContain("disabled (signature)");
  });

  test("on a terminal, NO_COLOR suppresses colour; an empty NO_COLOR does not", async () => {
    const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const savedNoColor = process.env["NO_COLOR"];
    const render = async (noColor: string | undefined): Promise<string> => {
      if (noColor === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = noColor;
      const ipc = createMockIpcClient([
        { extensions: [{ id: "acme.notes", version: "1.0.0", enabled: 1 }] },
      ]);
      const lines: string[] = [];
      const origLog = console.log;
      console.log = (s: string) => {
        lines.push(s);
      };
      try {
        await runExtensionList(ipc.client, []);
      } finally {
        console.log = origLog;
      }
      return lines.join("\n");
    };
    const ESC = "\u001b[";
    let suppressed = "";
    let empty = "";
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      suppressed = await render("1");
      empty = await render("");
    } finally {
      if (ttyDesc === undefined) delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, "isTTY", ttyDesc);
      if (savedNoColor === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = savedNoColor;
    }
    // The publisher-less row is the one the renderer colours.
    expect(suppressed).toContain("(unverified)");
    expect(suppressed).not.toContain(ESC);
    expect(empty).toContain(`${ESC}2;33m(unverified)`);
  });

  test("--tree treats an info reply with no forwardDeps as a leaf", async () => {
    const ipc = createMockIpcClient([
      { extensions: [{ id: "acme.base", version: "2.0.0" }] },
      { extension: {} },
    ]);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => {
      lines.push(s);
    };
    try {
      await runExtensionList(ipc.client, ["--tree"]);
    } finally {
      console.log = origLog;
    }
    expect(lines).toEqual(["acme.base@2.0.0"]);
    expect(ipc.calls[1]).toEqual({ method: "extension.info", params: { id: "acme.base" } });
  });
});

describe("runExtensionInfo --deps — ordering", () => {
  test("both dependency directions print sorted by id, whatever order the gateway sent", async () => {
    // Two entries per direction, each sent in REVERSE order: a single reverse dependency (all the
    // sibling file sends) never exercises that list's sort at all.
    const ipc = createMockIpcClient([
      {
        extension: {
          id: "acme.app",
          version: "1.0.0",
          enabled: 1,
          forwardDeps: [
            { id: "zeta.lib", range: "^1.0.0" },
            { id: "alpha.lib", range: ">=2.0.0" },
          ],
          reverseDeps: [
            { extensionId: "zeta.ui", range: "^3.0.0" },
            { extensionId: "alpha.ui", range: "~0.5.0" },
          ],
        },
      },
      { sandbox: { platform_capabilities: { network: "per_host", reason: null } } },
    ]);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => {
      lines.push(s);
    };
    try {
      await runExtensionInfo(ipc.client, ["acme.app"], ["info", "acme.app", "--deps"]);
    } finally {
      console.log = origLog;
    }
    expect(lines.slice(lines.indexOf("\nDependencies:"))).toEqual([
      "\nDependencies:",
      "  Forward (this extension requires):",
      "    alpha.lib  >=2.0.0",
      "    zeta.lib  ^1.0.0",
      "  Reverse (required by):",
      "    alpha.ui  ~0.5.0",
      "    zeta.ui  ^3.0.0",
    ]);
  });
});

describe("runExtensionRemove — non-Error failures", () => {
  test("a non-Error failure that is not a dependency block is rethrown unchanged", async () => {
    await expect(
      runExtensionRemove(
        throwingClient("socket closed"),
        ["remove", "acme.notes", "--yes"],
        ["acme.notes"],
      ),
    ).rejects.toBe("socket closed");
    expect(stderr()).toBe("");
  });

  test("a non-Error dependency block still prints the --force hint and exits 1", async () => {
    await expect(
      runExtensionRemove(
        throwingClient("reverse_dep_blocked: acme.ui requires acme.notes"),
        ["remove", "acme.notes", "--yes"],
        ["acme.notes"],
      ),
    ).rejects.toThrow("process.exit(1)");
    expect(stderr()).toBe(
      "reverse_dep_blocked: acme.ui requires acme.notes\nRe-run with --force to override.\n",
    );
  });
});

describe("runExtensionKeygen — filesystem errors", () => {
  test("a write error other than 'already exists' rejects instead of claiming an overwrite refusal", async () => {
    // A NUL byte in the file name: its directory exists, but the write itself is refused, with a
    // code that is not EEXIST, on every platform. (A DIRECTORY at the path would not do: Windows
    // reports that as EEXIST, which this function rightly treats as "already exists".)
    const out = join(tempRoot(), "publisher\u0000key");
    let caught: unknown;
    try {
      await runExtensionKeygen(["--out", out]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as NodeJS.ErrnoException).code).not.toBe("EEXIST");
    expect(stderr()).not.toContain("refusing to overwrite");
    // Nothing was printed as a public key, since nothing was written.
    expect(stdout()).toBe("");
  });
});

describe("runExtension — offline subcommands", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    // keygen/sign never consult the gateway; if that regressed, the lookup lands here, not in a
    // real profile.
    restoreEnv = isolatePlatformEnv(join(tmpdir(), "nimbus-ext-cov-env-never-created"));
  });
  afterEach(() => {
    restoreEnv();
  });

  test("keygen refusing to overwrite exits with its own code 2", async () => {
    const out = join(tempRoot(), "publisher-key");
    writeFileSync(out, "existing\n");
    await expect(runExtension(["keygen", "--out", out])).rejects.toThrow("process.exit(2)");
    expect(stderr()).toBe(`refusing to overwrite ${out} without --force\n`);
    expect(readFileSync(out, "utf8")).toBe("existing\n");
  });

  test("sign with no extension dir exits 2 with the usage line", async () => {
    await expect(runExtension(["sign"])).rejects.toThrow("process.exit(2)");
    expect(stderr()).toBe("usage: nimbus extension sign <ext-dir> [--key <path>]\n");
  });

  test("a successful sign returns normally and writes the signature into the manifest", async () => {
    const root = tempRoot();
    const key = join(root, "publisher-key");
    expect(await runExtensionKeygen(["--out", key])).toBe(0);
    const extDir = join(root, "ext");
    mkdirSync(extDir);
    const manifest = join(extDir, "nimbus.extension.json");
    writeFileSync(manifest, JSON.stringify({ id: "acme.notes", version: "1.0.0" }));
    await runExtension(["sign", extDir, "--key", key]);
    const signed = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    expect(signed["id"]).toBe("acme.notes");
    expect(typeof signed["signature"]).toBe("string");
    // An Ed25519 signature is exactly 64 bytes: any other non-empty string is not one.
    expect(decodeBase64(signed["signature"] as string)).toHaveLength(64);
    expect(cap.stderrChunks).toEqual([]);
  });
});

describe("sync / update / downgrade — production output wiring", () => {
  test("sync writes the summary to stdout and an unreachable publisher to stderr (exit 4)", async () => {
    const ipc = createMockIpcClient([
      {
        publishersChecked: 1,
        publishersUnchanged: 0,
        publishersUpdated: [],
        publishersEvicted: [],
        failures: [{ id: "acme", reason: "timeout" }],
      },
    ]);
    expect(await runExtensionSync(ipc.client, ["sync"])).toBe(4);
    expect(ipc.calls).toEqual([{ method: "extension.sync", params: { dryRun: false } }]);
    expect(stdout()).toContain("publishers checked: 1\n");
    expect(stderr()).toContain("publisher acme unreachable (timeout)");
  });

  test("update writes a failed apply and its hint to stderr (exit 1)", async () => {
    const ipc = createMockIpcClient([
      [
        {
          id: "acme.notes",
          displayName: "Notes",
          fromVersion: "1.0.0",
          toVersion: "1.1.0",
          channel: "stable",
          publisherStatus: "verified",
          verificationStatus: "verified",
        },
      ],
      { applied: false, reason: "publisher_key_missing", hint: "run nimbus extension sync" },
    ]);
    expect(await runExtensionUpdate(ipc.client, ["update", "acme.notes"])).toBe(1);
    expect(ipc.calls.map((c) => c.method)).toEqual([
      "extension.checkForUpdates",
      "extension.update",
    ]);
    expect(stderr()).toBe(
      "update failed: publisher_key_missing\n  hint: run nimbus extension sync\n",
    );
    expect(stdout()).toBe("");
  });

  test("downgrade sends extension.update with the requested version and reports success on stdout", async () => {
    const ipc = createMockIpcClient([{ applied: true }]);
    expect(
      await runExtensionDowngrade(ipc.client, ["downgrade", "acme.notes", "--to", "0.9.0"]),
    ).toBe(0);
    expect(ipc.calls).toEqual([
      { method: "extension.update", params: { id: "acme.notes", toVersion: "0.9.0" } },
    ]);
    expect(stdout()).toBe("downgraded acme.notes to 0.9.0\n");
    expect(stderr()).toBe("");
  });

  test("a failed downgrade with no reason reports 'unknown' on stderr (exit 1)", async () => {
    const ipc = createMockIpcClient([{ applied: false }]);
    expect(
      await runExtensionDowngrade(ipc.client, ["downgrade", "acme.notes", "--to", "0.9.0"]),
    ).toBe(1);
    expect(stderr()).toBe("downgrade failed: unknown\n");
  });
});
