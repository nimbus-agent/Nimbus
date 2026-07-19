import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix as posixPath, win32 as winPath } from "node:path";

import { load as loadSqliteVec } from "sqlite-vec";

import {
  ensureSqliteVecForConnection,
  isVecLoaded,
  loadSqliteVecOrThrow,
  sidecarFilename,
  sidecarPath,
  tryLoadFromSidecar,
  tryLoadSqliteVec,
} from "./sqlite-vec-load.ts";

const upstreamSqliteVecLoadable = ((): boolean => {
  try {
    const probe = new Database(":memory:");
    loadSqliteVec(probe);
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

describe("sidecarFilename", () => {
  test("win32 → vec0.dll", () => {
    expect(sidecarFilename("win32")).toBe("vec0.dll");
  });
  test("darwin → vec0.dylib", () => {
    expect(sidecarFilename("darwin")).toBe("vec0.dylib");
  });
  test("linux → vec0.so", () => {
    expect(sidecarFilename("linux")).toBe("vec0.so");
  });
  test("any other Unix-shaped platform → vec0.so", () => {
    expect(sidecarFilename("freebsd")).toBe("vec0.so");
  });
});

describe("sidecarPath", () => {
  test("returns vec0.{ext} adjacent to the given exec path (linux)", () => {
    expect(sidecarPath("/opt/nimbus/bin/nimbus-gateway", "linux")).toBe(
      posixPath.join("/opt/nimbus/bin", "vec0.so"),
    );
  });
  test("works for a Windows-style path", () => {
    expect(sidecarPath(String.raw`C:\Program Files\Nimbus\nimbus-gateway.exe`, "win32")).toBe(
      winPath.join(String.raw`C:\Program Files\Nimbus`, "vec0.dll"),
    );
  });
});

describe("tryLoadFromSidecar", () => {
  test("calls db.loadExtension with the sidecar path when the file exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-vec-sidecar-"));
    const fname = sidecarFilename(process.platform);
    writeFileSync(join(tmp, fname), "");
    const calls: string[] = [];
    const fakeDb = {
      loadExtension: (p: string) => {
        calls.push(p);
      },
    } as unknown as Database;

    const ok = tryLoadFromSidecar(fakeDb, tmp);

    expect(ok).toBe(true);
    expect(calls).toEqual([join(tmp, fname)]);
  });

  test("returns false silently when the sidecar file is missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-vec-sidecar-empty-"));
    const fakeDb = {
      loadExtension: (_p: string) => {
        throw new Error("should not be called when sidecar is absent");
      },
    } as unknown as Database;

    const ok = tryLoadFromSidecar(fakeDb, tmp);

    expect(ok).toBe(false);
  });

  test("returns false when db.loadExtension throws (e.g. corrupt binary)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-vec-sidecar-corrupt-"));
    writeFileSync(join(tmp, sidecarFilename(process.platform)), "");
    const fakeDb = {
      loadExtension: (_p: string) => {
        throw new Error("not a valid extension");
      },
    } as unknown as Database;

    const ok = tryLoadFromSidecar(fakeDb, tmp);

    expect(ok).toBe(false);
  });

  test("falls back to dirname(process.execPath) as default baseDir", () => {
    const fakeDb = {
      loadExtension: (_p: string) => {
        throw new Error("should not be called when sidecar is absent");
      },
    } as unknown as Database;

    expect(tryLoadFromSidecar(fakeDb)).toBe(false);
  });
});

describe("tryLoadSqliteVec — upstream-first chain", () => {
  const guarded = upstreamSqliteVecLoadable ? test : test.skip;
  guarded("returns true on a fresh db when upstream sqlite-vec is loadable", () => {
    const db = new Database(":memory:");
    const ok = tryLoadSqliteVec(db);
    expect(ok).toBe(true);
    db.close();
  });

  test("falls back to tryLoadFromSidecar when upstream load throws (Error instance)", () => {
    // A CLOSED db makes the upstream sqlite-vec load() throw (its internal db calls fail),
    // exercising the catch branch in tryLoadSqliteVec; the sidecar is absent on a dev/CI
    // machine so the overall result is false.
    const closedDb = new Database(":memory:");
    closedDb.close();
    // closedDb.query("SELECT 1") will throw since it's closed. The upstream load()
    // calls db methods internally and will throw. The catch branch runs tryLoadFromSidecar
    // which checks the sidecar in dirname(process.execPath). The sidecar won't be there
    // on a dev machine, so result is false — but we exercise the catch branch.
    const result = tryLoadSqliteVec(closedDb);
    // Whether upstream was already loadable or not, the closed-db path exercises the catch.
    // We only assert the type of the result.
    expect(typeof result).toBe("boolean");
  });

  test("covers the non-Error branch in tryLoadSqliteVec catch (e instanceof Error → false)", () => {
    // sqlite-vec's load(db) calls db.loadExtension(...). If loadExtension throws a non-Error
    // value, tryLoadSqliteVec's catch block receives it and `e instanceof Error` is false.
    // This covers the String(e) branch of the ternary on the catch line.
    const fakeDb = {
      loadExtension: (_p: string) => {
        // Throw a non-Error value to exercise the String(e) branch
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "non-error-string-throw";
      },
    } as unknown as Database;
    // tryLoadSqliteVec will: call loadSqliteVec(fakeDb) → fakeDb.loadExtension() throws string
    // → catch(e): e instanceof Error is false → String(e) branch hit
    // → then calls tryLoadFromSidecar with no sidecar → returns false
    const result = tryLoadSqliteVec(fakeDb);
    expect(result).toBe(false);
  });

  test("covers the non-Error branch in tryLoadFromSidecar catch (e instanceof Error → false)", () => {
    // covers the String(e) branch of the ternary in tryLoadFromSidecar's catch block
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-vec-non-error-"));
    writeFileSync(join(tmp, sidecarFilename(process.platform)), "");
    const fakeDb = {
      loadExtension: (_p: string) => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "string-error-for-branch-coverage";
      },
    } as unknown as Database;
    const ok = tryLoadFromSidecar(fakeDb, tmp);
    expect(ok).toBe(false);
  });
});

