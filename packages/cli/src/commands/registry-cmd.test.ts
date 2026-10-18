import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import type { IPCClient } from "../ipc-client/index.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import type { CliPlatformPaths } from "../paths.ts";
import {
  locateGateway,
  REGISTRY_USAGE,
  type RegistryCmdDeps,
  type RegistryGatewayDeps,
  runRegistry,
  runRegistryClientOverGateway,
} from "./registry-cmd.ts";

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
  }
}

function recorder(
  maintainCode = 0,
  opts: { clientCode?: number; isTty?: boolean } = {},
): {
  calls: string[][];
  clientCalls: Array<{ sub: string; args: string[]; isTty: boolean }>;
  err: string[];
  deps: RegistryCmdDeps;
} {
  const calls: string[][] = [];
  const clientCalls: Array<{ sub: string; args: string[]; isTty: boolean }> = [];
  const err: string[] = [];
  return {
    calls,
    clientCalls,
    err,
    deps: {
      maintain: async (args) => {
        calls.push(args);
        return maintainCode;
      },
      client: async (sub, args, isTty) => {
        clientCalls.push({ sub, args, isTty });
        return opts.clientCode ?? 0;
      },
      isTty: () => opts.isTty ?? true,
      writeErr: (s) => void err.push(s),
      exit: (code) => {
        throw new ExitCalled(code);
      },
    },
  };
}

describe("runRegistry", () => {
  test("`maintain` forwards the remaining args and returns without exiting on 0", async () => {
    const r = recorder(0);
    await expect(
      runRegistry(["maintain", "add", "dir", "pkg.tgz", "--channel", "beta"], r.deps),
    ).resolves.toBeUndefined();
    expect(r.calls).toEqual([["add", "dir", "pkg.tgz", "--channel", "beta"]]);
    expect(r.err).toEqual([]);
  });

  test("a non-zero maintain result becomes the process exit code", async () => {
    for (const code of [1, 2]) {
      const r = recorder(code);
      await expect(runRegistry(["maintain", "remove"], r.deps)).rejects.toEqual(
        new ExitCalled(code),
      );
      expect(r.calls).toEqual([["remove"]]);
    }
  });

  test("an unknown or missing subcommand prints usage, exits 2 and never runs maintain", async () => {
    for (const args of [[], ["publish"], ["Maintain"]]) {
      const r = recorder(0);
      await expect(runRegistry(args, r.deps)).rejects.toEqual(new ExitCalled(2));
      expect(r.calls).toEqual([]);
      expect(r.err).toEqual([REGISTRY_USAGE]);
    }
    // The router's usage names both halves: the gateway-backed client subcommands and maintain.
    expect(REGISTRY_USAGE).toStartWith("Usage: nimbus registry add <name> <url>");
    expect(REGISTRY_USAGE).toContain("nimbus registry maintain init|add|remove ...");
  });
});

describe("runRegistry client subcommands", () => {
  test("list/refresh/remove are routed to the client with the remaining args and the TTY state", async () => {
    for (const sub of ["list", "refresh", "remove"]) {
      const r = recorder(0, { isTty: false });
      await expect(runRegistry([sub, "main", "--json"], r.deps)).resolves.toBeUndefined();
      expect(r.clientCalls).toEqual([{ sub, args: ["main", "--json"], isTty: false }]);
      expect(r.calls).toEqual([]);
      expect(r.err).toEqual([]);
    }
  });

  test("a non-zero client result becomes the exit code", async () => {
    const r = recorder(0, { clientCode: 1 });
    await expect(runRegistry(["refresh"], r.deps)).rejects.toEqual(new ExitCalled(1));
    expect(r.clientCalls).toHaveLength(1);
  });

  test("`add` without a terminal is refused before the gateway is ever reached", async () => {
    const r = recorder(0, { isTty: false });
    await expect(runRegistry(["add", "main", "https://r.example/"], r.deps)).rejects.toEqual(
      new ExitCalled(2),
    );
    expect(r.clientCalls).toEqual([]);
    expect(r.err.join("")).toContain("needs an interactive terminal");
  });

  test("`add --yes` is refused before the gateway is ever reached, even at a terminal", async () => {
    const r = recorder(0, { isTty: true });
    await expect(
      runRegistry(["add", "main", "https://r.example/", "--yes"], r.deps),
    ).rejects.toEqual(new ExitCalled(2));
    expect(r.clientCalls).toEqual([]);
    expect(r.err.join("")).toContain("no --yes");
  });

  test("`add` that passes the precheck at a terminal reaches the client", async () => {
    const r = recorder(0, { isTty: true });
    await runRegistry(["add", "main", "https://r.example/", "--fingerprint", "ab"], r.deps);
    expect(r.clientCalls).toEqual([
      { sub: "add", args: ["main", "https://r.example/", "--fingerprint", "ab"], isTty: true },
    ]);
    expect(r.err).toEqual([]);
  });
});

