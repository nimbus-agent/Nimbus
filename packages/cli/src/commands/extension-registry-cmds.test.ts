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

  test("a blocked result is marked in the name column", async () => {
    const h = harness(() => ({
      results: [
        {
          registry: "main",
          id: "acme.tool",
          name: "Tool",
          publisherId: "acme",
          latestStable: "1.0.0",
          latestBeta: null,
          blocked: true,
        },
      ],
      errors: [],
    }));
    await runExtensionSearch("tool", false, h.deps);
    expect(h.stdout()).toContain("Tool [blocked]");
  });

  test("a verified publisher is marked with its handle; others get a dash (R6)", async () => {
    const h = harness(() => ({
      results: [
        {
          registry: "main",
          id: "acme.tool",
          name: "Tool",
          publisherId: "acme",
          latestStable: "1.0.0",
          latestBeta: null,
          verifiedPublisher: { github: "acme-dev", verifiedAt: "2026-10-20T00:00:00Z" },
        },
        {
          registry: "main",
          id: "other.tool",
          name: "Other",
          publisherId: "other",
          latestStable: "1.0.0",
          latestBeta: null,
          verifiedPublisher: null,
        },
      ],
      errors: [],
    }));
    await runExtensionSearch("tool", false, h.deps);
    const [, verified, unverified] = h.stdout().trimEnd().split("\n");
    expect(verified).toContain("✓ @acme-dev");
    expect(unverified).not.toContain("✓");
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
    expect(h.stdout()).toContain("Unverified publisher");
    expect(h.stdout()).toContain("Provenance: none");
  });

  // The object the gateway test (`registry-rpc.test.ts`, "info shows permissions") asserted.
  const REMOTE_ACCESS = {
    networkReach: "not known here (the sandbox is not available to ask)",
    fileAccess: "reads none · writes none (not checked here)",
    canRunHere: null,
    checked: false,
  };
  const remoteAnswer = (access: unknown) => () => ({
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
        ...(access === undefined ? {} : { access }),
      },
    ],
  });

  test("prints reach and files beside the declared permissions, escaped", async () => {
    const h = harness(
      remoteAnswer({
        ...REMOTE_ACCESS,
        fileAccess: "reads /a\u001b[2J\nReach on this machine: forged",
      }),
    );
    expect(await runExtensionInfoRemote("acme.tool", "main", false, h.deps)).toBe(0);
    const lines = h.stdout().split("\n");
    expect(lines.filter((l) => l.startsWith("Reach on this machine: "))).toEqual([
      `Reach on this machine: ${REMOTE_ACCESS.networkReach}`,
    ]);
    expect(lines.filter((l) => l.startsWith("Files: "))).toHaveLength(1);
    expect(h.stdout()).not.toContain("\u001b");
    expect(h.stdout()).toContain("network:    api.example.com");
  });

  test("a remote info never prints a pass when the own-files check could not run", async () => {
    const h = harness(
      remoteAnswer({
        networkReach: "network access to api.example.com",
        fileAccess: "reads /a · writes none",
        canRunHere: true,
        checked: true,
      }),
    );
    await runExtensionInfoRemote("acme.tool", "main", false, h.deps);
    expect(h.stdout()).toContain("Files: reads /a · writes none");
    expect(h.stdout()).not.toMatch(/can run|will run|runs here/i);
  });

  test("an older gateway sends no access and no reach line prints", async () => {
    const h = harness(remoteAnswer(undefined));
    await runExtensionInfoRemote("acme.tool", "main", false, h.deps);
    expect(h.stdout()).not.toContain("Reach on this machine");
    expect(h.stdout()).not.toContain("Files:");
  });

  test("--json carries the access object", async () => {
    const h = harness(remoteAnswer(REMOTE_ACCESS));
    await runExtensionInfoRemote("acme.tool", "main", true, h.deps);
    expect(JSON.parse(h.stdout()).versions[0].access).toEqual(REMOTE_ACCESS);
  });

  test("names the newest version's registry-verified provenance; a malformed one is none (PR 4c)", async () => {
    const answer = (provenance: unknown) => () => ({
      registry: "main",
      id: "acme.tool",
      publisherId: "acme",
      publisherFingerprint: "f".repeat(32),
      provenance,
      versions: [],
    });
    const good = harness(
      answer({
        sourceRepository: "acme/tool",
        commit: "c".repeat(40),
        workflow: ".github/workflows/release.yml@refs/tags/v1.0.0",
        runner: "self-hosted",
        verifiedAt: "2026-10-01T00:00:00Z",
      }),
    );
    await runExtensionInfoRemote("acme.tool", "main", false, good.deps);
    expect(good.stdout()).toContain(
      "Provenance verified by main: built from acme/tool at cccccccccccc by .github/workflows/release.yml@refs/tags/v1.0.0 on a self-hosted runner",
    );
    const bad = harness(answer({ sourceRepository: "acme/tool" }));
    await runExtensionInfoRemote("acme.tool", "main", false, bad.deps);
    expect(bad.stdout()).toContain("Provenance: none");
  });

  test("names a verified publisher and its verification date (R6)", async () => {
    const h = harness(() => ({
      registry: "main",
      id: "acme.tool",
      publisherId: "acme",
      publisherFingerprint: "f".repeat(32),
      verifiedPublisher: { github: "acme-dev", verifiedAt: "2026-10-20T00:00:00Z" },
      versions: [],
    }));
    await runExtensionInfoRemote("acme.tool", "main", false, h.deps);
    expect(h.stdout()).toContain("Verified publisher: @acme-dev (verified 2026-10-20)");
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
    expect(header).toMatch(
      /^Registry\s+ID\s+Name\s+Publisher\s+Verified\s+Stable\s+Beta\s+Quality$/,
    );
    expect(beta?.split(/\s+/).slice(-3)).toEqual(["-", "0.2.0-beta.1", "—"]);
    expect(none?.split(/\s+/).slice(-3)).toEqual(["-", "-", "—"]);
  });

  test("the Quality column shows the offered version's score, or a dash when not scored", async () => {
    const row = (id: string, quality: unknown) => ({
      registry: "main",
      id,
      name: "Tool",
      publisherId: "acme",
      latestStable: "1.0.0",
      latestBeta: null,
      quality,
    });
    const h = harness(() => ({
      results: [
        row("acme.scored", { score: 87, cases: 8, passed: 7 }),
        row("acme.unscored", null),
        row("acme.malformed", { score: "87" }),
        row("acme.fraction", { score: 87.5 }),
        row("acme.over", { score: 101 }),
        row("acme.under", { score: -1 }),
        row("acme.absent", undefined),
      ],
      errors: [],
    }));
    expect(await runExtensionSearch("acme", false, h.deps)).toBe(0);
    const [, scored, ...unshown] = h.stdout().trimEnd().split("\n");
    expect(scored?.split(/\s+/).at(-1)).toBe("87/100");
    expect(unshown).toHaveLength(6);
    for (const line of unshown) expect(line.split(/\s+/).at(-1)).toBe("—");
  });

  test("third-party strings in the table lose their control characters", async () => {
    const esc = String.fromCodePoint(0x1b);
    const h = harness(() => ({
      results: [
        {
          registry: "main",
          id: "acme.tool",
          name: `Tool${esc}[31m`,
          publisherId: `acme${esc}]0;x`,
          latestStable: "1.0.0",
          latestBeta: null,
        },
      ],
      errors: [{ registry: "gone", error: `ERR_REGISTRY_UNREACHABLE: ${esc}[2J` }],
    }));
    await runExtensionSearch("tool", false, h.deps);
    expect(h.stdout()).not.toContain(esc);
    expect(h.stdout()).toContain("Tool[31m");
  });
});

