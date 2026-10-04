import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLACK_CANCEL,
  clearFixture,
  FAKE_SOCKET_PATH,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import type { CliPlatformPaths } from "../paths.ts";
import type { ConnectorDetectDeps, FindingWire } from "./connector-detect.ts";
import type { InitEffects } from "./init.ts";

// Imported AFTER cli-mocks: gateway-state reads below go to the in-process fake in every run --
// alone, or in the whole-repo run where another file's process-global mock may already be live.
const { readGatewayState } = await import("../lib/gateway-process.ts");
const { defaultInitDeps, runInit } = await import("./init.ts");

let dir: string;

/** Paths pinned inside the test's own temp dir, so nothing here can reach the real install. */
function fakePaths(): CliPlatformPaths {
  return {
    configDir: join(dir, "config"),
    dataDir: join(dir, "data"),
    logDir: join(dir, "data", "logs"),
    socketPath: join(dir, "nimbus.sock"),
    extensionsDir: join(dir, "data", "extensions"),
    tempDir: join(dir, "tmp"),
  };
}

/** Every effect throws unless the test supplies it, so each test proves which ones it reached. */
function effects(over: Partial<InitEffects> = {}): InitEffects {
  return {
    runStart: async () => {
      throw new Error("unexpected runStart");
    },
    connectorDetectDeps: () => {
      throw new Error("unexpected connectorDetectDeps");
    },
    confirm: async () => {
      throw new Error("unexpected confirm");
    },
    runWow: async () => {
      throw new Error("unexpected runWow");
    },
    ...over,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-init-cov-"));
  // Precondition: the state read is the fake. The real one would find no state file under this
  // fresh temp dir and return undefined, failing here rather than in a test that then waits out
  // `awaitGatewayState`'s real 5 s budget.
  setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
  const seen: unknown = await readGatewayState(fakePaths());
  expect(seen).toEqual({ socketPath: FAKE_SOCKET_PATH });
  clearFixture();
});

afterEach(() => {
  clearFixture();
  process.exitCode = 0;
  rmSync(dir, { recursive: true, force: true });
});

describe("defaultInitDeps().startGateway -- runStart's own verdict, then the state file", () => {
  test("runs `start --no-wizard`, ignores a STALE exit code, and is ready once the state is there", async () => {
    const calls: string[][] = [];
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    // Left over from an earlier step -- must not read as runStart having failed.
    process.exitCode = 1;
    const deps = defaultInitDeps(
      fakePaths(),
      effects({
        runStart: async (args) => {
          calls.push(args);
        },
      }),
    );
    expect(await deps.startGateway()).toBe(true);
    // Never the onboarding wizard: init is already the onboarding.
    expect(calls).toEqual([["--no-wizard"]]);
    expect(process.exitCode).toBe(0);
  });

  test("a runStart that reports failure is not ready -- even with state present -- and leaves no exit code", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    const deps = defaultInitDeps(
      fakePaths(),
      effects({
        runStart: async () => {
          process.exitCode = 1;
        },
      }),
    );
    expect(await deps.startGateway()).toBe(false);
    // runInit derives init's own code from the outcome; a stale 1 here would shadow it.
    expect(process.exitCode).toBe(0);
  });
});

