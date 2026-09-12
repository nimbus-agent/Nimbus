import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadSqliteVec } from "sqlite-vec";

import {
  DARWIN_SQLITE_CANDIDATES,
  DEFAULT_FULL_SQLITE_DEPS,
  type ExtensionProbeResult,
  ensureFullSqlite,
  type FullSqliteDeps,
  fullSqliteCandidates,
  installFullSqlite,
  resetFullSqliteCacheForTest,
  SQLITE_PATH_ENV,
} from "./sqlite-runtime.ts";

/**
 * Every case here drives `installFullSqlite` through INJECTED deps rather than the host.
 *
 * That is deliberate and is the reason a Windows dev box and a Linux CI runner both exercise the
 * darwin branches: the defect this module fixes is a macOS one, and a test that could only run on
 * macOS would have told us nothing on the two legs that actually gate merges. `process.platform`
 * appears in exactly one place in the production module — the deps binding — so the logic under
 * test is pure over its arguments.
 */
type Calls = { warn: string[]; debug: string[]; set: string[]; probes: number };

function makeDeps(
  over: Partial<FullSqliteDeps> & {
    existing?: readonly string[];
    env?: FullSqliteDeps["env"];
    probe?: ExtensionProbeResult;
  },
): { deps: FullSqliteDeps; calls: Calls } {
  const calls: Calls = { warn: [], debug: [], set: [], probes: 0 };
  const existing = new Set(over.existing ?? []);
  const deps: FullSqliteDeps = {
    platform: over.platform ?? "darwin",
    env: over.env ?? ((): undefined => undefined),
    exists: over.exists ?? ((p: string): boolean => existing.has(p)),
    setCustomSQLite:
      over.setCustomSQLite ??
      ((p: string): boolean => {
        calls.set.push(p);
        return true;
      }),
    probeExtensionLoad:
      over.probeExtensionLoad ??
      ((): ExtensionProbeResult => {
        calls.probes += 1;
        return over.probe ?? "works";
      }),
    warn: over.warn ?? ((_f, m): void => void calls.warn.push(m)),
    debug: over.debug ?? ((_f, m): void => void calls.debug.push(m)),
  };
  return { deps, calls };
}

describe("fullSqliteCandidates", () => {
  test("is empty off darwin, on every non-darwin platform", () => {
    for (const p of ["win32", "linux", "freebsd"] as const) {
      expect(fullSqliteCandidates(p, () => "/anything")).toEqual([]);
    }
  });

  test("on darwin, Apple Silicon before Intel", () => {
    expect(fullSqliteCandidates("darwin", () => undefined)).toEqual([...DARWIN_SQLITE_CANDIDATES]);
    expect(DARWIN_SQLITE_CANDIDATES[0]).toContain("/opt/homebrew/");
    expect(DARWIN_SQLITE_CANDIDATES[1]).toContain("/usr/local/");
  });

  test(`${SQLITE_PATH_ENV} takes precedence over both Homebrew prefixes`, () => {
    const got = fullSqliteCandidates("darwin", (n) =>
      n === SQLITE_PATH_ENV ? "/custom/libsqlite3.dylib" : undefined,
    );
    expect(got[0]).toBe("/custom/libsqlite3.dylib");
    expect(got).toHaveLength(DARWIN_SQLITE_CANDIDATES.length + 1);
  });

  test("a blank or whitespace override is ignored, not treated as a path", () => {
    for (const v of ["", "   "]) {
      expect(fullSqliteCandidates("darwin", () => v)).toEqual([...DARWIN_SQLITE_CANDIDATES]);
    }
  });

  test("a padded override is trimmed", () => {
    expect(fullSqliteCandidates("darwin", () => "  /padded.dylib  ")[0]).toBe("/padded.dylib");
  });
});

