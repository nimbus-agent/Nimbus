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

describe("nimbus extension search — output modes", () => {
  test("--json prints the gateway's answer verbatim, errors included", async () => {
    const answer = {
      results: [],
      errors: [{ registry: "gone", error: "ERR_REGISTRY_UNREACHABLE: nope" }],
    };
    const h = harness(() => answer);
    expect(await runExtensionSearch("tool", true, h.deps)).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual(answer);
  });

  test("no match prints a placeholder rather than an empty table", async () => {
    const h = harness(() => ({ results: [], errors: [] }));
    expect(await runExtensionSearch("nothing", false, h.deps)).toBe(0);
    expect(h.stdout()).toBe("(no matching extensions)\n");
  });

  test("an entry with no stable and no beta release shows a dash for both", async () => {
    const h = harness(() => ({
      results: [
        {
          registry: "main",
          id: "acme.beta-only",
          name: "Beta",
          publisherId: "acme",
          latestStable: null,
          latestBeta: "0.2.0-beta.1",
        },
        {
          registry: "main",
          id: "acme.none",
          name: "None",
          publisherId: "acme",
          latestStable: null,
          latestBeta: null,
        },
      ],
      errors: [],
    }));
    expect(await runExtensionSearch("acme", false, h.deps)).toBe(0);
    const [header, beta, none] = h.stdout().trimEnd().split("\n");
    expect(header).toMatch(/^Registry\s+ID\s+Name\s+Publisher\s+Stable\s+Beta$/);
    expect(beta?.split(/\s+/).slice(-2)).toEqual(["-", "0.2.0-beta.1"]);
    expect(none?.split(/\s+/).slice(-2)).toEqual(["-", "-"]);
  });
});

describe("nimbus extension info --remote — edge cases", () => {
  test("an empty id is a usage error and calls nothing", async () => {
    const h = harness(() => ({}));
    expect(await runExtensionInfoRemote(" ", "main", false, h.deps)).toBe(2);
    expect(h.stderr()).toBe(
      "Usage: nimbus extension info <id> --registry <name> | --remote [--json]\n",
    );
    expect(h.calls).toEqual([]);
  });

  test("an error that is not a registry error propagates instead of being printed", async () => {
    const h = harness(() => {
      throw new Error("ECONNRESET: socket closed");
    });
    await expect(runExtensionInfoRemote("acme.tool", undefined, false, h.deps)).rejects.toThrow(
      "ECONNRESET",
    );
    expect(h.stderr()).toBe("");
  });

  test("a non-Error rejection carrying a registry code is still printed and exits 1", async () => {
    const h = harness(() => {
      throw "ERR_REGISTRY_NOT_FOUND: acme.tool";
    });
    expect(await runExtensionInfoRemote("acme.tool", "main", false, h.deps)).toBe(1);
    expect(h.stderr()).toBe("ERR_REGISTRY_NOT_FOUND: acme.tool\n");
  });

  test("--json prints the gateway's answer verbatim", async () => {
    const answer = {
      registry: "main",
      id: "acme.tool",
      publisherId: "acme",
      publisherFingerprint: "a".repeat(32),
      versions: [],
    };
    const h = harness(() => answer);
    expect(await runExtensionInfoRemote("acme.tool", "main", true, h.deps)).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual(answer);
  });

  test("permissions print (none) for an empty grant, and a version without permissions prints none", async () => {
    const h = harness(() => ({
      registry: "main",
      id: "acme.tool",
      publisherId: "acme",
      publisherFingerprint: "b".repeat(32),
      versions: [
        {
          version: "2.0.0",
          channel: "beta",
          publishedAt: "2026-10-02T00:00:00Z",
          packageSizeBytes: 20,
          permissions: {
            network: [],
            filesystem: { read: ["~/notes"], write: ["~/out", "~/tmp"] },
          },
        },
        {
          version: "1.0.0",
          channel: "stable",
          publishedAt: "2026-10-01T00:00:00Z",
          packageSizeBytes: 10,
        },
      ],
    }));
    expect(await runExtensionInfoRemote("acme.tool", "main", false, h.deps)).toBe(0);
    const out = h.stdout();
    expect(out).toContain("  2.0.0  beta  2026-10-02T00:00:00Z  20 bytes\n");
    expect(out).toContain("  network:    (none)\n");
    expect(out).toContain("  fs read:    ~/notes\n");
    expect(out).toContain("  fs write:   ~/out, ~/tmp\n");
    expect(out).toContain("  1.0.0  stable  2026-10-01T00:00:00Z  10 bytes\n");
    // Only the version that carries permissions prints a permissions block.
    expect(out.match(/Permissions \(newest version/g)).toHaveLength(1);
  });

  test("an empty filesystem grant prints (none) for both read and write", async () => {
    const h = harness(() => ({
      registry: "main",
      id: "acme.tool",
      publisherId: "acme",
      publisherFingerprint: "c".repeat(32),
      versions: [
        {
          version: "1.0.0",
          channel: "stable",
          publishedAt: "2026-10-01T00:00:00Z",
          packageSizeBytes: 10,
          permissions: { network: ["a.example", "b.example"], filesystem: { read: [], write: [] } },
        },
      ],
    }));
    expect(await runExtensionInfoRemote("acme.tool", undefined, false, h.deps)).toBe(0);
    expect(h.stdout()).toContain("  network:    a.example, b.example\n");
    expect(h.stdout()).toContain("  fs read:    (none)\n");
    expect(h.stdout()).toContain("  fs write:   (none)\n");
  });
});