describe("defaultInitDeps().syncFilesystem / demoSymbol -- the RPCs init sends a running gateway", () => {
  // `init.test.ts` reaches these two only with NO gateway, where they throw before sending
  // anything, so the method names and params init actually sends were pinned nowhere.
  function gatewayAnswering(reply: unknown): Array<{ method: string; params: unknown }> {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async (): Promise<void> => {},
        disconnect: async (): Promise<void> => {},
        call: async (method: string, params: unknown): Promise<unknown> => {
          calls.push({ method, params });
          return reply;
        },
      },
    });
    return calls;
  }

  test("syncFilesystem asks for a sync of the filesystem connector, and only that", async () => {
    const calls = gatewayAnswering({ ok: true });
    await defaultInitDeps(fakePaths(), effects()).syncFilesystem();
    expect(calls).toEqual([{ method: "connector.sync", params: { serviceId: "filesystem" } }]);
  });

  test("demoSymbol asks index.demoSymbol about THIS repo root and returns the validated reply", async () => {
    const calls = gatewayAnswering({ file: "src/auth.ts", line: 42, name: "verifyToken" });
    const demo = await defaultInitDeps(fakePaths(), effects()).demoSymbol(join(dir, "repo"));
    expect(calls).toEqual([
      { method: "index.demoSymbol", params: { repoRoot: join(dir, "repo") } },
    ]);
    expect(demo).toEqual({ file: "src/auth.ts", line: 42, name: "verifyToken" });
  });

  test("a malformed index.demoSymbol reply degrades to null rather than a bogus location", async () => {
    gatewayAnswering({ file: "src/auth.ts", line: "42" });
    expect(await defaultInitDeps(fakePaths(), effects()).demoSymbol(join(dir, "repo"))).toBeNull();
  });
});

describe("defaultInitDeps().offerLocalAuth -- the walk on a TTY, one line otherwise", () => {
  const GH_AVAILABLE: FindingWire = {
    source: "gh",
    status: "available",
    alreadyConfigured: false,
    accounts: ["octo"],
    activeAccount: "octo",
  };

  function detectDeps(findings: FindingWire[], log: string[]): ConnectorDetectDeps {
    return {
      detect: async () => findings,
      adopt: async () => {
        throw new Error("unexpected adopt");
      },
      // The walk's OWN flag: false, so it lists what it found without prompting for a pick.
      interactive: false,
      ask: async () => {
        throw new Error("unexpected ask");
      },
      log: (l) => {
        log.push(l);
      },
    };
  }

  test("non-interactive: prints only the one-line count, never the walk, against init's own paths", async () => {
    const paths = fakePaths();
    const walkLog: string[] = [];
    const asked: CliPlatformPaths[] = [];
    const deps = defaultInitDeps(
      paths,
      effects({
        connectorDetectDeps: (p) => {
          asked.push(p);
          return detectDeps([GH_AVAILABLE], walkLog);
        },
      }),
    );
    const out = captureOutput();
    try {
      await deps.offerLocalAuth(false);
    } finally {
      out.restore();
    }
    expect(out.stdout).toBe(
      "Found 1 local login Nimbus can reuse — run: nimbus connector detect\n",
    );
    expect(walkLog).toEqual([]);
    expect(asked).toEqual([paths]);
  });

  test("non-interactive with nothing adoptable prints nothing at all", async () => {
    const walkLog: string[] = [];
    const deps = defaultInitDeps(
      fakePaths(),
      effects({
        connectorDetectDeps: () =>
          detectDeps([{ ...GH_AVAILABLE, alreadyConfigured: true }], walkLog),
      }),
    );
    const out = captureOutput();
    try {
      await deps.offerLocalAuth(false);
    } finally {
      out.restore();
    }
    expect(out.stdout).toBe("");
    expect(walkLog).toEqual([]);
  });

  test("interactive: runs the connector-detect walk instead of printing the count", async () => {
    const walkLog: string[] = [];
    const deps = defaultInitDeps(
      fakePaths(),
      effects({ connectorDetectDeps: () => detectDeps([GH_AVAILABLE], walkLog) }),
    );
    const out = captureOutput();
    try {
      await deps.offerLocalAuth(true);
    } finally {
      out.restore();
    }
    expect(walkLog[0]).toBe("Local logins Nimbus can reuse:");
    expect(walkLog.at(-1)).toBe("Run `nimbus connector detect` in a terminal to connect these.");
    expect(out.stdout).not.toContain("Found 1 local login");
  });
});

