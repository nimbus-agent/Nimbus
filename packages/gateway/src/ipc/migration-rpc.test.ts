import { describe, expect, test } from "bun:test";

import {
  type MigrationConsent,
  type MigrationConsentPayload,
  MigrationError,
  type MigrationRow,
} from "../extensions/migration/migration-engine.ts";
import {
  dispatchMigrationRpc,
  type MigrationRpcContext,
  redactMigrationPaths,
} from "./migration-rpc.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

const ROW: MigrationRow = {
  id: "m-1",
  legacyServiceId: "fixturewise",
  extensionId: "com.example.fixturewise",
  version: "1.0.0",
  treeDigest: "d".repeat(64),
  stagePath: "C:\\Users\\owner\\AppData\\Roaming\\Nimbus\\data\\migrations\\m-1\\pkg",
  state: "awaiting_approval",
  error: null,
  createdAt: 1,
  updatedAt: 2,
};

const PAYLOAD: MigrationConsentPayload = {
  migrationId: "m-1",
  extensionId: ROW.extensionId,
  summary: "s",
  publisher: { id: "nimbus", fingerprint: "f" },
  version: "1.0.0",
  network: "no network access",
  readTools: "r",
  knownLoss: "k",
  fromRenderer: false,
};

interface FakeEngine {
  readonly ctxEngine: MigrationRpcContext["engine"];
  readonly calls: string[];
}

function fakeEngine(over: Partial<MigrationRpcContext["engine"]> = {}): FakeEngine {
  const calls: string[] = [];
  return {
    calls,
    ctxEngine: {
      list: () => {
        calls.push("list");
        return [ROW];
      },
      accept: async (id: string, consent: MigrationConsent) => {
        calls.push(`accept:${id}`);
        const ok = await consent(PAYLOAD);
        if (!ok) {
          throw new MigrationError("ERR_EXTENSION_MIGRATION_NOT_APPROVED", "not approved");
        }
        return { ...ROW, state: "approved", stagePath: null };
      },
      decline: (id: string) => {
        calls.push(`decline:${id}`);
        return { ...ROW, state: "declined", stagePath: null };
      },
      retry: async () => {
        calls.push("retry");
      },
      ...over,
    },
  };
}

async function rpcErrorOf(p: Promise<unknown>): Promise<RpcMethodError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcMethodError) return e;
    throw e;
  }
  throw new Error("expected an RpcMethodError");
}