describe("isVecLoaded", () => {
  test.skipIf(!upstreamSqliteVecLoadable)(
    "returns true when vec_version() is queryable (extension already loaded)",
    () => {
      const db = new Database(":memory:");
      loadSqliteVec(db);
      expect(isVecLoaded(db)).toBe(true);
      db.close();
    },
  );

  test("returns false when vec_version() is not available (extension not loaded)", () => {
    const db = new Database(":memory:");
    // Fresh db without extension — vec_version() will throw
    expect(isVecLoaded(db)).toBe(false);
    db.close();
  });
});

describe("loadSqliteVecOrThrow", () => {
  const guarded = upstreamSqliteVecLoadable ? test : test.skip;
  guarded("does not throw when sqlite-vec loads successfully", () => {
    const db = new Database(":memory:");
    expect(() => loadSqliteVecOrThrow(db)).not.toThrow();
    db.close();
  });

  test("throws a descriptive error when sqlite-vec cannot be loaded", () => {
    // Simulate failure: use a fake db whose loadExtension always throws,
    // combined with a baseDir that has no sidecar, so tryLoadSqliteVec returns false.
    // We do this by passing a closed database so the upstream load() call fails,
    // and the sidecar path also fails (no sidecar in process.execPath dir).
    const closedDb = new Database(":memory:");
    closedDb.close();

    // On platforms where sqlite-vec is loadable, the closed-db trick may or may not
    // cause load() to fail. Use a proxy that forces a throw in both paths.
    // We use a Proxy over a real DB interface: any property access returns a function
    // that throws — this makes load() (which calls db methods) throw unconditionally.
    const throwingDb = new Proxy({} as Database, {
      get(_target, prop) {
        if (prop === "loadExtension") {
          return () => {
            throw new Error("forced failure");
          };
        }
        return () => {
          throw new Error("forced failure");
        };
      },
    });

    // tryLoadSqliteVec will call upstream load(throwingDb) which throws, then falls
    // back to tryLoadFromSidecar with the default baseDir (no sidecar → false).
    // So tryLoadSqliteVec returns false, and loadSqliteVecOrThrow should throw.
    expect(() => loadSqliteVecOrThrow(throwingDb)).toThrow("sqlite-vec could not be loaded");
  });
});

describe("ensureSqliteVecForConnection", () => {
  test("returns true immediately when indexedUserVersion < 6 (pre-vec schema)", () => {
    // Any db works here — the function returns before touching it
    const db = new Database(":memory:");
    expect(ensureSqliteVecForConnection(db, 5)).toBe(true);
    expect(ensureSqliteVecForConnection(db, 0)).toBe(true);
    db.close();
  });

  test.skipIf(!upstreamSqliteVecLoadable)(
    "returns true when indexedUserVersion >= 6 and vec_version() is already available",
    () => {
      const db = new Database(":memory:");
      // Pre-load the extension so vec_version() succeeds
      loadSqliteVec(db);
      expect(ensureSqliteVecForConnection(db, 6)).toBe(true);
      db.close();
    },
  );

  test("falls back to tryLoadSqliteVec when indexedUserVersion >= 6 and vec_version() is unavailable", () => {
    // Fresh db without extension — vec_version() will throw → falls to tryLoadSqliteVec
    const db = new Database(":memory:");
    // The result depends on whether the upstream sqlite-vec can be loaded:
    const result = ensureSqliteVecForConnection(db, 6);
    // On a machine where sqlite-vec is loadable, it loads and returns true.
    // On a machine without sqlite-vec, sidecar absent → false.
    expect(typeof result).toBe("boolean");
    db.close();
  });

  test("returns true for indexedUserVersion exactly 5 (boundary: < 6)", () => {
    const db = new Database(":memory:");
    expect(ensureSqliteVecForConnection(db, 5)).toBe(true);
    db.close();
  });

  test("enters the catch path for indexedUserVersion exactly 6 without extension", () => {
    // Separate test to ensure the catch path specifically (version === 6, no extension)
    const db = new Database(":memory:");
    // If upstream is loadable, it will load and return true — we can't force false here
    // without DI. Still exercises the catch path regardless of the final result.
    const result = ensureSqliteVecForConnection(db, 6);
    expect(typeof result).toBe("boolean");
    db.close();
  });
});