function fakeGateway(
  socketPath: string | undefined,
  responses: Record<string, unknown> = {},
  opts: { demo?: boolean; callThrows?: Error } = {},
) {
  const events: string[] = [];
  const created: Array<{ socketPath: string; timeoutMs: number | undefined }> = [];
  let out = "";
  let err = "";
  const client = {
    connect: async () => void events.push("connect"),
    disconnect: async () => void events.push("disconnect"),
    call: async (method: string) => {
      events.push(`call:${method}`);
      if (opts.callThrows !== undefined) throw opts.callThrows;
      return responses[method];
    },
    onNotification: () => {},
  } as unknown as IPCClient;
  const gw: RegistryGatewayDeps = {
    locate: async () => ({ socketPath, demo: opts.demo ?? false }),
    createClient: (path, timeoutMs) => {
      created.push({ socketPath: path, timeoutMs });
      return client;
    },
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
  };
  return { gw, events, created, stdout: () => out, stderr: () => err };
}

describe("runRegistryClientOverGateway", () => {
  test("no running gateway throws the not-running hint and creates no client", async () => {
    const g = fakeGateway(undefined);
    await expect(runRegistryClientOverGateway("list", [], false, g.gw)).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
    expect(g.created).toEqual([]);
  });

  test("a demo-rooted CLI with no gateway is told to start the demo gateway", async () => {
    const g = fakeGateway(undefined, {}, { demo: true });
    await expect(runRegistryClientOverGateway("list", [], false, g.gw)).rejects.toThrow(
      "nimbus --demo start",
    );
  });

  test("connects to the located socket, runs the subcommand, then disconnects", async () => {
    const g = fakeGateway("/tmp/nimbus.sock", { "registry.list": { registries: [] } });
    expect(await runRegistryClientOverGateway("list", [], false, g.gw)).toBe(0);
    expect(g.created).toEqual([{ socketPath: "/tmp/nimbus.sock", timeoutMs: undefined }]);
    expect(g.events).toEqual(["connect", "call:registry.list", "disconnect"]);
    expect(g.stdout()).toContain("no registries added");
  });

  test("refresh uses the interactive timeout and returns 1 when a registry failed", async () => {
    const g = fakeGateway("/s", {
      "registry.refresh": { results: [{ name: "main", ok: false, error: "boom" }] },
    });
    expect(await runRegistryClientOverGateway("refresh", [], false, g.gw)).toBe(1);
    expect(g.created[0]?.timeoutMs).toBe(INTERACTIVE_RPC_TIMEOUT_MS);
    expect(g.stdout()).toBe("main: FAILED boom\n");
    expect(g.stderr()).toBe("");
  });

  test("a failing call still disconnects and the error propagates", async () => {
    const g = fakeGateway("/s", {}, { callThrows: new Error("ipc down") });
    await expect(runRegistryClientOverGateway("remove", ["main"], false, g.gw)).rejects.toThrow(
      "ipc down",
    );
    expect(g.events).toEqual(["connect", "call:registry.remove", "disconnect"]);
  });
});