describe("migration.* handlers", () => {
  test("list returns every row without its staging path", async () => {
    const e = fakeEngine();
    const out = await dispatchMigrationRpc("migration.list", {}, { engine: e.ctxEngine });
    expect(out.kind).toBe("hit");
    const value = (out as { value: { migrations: Array<Record<string, unknown>> } }).value;
    expect(value.migrations).toHaveLength(1);
    expect(value.migrations[0]).not.toHaveProperty("stagePath");
    expect(JSON.stringify(value)).not.toContain("migrations\\\\m-1");
    expect(value.migrations[0]?.["id"]).toBe("m-1");
  });

  test("accept raises exactly extension.migrate through the owner gate and returns the row", async () => {
    const asked: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const e = fakeEngine();
    const out = await dispatchMigrationRpc(
      "migration.accept",
      { id: "m-1" },
      {
        engine: e.ctxEngine,
        ownerGate: async (a) => {
          asked.push(a);
          return true;
        },
      },
    );
    expect(asked.map((a) => a.type)).toEqual(["extension.migrate"]);
    expect(asked[0]?.payload["migrationId"]).toBe("m-1");
    const value = (out as { value: Record<string, unknown> }).value;
    expect(value["state"]).toBe("approved");
    expect(value).not.toHaveProperty("stagePath");
  });

  test("I46: fromRenderer reaches the engine from the context only, never from params", async () => {
    const origins: Array<boolean | undefined> = [];
    const e = fakeEngine({
      accept: async (_id, _consent, origin) => {
        origins.push(origin?.fromRenderer);
        return { ...ROW, state: "approved", stagePath: null };
      },
    });
    const gate = async (): Promise<boolean> => true;
    await dispatchMigrationRpc(
      "migration.accept",
      { id: "m-1", fromRenderer: true },
      { engine: e.ctxEngine, ownerGate: gate },
    );
    await dispatchMigrationRpc(
      "migration.accept",
      { id: "m-1", fromRenderer: false },
      { engine: e.ctxEngine, ownerGate: gate, fromRenderer: true },
    );
    expect(origins).toEqual([false, true]);
  });

  test("accept refuses without an owner gate, before the engine is asked", async () => {
    const e = fakeEngine();
    const err = await rpcErrorOf(
      dispatchMigrationRpc("migration.accept", { id: "m-1" }, { engine: e.ctxEngine }),
    );
    expect(err.rpcCode).toBe(-32603);
    expect(e.calls).toEqual([]);
  });

  test("a 'no' is the engine's NOT_APPROVED refusal, carried with its code", async () => {
    const e = fakeEngine();
    const err = await rpcErrorOf(
      dispatchMigrationRpc(
        "migration.accept",
        { id: "m-1" },
        { engine: e.ctxEngine, ownerGate: async () => false },
      ),
    );
    expect(err.rpcCode).toBe(-32000);
    expect(err.message).toStartWith("ERR_EXTENSION_MIGRATION_NOT_APPROVED:");
    expect(err.rpcData).toEqual({ code: "ERR_EXTENSION_MIGRATION_NOT_APPROVED" });
  });

  test("accept and decline require an id", async () => {
    const e = fakeEngine();
    for (const method of ["migration.accept", "migration.decline"]) {
      const err = await rpcErrorOf(
        dispatchMigrationRpc(
          method,
          { id: " " },
          { engine: e.ctxEngine, ownerGate: async () => true },
        ),
      );
      expect(err.rpcCode).toBe(-32602);
    }
    expect(e.calls).toEqual([]);
  });

  test("decline returns the declined row", async () => {
    const e = fakeEngine();
    const out = await dispatchMigrationRpc(
      "migration.decline",
      { id: "m-1" },
      { engine: e.ctxEngine },
    );
    expect((out as { value: Record<string, unknown> }).value["state"]).toBe("declined");
    expect(e.calls).toEqual(["decline:m-1"]);
  });

  test("retry calls the engine's retry (B10), then lists", async () => {
    const e = fakeEngine();
    const out = await dispatchMigrationRpc("migration.retry", {}, { engine: e.ctxEngine });
    expect(e.calls).toEqual(["retry", "list"]);
    expect((out as { value: { migrations: unknown[] } }).value.migrations).toHaveLength(1);
  });

  test("an error that names a path never echoes it, in a row or in a refusal", async () => {
    const leaky =
      "the extension could not be installed: EBUSY: resource busy, rmdir 'C:\\Users\\o\\data\\extensions\\x'";
    const e = fakeEngine({
      list: () => [
        { ...ROW, state: "failed", error: `${leaky} and /home/o/.local/share/nimbus/x` },
      ],
      decline: () => {
        throw new MigrationError("ERR_EXTENSION_MIGRATION_FAILED", leaky);
      },
    });
    const listed = await dispatchMigrationRpc("migration.list", {}, { engine: e.ctxEngine });
    const text = JSON.stringify(listed);
    expect(text).not.toContain("Users");
    expect(text).not.toContain("/home/o");
    expect(text).toContain("<path>");
    const err = await rpcErrorOf(
      dispatchMigrationRpc("migration.decline", { id: "m-1" }, { engine: e.ctxEngine }),
    );
    expect(err.message).not.toContain("Users");
    expect(err.message).toStartWith("ERR_EXTENSION_MIGRATION_FAILED:");
  });

  test("a non-migration error is not remapped", async () => {
    const boom = new Error("boom");
    const e = fakeEngine({
      decline: () => {
        throw boom;
      },
    });
    await expect(
      dispatchMigrationRpc("migration.decline", { id: "m-1" }, { engine: e.ctxEngine }),
    ).rejects.toBe(boom);
  });

  test("an unknown migration.* verb is a miss", async () => {
    const e = fakeEngine();
    expect(await dispatchMigrationRpc("migration.evaluate", {}, { engine: e.ctxEngine })).toEqual({
      kind: "miss",
    });
  });
});

