import { describe, expect, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";
import { registryAddPrecheck, runRegistryClient } from "./registry-client-cmds.ts";

function harness(responses: Record<string, unknown> = {}, isTty = true) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const handlers: string[] = [];
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return responses[method];
    },
    onNotification: (name: string) => {
      handlers.push(name);
    },
  } as unknown as IPCClient;
  let out = "";
  let err = "";
  return {
    calls,
    handlers,
    deps: {
      client,
      isTty,
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

describe("nimbus registry add", () => {
  test("refuses without a TTY and calls nothing", async () => {
    const h = harness({}, false);
    expect(await runRegistryClient("add", ["main", "https://r.example/"], h.deps)).toBe(2);
    expect(h.stderr()).toContain("nimbus registry add needs an interactive terminal");
    expect(h.calls).toEqual([]);
  });

  test("rejects --yes", async () => {
    const h = harness();
    expect(await runRegistryClient("add", ["main", "https://r.example/", "--yes"], h.deps)).toBe(2);
    expect(h.stderr()).toContain("no --yes");
    expect(h.calls).toEqual([]);
  });

  test("registers the prompt handler directly and passes the fingerprint through unmodified", async () => {
    const h = harness({
      "registry.add": {
        name: "main",
        url: "https://r.example/",
        rootFingerprint: "a".repeat(32),
        extensionCount: 2,
        generatedAt: "2026-10-18T00:00:00Z",
      },
    });
    const code = await runRegistryClient(
      "add",
      ["main", "https://r.example/", "--fingerprint", "ABC"],
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.handlers).toEqual(["consent.request"]);
    expect(h.calls).toEqual([
      {
        method: "registry.add",
        params: { name: "main", url: "https://r.example/", fingerprint: "ABC" },
      },
    ]);
    expect(h.stdout()).toContain("Added registry main");
  });
});

describe("nimbus registry add: option handling", () => {
  test("--fingerprint=<fp> passes the value through", async () => {
    const h = harness({
      "registry.add": {
        name: "m",
        url: "u",
        rootFingerprint: "x",
        extensionCount: 0,
        generatedAt: "g",
      },
    });
    expect(await runRegistryClient("add", ["m", "u", "--fingerprint=ABC"], h.deps)).toBe(0);
    expect(h.calls[0]?.params).toEqual({ name: "m", url: "u", fingerprint: "ABC" });
  });

  test("--fingerprint with no value refuses", async () => {
    for (const args of [
      ["m", "u", "--fingerprint"],
      ["m", "u", "--fingerprint="],
    ]) {
      const h = harness();
      expect(await runRegistryClient("add", args, h.deps)).toBe(2);
      expect(h.stderr()).toContain("--fingerprint needs a value");
      expect(h.calls).toEqual([]);
    }
  });

  test("an unknown flag refuses", async () => {
    const h = harness();
    expect(await runRegistryClient("add", ["m", "u", "--finger", "x"], h.deps)).toBe(2);
    expect(h.stderr()).toContain("unknown option --finger");
    expect(h.calls).toEqual([]);
  });

  test("the precheck refuses a non-TTY add without any client", () => {
    let err = "";
    expect(
      registryAddPrecheck(["m", "u"], false, (m) => {
        err += m;
      }),
    ).toBe(2);
    expect(err).toContain("interactive terminal");
  });
});

describe("nimbus registry list", () => {
  test("prints name, url, fingerprint and staleness", async () => {
    const h = harness({
      "registry.list": {
        registries: [
          {
            name: "main",
            url: "https://r.example/",
            rootFingerprint: "f".repeat(32),
            extensionCount: null,
            lastFetchedAt: null,
            generatedAt: "2026-01-01T00:00:00Z",
            stale: true,
          },
        ],
      },
    });
    expect(await runRegistryClient("list", [], h.deps)).toBe(0);
    const out = h.stdout();
    expect(out).toContain("main");
    expect(out).toContain("https://r.example/");
    expect(out).toContain("f".repeat(32));
    expect(out).toContain("stale");
    expect(out).toContain("never");
  });

  test("says so when there are none", async () => {
    const h = harness({ "registry.list": { registries: [] } });
    expect(await runRegistryClient("list", [], h.deps)).toBe(0);
    expect(h.stdout()).toContain("no registries");
  });
});

describe("nimbus registry refresh / remove", () => {
  test("refresh exits 1 when any registry failed", async () => {
    const h = harness({
      "registry.refresh": {
        results: [
          { name: "a", ok: true, sequence: 4, extensionCount: 1 },
          { name: "b", ok: false, error: "ERR_REGISTRY_ROLLBACK: older" },
        ],
      },
    });
    expect(await runRegistryClient("refresh", [], h.deps)).toBe(1);
    expect(h.stdout()).toContain("a: ok");
    expect(h.stdout()).toContain("b: FAILED ERR_REGISTRY_ROLLBACK");
  });

  test("refresh <name> sends the name", async () => {
    const h = harness({ "registry.refresh": { results: [] } });
    await runRegistryClient("refresh", ["main"], h.deps);
    expect(h.calls[0]?.params).toEqual({ name: "main" });
  });

  test("remove names the extensions that stay installed", async () => {
    const h = harness({ "registry.remove": { removed: true, orphanedExtensions: ["acme.tool"] } });
    expect(await runRegistryClient("remove", ["main"], h.deps)).toBe(0);
    expect(h.stdout()).toContain("acme.tool");
  });

  test("remove without a name prints usage", async () => {
    const h = harness();
    expect(await runRegistryClient("remove", [], h.deps)).toBe(2);
    expect(h.stderr()).toContain("Usage:");
  });
});
