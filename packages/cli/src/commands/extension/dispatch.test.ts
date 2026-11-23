import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFixture, setFixture } from "../../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../../test/helpers/stream-capture.ts";
import { encodeBase64, generateEd25519Keypair, signManifest } from "../../lib/extension-signing.ts";
import { runExtension } from "./dispatch.ts";

/**
 * `runExtension`'s routing, with the gateway faked through the shared CLI fixture: each subcommand
 * group reaches its own module (seen in the IPC calls it makes, or in the usage line it prints and
 * the exit code it answers with when it is given no argument). Nothing here reaches a real gateway.
 */

const cap = createStreamCapture({ captureExit: true });
const stderr = (): string => cap.stderrChunks.join("");

let methods: string[] = [];

function gatewayWithReplies(reply: (method: string) => unknown): void {
  methods = [];
  setFixture({
    gatewayState: { socketPath: "fake.sock" },
    ipcClient: {
      connect: async () => {},
      disconnect: async () => {},
      call: async (method: string) => {
        methods.push(method);
        return reply(method);
      },
    },
  });
}

beforeEach(() => {
  cap.stdoutChunks.length = 0;
  cap.stderrChunks.length = 0;
  cap.install();
});
afterEach(() => {
  cap.restore();
  clearFixture();
});

describe("runExtension routing: subcommands that need no gateway", () => {
  test.each(["publish", "pack", "key"])(
    "%s with no arguments exits non-zero before any gateway",
    async (sub) => {
      setFixture({});
      await expect(runExtension([sub])).rejects.toThrow(/process\.exit\([1-9]\)/);
    },
  );
});

describe("runExtension routing: subcommands answered through the gateway", () => {
  test("list asks the gateway for the installed extensions", async () => {
    gatewayWithReplies(() => ({ extensions: [] }));
    await runExtension(["list", "--json"]);
    expect(methods).toContain("extension.list");
  });

  test("an unknown subcommand throws the usage text after connecting", async () => {
    gatewayWithReplies(() => ({}));
    await expect(runExtension(["frobnicate"])).rejects.toThrow(/Usage: nimbus extension list/);
  });

  test.each(["report", "sponsor", "clone", "audit", "verify-provenance", "downgrade"])(
    "%s with a stubbed gateway is routed to its own command, never to the usage error",
    async (sub) => {
      gatewayWithReplies(() => ({}));
      let thrown: unknown;
      try {
        await runExtension([sub]);
      } catch (e) {
        thrown = e;
      }
      // Either the command finished, or it answered with its own exit code; a usage error means
      // the subcommand was not routed at all.
      if (thrown instanceof Error)
        expect(thrown.message).not.toMatch(/Usage: nimbus extension list/);
      expect(stderr()).not.toMatch(/Usage: nimbus extension list/);
    },
  );

  test("search with a query asks the registries", async () => {
    gatewayWithReplies(() => ({ results: [] }));
    let thrown: unknown;
    try {
      await runExtension(["search", "notes"]);
    } catch (e) {
      thrown = e;
    }
    if (thrown instanceof Error) expect(thrown.message).not.toMatch(/Usage: nimbus extension list/);
    expect(methods.some((m) => m.startsWith("registry."))).toBe(true);
  });

  test.each([
    ["revoke", "extension.revokeRun"],
    ["enable", "extension.enable"],
    ["disable", "extension.disable"],
  ])("%s <id> reaches its own RPC", async (sub, method) => {
    gatewayWithReplies(() => ({ ok: true }));
    await runExtension([sub, "acme.notes"]);
    expect(methods).toContain(method);
  });
});

describe("runExtension routing: the rest of the gateway-backed groups", () => {
  test.each([
    ["rehash", ["rehash", "acme.notes", "--yes"], "extension.rehash"],
    ["credential", ["credential", "status", "acme.notes"], "extension.credential"],
  ])("%s reaches its own module", async (_name, args, prefix) => {
    gatewayWithReplies(() => ({ ok: true, credentials: [] }));
    try {
      await runExtension(args);
    } catch {
      // a reply shape the command does not accept still shows which RPC it asked for
    }
    expect(methods.some((m) => m.startsWith(prefix))).toBe(true);
  });

  test("approve is routed to its own module, which refuses a non-terminal; --network is not refused first", async () => {
    gatewayWithReplies(() => ({ ok: true }));
    for (const args of [
      ["approve", "acme.notes"],
      ["approve", "acme.notes", "--network", "none"],
    ]) {
      await expect(runExtension(args)).rejects.toThrow(/non-TTY mode/);
    }
  });
});

describe("runExtension routing: pack and publish exit codes", () => {
  test("pack of a real extension directory writes the package and returns", async () => {
    setFixture({});
    const dir = mkdtempSync(join(tmpdir(), "nimbus-dispatch-pack-"));
    try {
      mkdirSync(join(dir, "ext", "dist"), { recursive: true });
      writeFileSync(join(dir, "ext", "dist", "index.js"), "export default 1;\n");
      const { privkey, pubkey } = generateEd25519Keypair();
      const manifest: Record<string, unknown> = {
        id: "com.example.tool",
        name: "Example Tool",
        version: "1.0.0",
        entry: "dist/index.js",
        permissions: {},
        publisher: { id: "example", key: encodeBase64(pubkey) },
      };
      manifest["signature"] = await signManifest(manifest, privkey);
      writeFileSync(join(dir, "ext", "nimbus.extension.json"), JSON.stringify(manifest));
      const out = join(dir, "package.tgz");
      await runExtension(["pack", join(dir, "ext"), "--out", out]);
      expect(existsSync(out)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
