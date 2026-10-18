import { describe, expect, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";
import { runExtensionInfoRemote, runExtensionSearch } from "./extension-registry-cmds.ts";

function harness(handler: (method: string, params: unknown) => unknown) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return handler(method, params);
    },
  } as unknown as IPCClient;
  let out = "";
  let err = "";
  return {
    calls,
    deps: {
      client,
      stdout: (s: string) => {
        out += s;
      },
      stderr: (s: string) => {
        err += s;
      },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

describe("nimbus extension search", () => {
  test("prints a table tagged with the registry, then one line per failing registry", async () => {
    const h = harness(() => ({
      results: [
        {
          registry: "main",
          id: "acme.tool",
          name: "Tool",
          publisherId: "acme",
          latestStable: "1.0.0",
          latestBeta: null,
        },
      ],
      errors: [{ registry: "gone", error: "ERR_REGISTRY_UNREACHABLE: nope" }],
    }));
    expect(await runExtensionSearch("tool", false, h.deps)).toBe(0);
    expect(h.calls).toEqual([{ method: "registry.search", params: { query: "tool" } }]);
    const lines = h.stdout().trimEnd().split("\n");
    expect(lines[0]).toContain("Registry");
    expect(lines[1]).toContain("main");
    expect(lines[1]).toContain("acme.tool");
    expect(lines.at(-1)).toBe("registry gone: ERR_REGISTRY_UNREACHABLE: nope");
  });

  test("an empty query is a usage error and calls nothing", async () => {
    const h = harness(() => ({}));
    expect(await runExtensionSearch("  ", false, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
  });
});

describe("nimbus extension info --remote", () => {
  test("an ambiguity error is printed and exits 1", async () => {
    const h = harness(() => {
      throw new Error("ERR_REGISTRY_AMBIGUOUS: carried by main, second");
    });
    expect(await runExtensionInfoRemote("acme.tool", undefined, false, h.deps)).toBe(1);
    expect(h.stderr()).toContain("main, second");
    expect(h.calls[0]?.params).toEqual({ id: "acme.tool" });
  });

  test("prints publisher fingerprint and the newest version's permissions", async () => {
    const h = harness(() => ({
      registry: "main",
      id: "acme.tool",
      publisherId: "acme",
      publisherFingerprint: "f".repeat(32),
      versions: [
        {
          version: "1.0.0",
          channel: "stable",
          publishedAt: "2026-10-01T00:00:00Z",
          packageSizeBytes: 10,
          permissions: { network: ["api.example.com"], filesystem: { read: [], write: [] } },
        },
      ],
    }));
    expect(await runExtensionInfoRemote("acme.tool", "main", false, h.deps)).toBe(0);
    expect(h.calls[0]?.params).toEqual({ id: "acme.tool", registry: "main" });
    expect(h.stdout()).toContain("f".repeat(32));
    expect(h.stdout()).toContain("api.example.com");
  });
});