describe("runRegistry with its production defaults", () => {
  const cap = createStreamCapture({ captureExit: true });
  beforeEach(() => cap.install());
  afterEach(() => {
    cap.restore();
    cap.stdoutChunks.length = 0;
    cap.stderrChunks.length = 0;
  });

  test("an unknown subcommand writes usage to the real stderr and calls process.exit(2)", async () => {
    await expect(runRegistry(["bogus"])).rejects.toThrow("process.exit(2)");
    expect(cap.stderrChunks).toEqual([REGISTRY_USAGE]);
  });

  test("`maintain` with no subcommand runs the real maintain usage path and exits 2", async () => {
    await expect(runRegistry(["maintain"])).rejects.toThrow("process.exit(2)");
    expect(cap.stderrChunks.join("")).toStartWith("Usage: nimbus registry maintain init <dir>");
    expect(cap.stdoutChunks).toEqual([]);
  });
});

describe("locateGateway", () => {
  const BASE: CliPlatformPaths = {
    configDir: "/cfg",
    dataDir: "/data",
    logDir: "/log",
    socketPath: "/data/unused.sock",
    extensionsDir: "/ext",
    tempDir: "/tmp",
    sandboxDir: "/sbx",
  };

  test("no recorded gateway means no socket, and the demo flag comes from the paths", async () => {
    const seen: CliPlatformPaths[] = [];
    const none = async (p: CliPlatformPaths) => {
      seen.push(p);
      return undefined;
    };
    expect(await locateGateway(BASE, none)).toEqual({ socketPath: undefined, demo: false });
    const demo: CliPlatformPaths = { ...BASE, demo: true };
    expect(await locateGateway(demo, none)).toEqual({ socketPath: undefined, demo: true });
    // The state is read under exactly the paths it was given (the demo root, for a demo CLI).
    expect(seen).toEqual([BASE, demo]);
  });

  test("a recorded gateway yields the socket it wrote", async () => {
    const recorded = async () => ({ pid: 4242, socketPath: "/run/g.sock" });
    expect(await locateGateway(BASE, recorded)).toEqual({
      socketPath: "/run/g.sock",
      demo: false,
    });
  });
});

describe("runRegistryClientOverGateway with the real output seams", () => {
  const cap = createStreamCapture();
  beforeEach(() => cap.install());
  afterEach(() => {
    cap.restore();
    cap.stdoutChunks.length = 0;
    cap.stderrChunks.length = 0;
  });

  function onlyTransport(responses: Record<string, unknown>): Partial<RegistryGatewayDeps> {
    const g = fakeGateway("/s", responses);
    return { locate: g.gw.locate, createClient: g.gw.createClient };
  }

  test("a subcommand's output reaches the real stdout when only the transport is replaced", async () => {
    const code = await runRegistryClientOverGateway(
      "list",
      [],
      false,
      onlyTransport({ "registry.list": { registries: [] } }),
    );
    expect(code).toBe(0);
    expect(cap.stdoutChunks.join("")).toContain("no registries added");
    expect(cap.stderrChunks).toEqual([]);
  });

  test("a usage error reaches the real stderr", async () => {
    const code = await runRegistryClientOverGateway("remove", [], false, onlyTransport({}));
    expect(code).toBe(2);
    expect(cap.stderrChunks.join("")).toStartWith("Usage: nimbus registry add");
    expect(cap.stdoutChunks).toEqual([]);
  });
});

describe("runRegistry `add` with its production defaults", () => {
  const cap = createStreamCapture({ captureExit: true });
  beforeEach(() => cap.install());
  afterEach(() => {
    cap.restore();
    cap.stdoutChunks.length = 0;
    cap.stderrChunks.length = 0;
  });

  test("`add --yes` is refused by the real router before any gateway lookup, TTY or not", async () => {
    await expect(runRegistry(["add", "main", "https://r.example/", "--yes"])).rejects.toThrow(
      "process.exit(2)",
    );
    expect(cap.stderrChunks.join("")).toContain("nimbus registry add has no --yes");
    expect(cap.stdoutChunks).toEqual([]);
  });
});