describe("defaultInitDeps().confirmTour / runTour", () => {
  test.each([
    ["an explicit yes", true, true],
    ["a no", false, false],
    // The value the (mocked) prompt actually returns on Esc / Ctrl-C -- the one `isCancel` knows.
    ["a cancel (Esc / Ctrl-C)", CLACK_CANCEL, false],
    ["a truthy non-boolean", "yes", false],
  ])("confirmTour on %s resolves %p", async (_label, answer, expected) => {
    const asked: Array<{ message: string; initialValue: boolean }> = [];
    const deps = defaultInitDeps(
      fakePaths(),
      effects({
        confirm: async (opts) => {
          asked.push(opts);
          return answer;
        },
      }),
    );
    expect(await deps.confirmTour()).toBe(expected);
    expect(asked).toEqual([{ message: "Run the tour now?", initialValue: true }]);
  });

  test("runTour runs `nimbus wow` with no arguments", async () => {
    const calls: string[][] = [];
    const deps = defaultInitDeps(
      fakePaths(),
      effects({
        runWow: async (args) => {
          calls.push(args);
        },
      }),
    );
    await deps.runTour();
    expect(calls).toEqual([[]]);
  });
});

describe("defaultInitDeps().interactive -- prompts only when BOTH ends are a terminal", () => {
  const saved = {
    stdin: undefined as PropertyDescriptor | undefined,
    stdout: undefined as PropertyDescriptor | undefined,
  };

  function setTty(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): void {
    Object.defineProperty(stream, "isTTY", { value, configurable: true, writable: true });
  }

  function restoreTty(
    stream: NodeJS.ReadStream | NodeJS.WriteStream,
    d: PropertyDescriptor | undefined,
  ): void {
    if (d === undefined) Reflect.deleteProperty(stream, "isTTY");
    else Object.defineProperty(stream, "isTTY", d);
  }

  beforeEach(() => {
    saved.stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    saved.stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  });

  afterEach(() => {
    restoreTty(process.stdin, saved.stdin);
    restoreTty(process.stdout, saved.stdout);
  });

  test.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
  ])("stdin TTY %p, stdout TTY %p -> interactive %p", (stdinTty, stdoutTty, expected) => {
    setTty(process.stdin, stdinTty);
    setTty(process.stdout, stdoutTty);
    expect(defaultInitDeps(fakePaths(), effects()).interactive).toBe(expected);
  });
});

test("runInit with no deps at all prints its help through the real console and does no work", async () => {
  // These are the REAL deps: a regression that stopped returning after --help would go on to add
  // the current directory to nimbus.toml and start a gateway. Run it from a directory that is not
  // a repository, with the config dir pinned inside the temp dir, so that regression stops at
  // "not a git repository" here instead of editing the developer's real install.
  const savedCwd = process.cwd();
  const savedEnv = {
    NIMBUS_CONFIG_DIR: process.env["NIMBUS_CONFIG_DIR"],
    NIMBUS_DEMO: process.env["NIMBUS_DEMO"],
  };
  process.env["NIMBUS_CONFIG_DIR"] = join(dir, "config");
  // A demo root refuses a config-dir override outright; neither is under test here.
  delete process.env["NIMBUS_DEMO"];
  process.chdir(dir);
  const out = captureOutput();
  try {
    expect(existsSync(join(process.cwd(), ".git"))).toBe(false);
    await runInit(["--help"]);
  } finally {
    out.restore();
    // Back out of `dir` before afterEach removes it: Windows will not delete a process's cwd.
    process.chdir(savedCwd);
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  expect(out.stdout).toStartWith(
    "nimbus init — index the git repository in the current directory\n",
  );
  expect(out.stdout).toContain("  2  the Gateway never became ready — nothing was indexed\n");
  expect(out.stderr).toBe("");
  expect(process.exitCode).toBe(0);
  expect(existsSync(join(dir, "config", "nimbus.toml"))).toBe(false);
});
