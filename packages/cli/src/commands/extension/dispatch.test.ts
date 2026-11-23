import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearFixture, setFixture } from "../../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../../test/helpers/stream-capture.ts";
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