describe("installFullSqlite — off darwin", () => {
  test.each(["win32", "linux"] as const)(
    "%s is a silent no-op that touches nothing",
    (platform) => {
      // The whole-file claim in the brief: this change must be provably inert on the two platforms
      // where sqlite-vec already works. No setCustomSQLite call, no filesystem probe, no log line.
      const { deps, calls } = makeDeps({
        platform,
        exists: (): boolean => {
          throw new Error("must not probe the filesystem off darwin");
        },
        setCustomSQLite: (): boolean => {
          throw new Error("must not call setCustomSQLite off darwin");
        },
        probeExtensionLoad: (): never => {
          throw new Error("must not probe extension loading off darwin");
        },
      });
      const status = installFullSqlite(deps);
      expect(status.state).toBe("not-applicable");
      expect(status.path).toBeNull();
      expect(status.candidates).toEqual([]);
      expect(calls.warn).toEqual([]);
      expect(calls.debug).toEqual([]);
    },
  );
});

describe("installFullSqlite — darwin", () => {
  test("installs the first candidate that exists", () => {
    const { deps, calls } = makeDeps({ existing: [DARWIN_SQLITE_CANDIDATES[1] as string] });
    const status = installFullSqlite(deps);
    expect(status.state).toBe("installed");
    expect(status.path).toBe(DARWIN_SQLITE_CANDIDATES[1] as string);
    expect(calls.set).toEqual([DARWIN_SQLITE_CANDIDATES[1] as string]);
    expect(calls.warn).toEqual([]);
  });

  test("prefers the override over an existing Homebrew library", () => {
    const { deps, calls } = makeDeps({
      env: (n) => (n === SQLITE_PATH_ENV ? "/custom.dylib" : undefined),
      existing: ["/custom.dylib", DARWIN_SQLITE_CANDIDATES[0] as string],
    });
    expect(installFullSqlite(deps).path).toBe("/custom.dylib");
    expect(calls.set).toEqual(["/custom.dylib"]);
  });

  test("skips a candidate that does not exist rather than handing it to setCustomSQLite", () => {
    // Bun's setCustomSQLite throws on a bad path, and throwing at boot is worse than degrading.
    const { deps, calls } = makeDeps({
      env: (n) => (n === SQLITE_PATH_ENV ? "/absent.dylib" : undefined),
      existing: [DARWIN_SQLITE_CANDIDATES[0] as string],
    });
    expect(installFullSqlite(deps).path).toBe(DARWIN_SQLITE_CANDIDATES[0] as string);
    expect(calls.set).not.toContain("/absent.dylib");
  });

  test("no candidate exists: WARNS (not debug), names the remedy, and does not throw", () => {
    const { deps, calls } = makeDeps({ existing: [] });
    const status = installFullSqlite(deps);
    expect(status.state).toBe("not-found");
    expect(status.path).toBeNull();
    expect(calls.set).toEqual([]);
    // The level is the point of the whole change: a debug line is what hid this for five weeks.
    expect(calls.warn).toHaveLength(1);
    expect(calls.debug).toEqual([]);
    const msg = calls.warn[0] as string;
    expect(msg).toContain("brew install sqlite");
    expect(msg).toContain(SQLITE_PATH_ENV);
    expect(status.detail).toBe(msg);
  });

  test("setCustomSQLite throwing is caught and warned, never propagated", () => {
    const { deps, calls } = makeDeps({
      existing: [DARWIN_SQLITE_CANDIDATES[0] as string],
      setCustomSQLite: (): boolean => {
        throw new Error("dlopen failed");
      },
    });
    const status = installFullSqlite(deps);
    expect(status.state).toBe("error");
    expect(status.path).toBe(DARWIN_SQLITE_CANDIDATES[0] as string);
    expect(calls.warn).toHaveLength(1);
    expect(calls.warn[0]).toContain("dlopen failed");
  });

  test("a non-Error throw is stringified rather than dropped", () => {
    const { deps, calls } = makeDeps({
      existing: [DARWIN_SQLITE_CANDIDATES[0] as string],
      setCustomSQLite: (): boolean => {
        // eslint-disable-next-line no-throw-literal -- exercising the String(e) branch
        throw "not an Error";
      },
    });
    expect(installFullSqlite(deps).state).toBe("error");
    expect(calls.warn[0]).toContain("not an Error");
  });

  // The discriminator. `false` from setCustomSQLite covers two outcomes with opposite
  // consequences, and Bun documents nothing about the return value — so the level is decided by a
  // measurement, never by the charitable reading. Logging an indistinguishable state at `debug`
  // is precisely what hid issue #1029 for five weeks.
  test("false + probe says extensions WORK: benign, debug, state `rejected`", () => {
    const { deps, calls } = makeDeps({
      existing: [DARWIN_SQLITE_CANDIDATES[0] as string],
      setCustomSQLite: (): boolean => false,
      probe: "works",
    });
    const status = installFullSqlite(deps);
    expect(status.state).toBe("rejected");
    expect(calls.probes).toBe(1);
    expect(calls.warn).toEqual([]);
    expect(calls.debug).toHaveLength(1);
    expect(status.detail).toContain("CAN still load SQLite extensions");
  });

  test("false + probe says extensions are BROKEN: WARNS, state `no-extensions`", () => {
    const { deps, calls } = makeDeps({
      existing: [DARWIN_SQLITE_CANDIDATES[0] as string],
      setCustomSQLite: (): boolean => false,
      probe: "broken",
    });
    const status = installFullSqlite(deps);
    expect(status.state).toBe("no-extensions");
    expect(calls.debug).toEqual([]);
    expect(calls.warn).toHaveLength(1);
    expect(calls.warn[0]).toContain("CANNOT load SQLite extensions");
    // Names the consequence, not just the mechanism.
    expect(calls.warn[0]).toContain("Semantic search is off for this run");
  });

  test("false + probe could not run: WARNS, state `unverified` — never assumed benign", () => {
    // The safe direction when we cannot tell. A warning the operator did not need beats a silence
    // they did.
    const { deps, calls } = makeDeps({
      existing: [DARWIN_SQLITE_CANDIDATES[0] as string],
      setCustomSQLite: (): boolean => false,
      probe: "unverified",
    });
    const status = installFullSqlite(deps);
    expect(status.state).toBe("unverified");
    expect(calls.debug).toEqual([]);
    expect(calls.warn).toHaveLength(1);
    expect(calls.warn[0]).toContain("could not be determined");
  });

  test("the probe runs ONLY after a false return, never on a healthy install", () => {
    const { deps, calls } = makeDeps({ existing: [DARWIN_SQLITE_CANDIDATES[0] as string] });
    expect(installFullSqlite(deps).state).toBe("installed");
    expect(calls.probes).toBe(0);
    // Nor when there is nothing to install in the first place.
    const missing = makeDeps({ existing: [] });
    expect(installFullSqlite(missing.deps).state).toBe("not-found");
    expect(missing.calls.probes).toBe(0);
  });
});