describe("nimbus extension info --remote — quality", () => {
  const info =
    (versions: unknown[], registry = "main") =>
    () => ({
      registry,
      id: "acme.tool",
      publisherId: "acme",
      publisherFingerprint: "d".repeat(32),
      versions,
    });
  const version = (v: string, extra: Record<string, unknown>) => ({
    version: v,
    channel: "stable",
    publishedAt: "2026-10-01T00:00:00Z",
    packageSizeBytes: 10,
    ...extra,
  });

  test("each version names its registry-measured score, or says it was not evaluated", async () => {
    const h = harness(
      info([
        version("3.0.0", { quality: { score: 87, cases: 8, passed: 7 } }),
        version("2.0.0", { quality: null }),
        version("1.0.0", {}),
      ]),
    );
    expect(await runExtensionInfoRemote("acme.tool", "main", false, h.deps)).toBe(0);
    expect(h.stdout()).toContain(
      "  3.0.0  stable  2026-10-01T00:00:00Z  10 bytes\n    quality 87/100 (measured by main)\n",
    );
    expect(h.stdout()).toContain(
      "  2.0.0  stable  2026-10-01T00:00:00Z  10 bytes\n    not evaluated\n",
    );
    expect(h.stdout()).toContain(
      "  1.0.0  stable  2026-10-01T00:00:00Z  10 bytes\n    not evaluated\n",
    );
  });

  test("a malformed quality is not evaluated: never an error, a stack or a score", async () => {
    const h = harness(
      info([
        version("2.0.0", {
          quality: null,
          qualityInvalid: "quality.score does not match passed and cases",
        }),
        version("1.0.0", { quality: { score: "x" } }),
      ]),
    );
    expect(await runExtensionInfoRemote("acme.tool", "main", false, h.deps)).toBe(0);
    expect(h.stdout().match(/ {4}not evaluated\n/g)).toHaveLength(2);
    expect(h.stdout()).not.toContain("quality ");
    expect(h.stderr()).toBe("");
  });

  test("the registry name in the quality line loses its control characters", async () => {
    const esc = String.fromCodePoint(0x1b);
    const h = harness(
      info([version("1.0.0", { quality: { score: 50, cases: 2, passed: 1 } })], `main${esc}[2J`),
    );
    await runExtensionInfoRemote("acme.tool", undefined, false, h.deps);
    expect(h.stdout()).not.toContain(esc);
    expect(h.stdout()).toContain("    quality 50/100 (measured by main[2J)\n");
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