describe("redactMigrationPaths", () => {
  test.each([
    ["C:\\Users\\o\\data", "<path>"],
    ["C:/Users/o/data", "<path>"],
    ["\\\\server\\share\\x", "<path>"],
    ["open '/var/lib/nimbus/x'", "open '<path>'"],
    ["file:///home/o/registry/index.json missing", "<path> missing"],
    ["(/tmp/a)", "(<path>)"],
  ])("%s", (input, expected) => {
    expect(redactMigrationPaths(input)).toBe(expected);
  });

  test("a URL, a code and a plain sentence pass through", () => {
    const s =
      "ERR_REGISTRY_UNREACHABLE: https://registry.nimbus.test/index.json ENOTFOUND — run `nimbus connector migrate retry`";
    expect(redactMigrationPaths(s)).toBe(s);
  });
});

describe("redactMigrationPaths with the gateway's roots (fix round 1: paths with a space)", () => {
  const MAC_DATA = "/Users/jane/Library/Application Support/Nimbus/data";
  const WIN_HOME = String.raw`C:\Users\John Smith`;
  const WIN_DATA = String.raw`C:\Users\John Smith\AppData\Roaming\Nimbus\data`;

  test("the macOS data root, which contains a space, is redacted whole", () => {
    const input = `rmdir ${MAC_DATA}/migrations/m-1/pkg failed`;
    // The reviewer's input, against the pattern pass alone (what the first version did): leaks.
    expect(redactMigrationPaths(input, [], "darwin")).toContain("Support/Nimbus");
    expect(redactMigrationPaths(input, [MAC_DATA, "/Users/jane"], "darwin")).toBe(
      "rmdir <path> failed",
    );
  });

  test("a Windows profile with a space is redacted whole", () => {
    expect(redactMigrationPaths(String.raw`${WIN_DATA}\x`, [WIN_DATA, WIN_HOME], "win32")).toBe(
      "<path>",
    );
  });

  test("on Windows the root matches in any case and with either separator", () => {
    const roots = [WIN_DATA, WIN_HOME];
    expect(
      redactMigrationPaths(
        String.raw`c:\users\JOHN SMITH\appdata\roaming\nimbus\DATA\x and more`,
        roots,
        "win32",
      ),
    ).toBe("<path> and more");
    expect(
      redactMigrationPaths(
        "open C:/Users/John Smith/AppData/Roaming/Nimbus/data/z",
        roots,
        "win32",
      ),
    ).toBe("open <path>");
  });

  test("a quoted path with a space outside every root is redacted whole; a quoted URL is kept", () => {
    expect(
      redactMigrationPaths(
        String.raw`EBUSY: resource busy or locked, rmdir 'D:\Other Place\x y\z'`,
      ),
    ).toBe("EBUSY: resource busy or locked, rmdir '<path>'");
    expect(redactMigrationPaths('open "/srv/my data/x"')).toBe('open "<path>"');
    expect(redactMigrationPaths('fetch "https://registry.example/index.json"')).toBe(
      'fetch "https://registry.example/index.json"',
    );
  });

  test("a root given with trailing separators is still redacted, and a hostile input is linear", () => {
    expect(redactMigrationPaths("rm /srv/my data/x ok", ["/srv/my data///"], "linux")).toBe(
      "rm <path> ok",
    );
    expect(redactMigrationPaths("rm /srv/my data/x ok", ["/srv/my data/\\/\\"], "linux")).toBe(
      "rm <path> ok",
    );
    const t0 = performance.now();
    redactMigrationPaths(`'${"a".repeat(50_000)}`);
    redactMigrationPaths("'a".repeat(20_000));
    redactMigrationPaths("x", [`/root${"/".repeat(50_000)}`, `/r${"/\\".repeat(50_000)}`]);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  test("a quoted span splits at its first separator and still matches whole", () => {
    expect(redactMigrationPaths("rmdir 'a b/c d\\e f' done")).toBe("rmdir '<path>' done");
    expect(redactMigrationPaths("say 'hello world' now")).toBe("say 'hello world' now");
  });

  test("a message with no path is unchanged, roots or not", () => {
    const s = "the staged package is missing — run `nimbus connector migrate retry`";
    expect(redactMigrationPaths(s, [MAC_DATA, "/Users/jane"], "darwin")).toBe(s);
  });

  test("the RPC redacts row errors and refusals with the context's roots", async () => {
    const e = fakeEngine({
      list: () => [{ ...ROW, state: "failed", error: `cannot remove ${MAC_DATA}/extensions/x` }],
    });
    const out = await dispatchMigrationRpc(
      "migration.list",
      {},
      { engine: e.ctxEngine, redactRoots: [MAC_DATA] },
    );
    expect(JSON.stringify(out)).not.toContain("Support");
  });
});