describe("ensureFullSqlite memoisation", () => {
  test("runs its deps once and returns the same status thereafter", () => {
    resetFullSqliteCacheForTest();
    try {
      let calls = 0;
      const { deps } = makeDeps({
        existing: [DARWIN_SQLITE_CANDIDATES[0] as string],
        setCustomSQLite: (): boolean => {
          calls += 1;
          return true;
        },
      });
      const first = ensureFullSqlite(deps);
      const second = ensureFullSqlite(deps);
      expect(calls).toBe(1);
      expect(second).toBe(first);
      expect(first.state).toBe("installed");
    } finally {
      // Restore whatever the preload installed for this process, so a later file that reads the
      // status is not looking at this test's fake.
      resetFullSqliteCacheForTest();
    }
  });

  test("the real, dependency-free call is safe on this host and reports a coherent status", () => {
    resetFullSqliteCacheForTest();
    try {
      const status = ensureFullSqlite();
      if (process.platform === "darwin") {
        expect([
          "installed",
          "not-found",
          "rejected",
          "no-extensions",
          "unverified",
          "error",
        ]).toContain(status.state);
      } else {
        expect(status.state).toBe("not-applicable");
        expect(status.candidates).toEqual([]);
      }
      expect(status.detail.length).toBeGreaterThan(0);
    } finally {
      // Same reason as the test above: leave the memo as this process found it, so a later file
      // reading the status is not looking at whatever this test happened to install.
      resetFullSqliteCacheForTest();
    }
  });
});

describe("DEFAULT_FULL_SQLITE_DEPS — the production bindings themselves", () => {
  test("reports the real platform and reads the real environment", () => {
    expect(DEFAULT_FULL_SQLITE_DEPS.platform).toBe(process.platform);
    const name = "NIMBUS_SQLITE_RUNTIME_PROBE";
    expect(DEFAULT_FULL_SQLITE_DEPS.env(name)).toBeUndefined();
    process.env[name] = "probe-value";
    try {
      expect(DEFAULT_FULL_SQLITE_DEPS.env(name)).toBe("probe-value");
    } finally {
      delete process.env[name];
    }
  });

  test("`exists` is a real filesystem probe", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-sqlite-runtime-"));
    try {
      const present = join(dir, "present.dylib");
      writeFileSync(present, "");
      expect(DEFAULT_FULL_SQLITE_DEPS.exists(present)).toBe(true);
      expect(DEFAULT_FULL_SQLITE_DEPS.exists(join(dir, "absent.dylib"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`warn` writes one line to stderr; `debug` is silent unless NIMBUS_LOG_LEVEL asks", () => {
    // stderr, not pino: see writeStderr's own note on why (a 140x bundle blow-up in the
    // binary-embedded query-guard worker).
    const original = process.stderr.write.bind(process.stderr);
    const seen: string[] = [];
    process.stderr.write = ((chunk: unknown): boolean => {
      seen.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const level = process.env["NIMBUS_LOG_LEVEL"];
    try {
      delete process.env["NIMBUS_LOG_LEVEL"];
      DEFAULT_FULL_SQLITE_DEPS.warn({ candidates: ["/a"] }, "no full SQLite");
      DEFAULT_FULL_SQLITE_DEPS.debug({}, "suppressed at the default level");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe('nimbus: sqlite-runtime: no full SQLite {"candidates":["/a"]}\n');

      process.env["NIMBUS_LOG_LEVEL"] = "debug";
      DEFAULT_FULL_SQLITE_DEPS.debug({}, "now visible");
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBe("nimbus [debug]: sqlite-runtime: now visible\n");
    } finally {
      process.stderr.write = original;
      if (level === undefined) delete process.env["NIMBUS_LOG_LEVEL"];
      else process.env["NIMBUS_LOG_LEVEL"] = level;
    }
  });

  test("`probeExtensionLoad` agrees with whether sqlite-vec really loads on this host", () => {
    // A real cross-check, not a shape assertion: determine loadability independently, the way
    // reindex-vector-erasure.test.ts's canary does, and require the production probe to agree.
    // On Linux and Windows CI, where sqlite-vec does load, this pins the probe's POSITIVE answer —
    // without which "works" could be returned for any reason at all.
    let loadableHere: boolean;
    const control = new Database(":memory:");
    try {
      loadSqliteVec(control);
      control.query("SELECT vec_version()").get();
      loadableHere = true;
    } catch {
      loadableHere = false;
    } finally {
      control.close();
    }

    const answer = DEFAULT_FULL_SQLITE_DEPS.probeExtensionLoad();
    if (loadableHere) {
      expect(answer).toBe("works");
    } else {
      // Which of the two negatives depends on whether the FILE resolved, which this control cannot
      // separate — but it must not claim success.
      expect(["broken", "unverified"]).toContain(answer);
    }
  });

  test("`setCustomSQLite` is bound to Bun's own static, not re-implemented", () => {
    // Deliberately NOT invoked: it loads a shared library into the process and can only run once.
    // What is worth pinning is that the binding exists and takes a path.
    expect(typeof DEFAULT_FULL_SQLITE_DEPS.setCustomSQLite).toBe("function");
    expect(DEFAULT_FULL_SQLITE_DEPS.setCustomSQLite).toHaveLength(1);
  });
});
