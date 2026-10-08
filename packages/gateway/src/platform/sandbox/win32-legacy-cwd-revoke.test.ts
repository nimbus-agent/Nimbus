import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { buildRevokeGrantsArgv } from "./win32-argv.ts";
import {
  BOOT_REVOKE_CALL_TIMEOUT_MS,
  deadlineHelperRunner,
  HelperCallTimeoutError,
  type HelperChild,
  type HelperSpawn,
  legacyDataDirGrantIds,
  nodeHelperSpawn,
  type RevokeBootSeams,
  revokeLegacyDataDirGrants,
  revokeLegacyDataDirGrantsAtBoot,
  SANDBOX_CWD_MIGRATION_MARKER,
} from "./win32-reap.ts";

const logger = () => {
  const warns: unknown[] = [];
  return {
    warns,
    info: () => {},
    warn: (...a: unknown[]) => {
      warns.push(a);
    },
  };
};

describe("legacyDataDirGrantIds", () => {
  it("covers first-party, bundled-without-table-entry and user ids; excludes filesystem", () => {
    const ids = legacyDataDirGrantIds(["mcp_a"]);
    expect(ids).toContain("com.nimbus.github");
    expect(ids).toContain("com.nimbus.github-actions");
    expect(ids).toContain("com.nimbus.cloud-logging");
    expect(ids).toContain("user.mcp_a");
    expect(ids).not.toContain("com.nimbus.filesystem");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("revokeLegacyDataDirGrants", () => {
  it("marker name is verbatim", () => {
    expect(SANDBOX_CWD_MIGRATION_MARKER).toBe("sandbox-cwd-migration-v1.done");
  });

  it("skips when the marker exists", async () => {
    let calls = 0;
    const r = await revokeLegacyDataDirGrants({
      dataDir: "D",
      ids: ["a"],
      run: async () => {
        calls++;
      },
      markerExists: () => true,
      writeMarker: () => {},
      logger: logger(),
    });
    expect(r).toBe("skipped");
    expect(calls).toBe(0);
  });

  it("revokes each id once, writes the marker, returns done", async () => {
    const seen: string[][] = [];
    let marker = 0;
    const r = await revokeLegacyDataDirGrants({
      dataDir: "D:data",
      ids: ["a", "b"],
      run: async (argv) => {
        seen.push(argv);
      },
      markerExists: () => false,
      writeMarker: () => {
        marker++;
      },
      logger: logger(),
    });
    expect(r).toBe("done");
    expect(marker).toBe(1);
    expect(seen).toEqual(
      ["a", "b"].map((id) =>
        buildRevokeGrantsArgv(
          { id, permissions: { network: [], filesystem: { read: [], write: [] } } },
          { cwd: "D:data" },
        ),
      ),
    );
  });

  it("a rejecting run still visits every id, writes no marker, warns once", async () => {
    const l = logger();
    let calls = 0;
    let marker = 0;
    const r = await revokeLegacyDataDirGrants({
      dataDir: "D",
      ids: ["a", "b", "c"],
      run: async () => {
        calls++;
        if (calls === 2) throw new Error("boom");
      },
      markerExists: () => false,
      writeMarker: () => {
        marker++;
      },
      logger: l,
    });
    expect(r).toBe("partial");
    expect(calls).toBe(3);
    expect(marker).toBe(0);
    expect(l.warns).toHaveLength(1);
  });
});

describe("revokeLegacyDataDirGrantsAtBoot", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const bootLogger = () => {
    const infos: unknown[][] = [];
    const warns: unknown[][] = [];
    const l = {
      info: (...a: unknown[]) => {
        infos.push(a);
      },
      warn: (...a: unknown[]) => {
        warns.push(a);
      },
    };
    return { infos, warns, logger: l as unknown as Logger };
  };

  /** Never read: every test that reaches the lister overrides it, or supplies a real db. */
  const db = {} as Database;

  /** Seams that reach the revoke loop with a recording helper and an in-memory marker. */
  const winSeams = () => {
    const runs: string[][] = [];
    const written: string[] = [];
    const helpers: string[] = [];
    const seams: RevokeBootSeams = {
      platform: "win32",
      helperPath: () => "C:/helper.exe",
      helperExists: () => true,
      helperRun: (h) => {
        helpers.push(h);
        return async (argv) => {
          runs.push(argv);
        };
      },
      listUserServiceIds: () => ["mcp_a"],
      markerExists: () => false,
      writeMarker: (m) => {
        written.push(m);
      },
    };
    return { seams, runs, written, helpers };
  };

  it("is a no-op off Windows", async () => {
    const w = winSeams();
    const { logger, infos, warns } = bootLogger();
    await revokeLegacyDataDirGrantsAtBoot({
      db,
      dataDir: "D",
      logger,
      seams: { ...w.seams, platform: "linux" },
    });
    expect(w.runs).toHaveLength(0);
    expect(w.written).toHaveLength(0);
    expect(infos).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it("is a no-op when the helper is not built", async () => {
    const w = winSeams();
    const probed: string[] = [];
    const { logger, warns } = bootLogger();
    await revokeLegacyDataDirGrantsAtBoot({
      db,
      dataDir: "D",
      logger,
      seams: {
        ...w.seams,
        helperExists: (h) => {
          probed.push(h);
          return false;
        },
      },
    });
    expect(probed).toEqual(["C:/helper.exe"]);
    expect(w.runs).toHaveLength(0);
    expect(w.written).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it("revokes every legacy id, writes the marker under dataDir, logs done", async () => {
    const w = winSeams();
    const { logger, infos, warns } = bootLogger();
    await revokeLegacyDataDirGrantsAtBoot({ db, dataDir: "D", logger, seams: w.seams });
    expect(w.helpers).toEqual(["C:/helper.exe"]);
    expect(w.runs).toEqual(
      legacyDataDirGrantIds(["mcp_a"]).map((id) =>
        buildRevokeGrantsArgv(
          { id, permissions: { network: [], filesystem: { read: [], write: [] } } },
          { cwd: "D" },
        ),
      ),
    );
    expect(w.written).toEqual([join("D", SANDBOX_CWD_MIGRATION_MARKER)]);
    expect(infos).toHaveLength(1);
    expect(warns).toHaveLength(0);
  });

  it("skips the loop when the marker already exists", async () => {
    const w = winSeams();
    const { logger, infos } = bootLogger();
    await revokeLegacyDataDirGrantsAtBoot({
      db,
      dataDir: "D",
      logger,
      seams: { ...w.seams, markerExists: () => true },
    });
    expect(w.runs).toHaveLength(0);
    expect(w.written).toHaveLength(0);
    expect(infos).toHaveLength(0);
  });

  it("a throwing user-row lister warns and still revokes the first-party ids", async () => {
    const w = winSeams();
    const { logger, warns } = bootLogger();
    await revokeLegacyDataDirGrantsAtBoot({
      db,
      dataDir: "D",
      logger,
      seams: {
        ...w.seams,
        listUserServiceIds: () => {
          throw new Error("no table");
        },
      },
    });
    expect(warns).toHaveLength(2); // the listing failure + the withheld marker
    expect(w.runs.length).toBeGreaterThan(0);
    expect(w.runs).toHaveLength(legacyDataDirGrantIds([]).length);
    expect(w.written).toHaveLength(0); // marker withheld so the next boot retries
  });

  it("one failing revoke writes no marker and warns", async () => {
    const w = winSeams();
    const { logger, infos, warns } = bootLogger();
    let n = 0;
    await revokeLegacyDataDirGrantsAtBoot({
      db,
      dataDir: "D",
      logger,
      seams: {
        ...w.seams,
        helperRun: () => async () => {
          n++;
          if (n === 1) throw new Error("revoke refused");
        },
      },
    });
    expect(n).toBe(legacyDataDirGrantIds(["mcp_a"]).length);
    expect(w.written).toHaveLength(0);
    expect(infos).toHaveLength(0);
    expect(warns).toHaveLength(1);
  });

  it("an unexpected throw resolves rather than rejects, with a warning", async () => {
    const w = winSeams();
    const { logger, warns } = bootLogger();
    const p = revokeLegacyDataDirGrantsAtBoot({
      db,
      dataDir: "D",
      logger,
      seams: {
        ...w.seams,
        helperPath: () => {
          throw new Error("no helper path");
        },
      },
    });
    await expect(p).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
  });

  it("a throwing marker write resolves rather than rejects, with a warning", async () => {
    const w = winSeams();
    const { logger, infos, warns } = bootLogger();
    await expect(
      revokeLegacyDataDirGrantsAtBoot({
        db,
        dataDir: "D",
        logger,
        seams: {
          ...w.seams,
          writeMarker: () => {
            throw new Error("read-only");
          },
        },
      }),
    ).resolves.toBeUndefined();
    expect(infos).toHaveLength(0);
    expect(warns).toHaveLength(1);
  });

  it("the production lister, marker probe and marker write run against a temp dir", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nimbus-legacy-revoke-"));
    dirs.push(dataDir);
    const first = winSeams();
    const { logger, warns } = bootLogger();
    // An unmigrated in-memory db: the PRODUCTION lister reports no user rows, so first-party only.
    const empty = new Database(":memory:");
    try {
      await revokeLegacyDataDirGrantsAtBoot({
        db: empty,
        dataDir,
        logger,
        seams: { platform: "win32", helperExists: () => true, helperRun: first.seams.helperRun },
      });
    } finally {
      empty.close();
    }
    expect(warns).toHaveLength(0);
    expect(first.runs).toHaveLength(legacyDataDirGrantIds([]).length);
    expect(existsSync(join(dataDir, SANDBOX_CWD_MIGRATION_MARKER))).toBe(true);

    // Second boot: the real marker probe sees the file and the loop is skipped.
    const again = winSeams();
    await revokeLegacyDataDirGrantsAtBoot({
      db,
      dataDir,
      logger,
      seams: { platform: "win32", helperExists: () => true, helperRun: again.seams.helperRun },
    });
    expect(again.runs).toHaveLength(0);
  });
});

/** A fake helper process that never exits on its own; records argv and kills. */
function neverExiting(): { spawn: HelperSpawn; launched: string[][]; kills: number[] } {
  const launched: string[][] = [];
  const kills: number[] = [];
  return {
    launched,
    kills,
    spawn: (_helper, argv) => {
      launched.push([...argv]);
      let resolveExit: (code: number | null) => void = () => {};
      const child: HelperChild = {
        exited: new Promise<number | null>((r) => {
          resolveExit = r;
        }),
        kill: () => {
          kills.push(launched.length);
          resolveExit(null);
        },
      };
      return child;
    },
  };
}

describe("deadlineHelperRunner (per-call boot-revoke timeout)", () => {
  it("the production deadline is 15 000 ms", () => {
    expect(BOOT_REVOKE_CALL_TIMEOUT_MS).toBe(15_000);
  });

  it("resolves on a zero exit and rejects on a non-zero one", async () => {
    const exitWith =
      (code: number | null): HelperSpawn =>
      () => ({ exited: Promise.resolve(code), kill: () => {} });
    await expect(deadlineHelperRunner("h", exitWith(0), 1_000)(["x"])).resolves.toBeUndefined();
    await expect(deadlineHelperRunner("h", exitWith(5), 1_000)(["x"])).rejects.toThrow(
      /exited with code 5/,
    );
    await expect(deadlineHelperRunner("h", exitWith(null), 1_000)(["x"])).rejects.toThrow(
      /exited with code null/,
    );
  });

  it("a launch failure rejects", async () => {
    const failing: HelperSpawn = () => ({
      exited: Promise.reject(new Error("ENOENT")),
      kill: () => {},
    });
    await expect(deadlineHelperRunner("h", failing, 1_000)(["x"])).rejects.toThrow(/ENOENT/);
  });

  it("a never-exiting helper is killed at the deadline and the call rejects with a timeout", async () => {
    const fake = neverExiting();
    const started = performance.now();
    const err = await deadlineHelperRunner(
      "h",
      fake.spawn,
      25,
    )(["--revoke"]).catch((e: unknown) => e);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(HelperCallTimeoutError);
    expect(fake.kills).toEqual([1]);
  });

  it("a kill that throws still rejects with the timeout", async () => {
    const hung: HelperSpawn = () => ({
      exited: new Promise<number | null>(() => {}),
      kill: () => {
        throw new Error("already gone");
      },
    });
    await expect(deadlineHelperRunner("h", hung, 10)(["x"])).rejects.toBeInstanceOf(
      HelperCallTimeoutError,
    );
  });
});

describe("revokeLegacyDataDirGrantsAtBoot — a hung helper", () => {
  const bootLogger = () => {
    const infos: unknown[][] = [];
    const warns: unknown[][] = [];
    const l = {
      info: (...a: unknown[]) => {
        infos.push(a);
      },
      warn: (...a: unknown[]) => {
        warns.push(a);
      },
    };
    return { infos, warns, logger: l as unknown as Logger };
  };

  it("times out, writes no marker, warns, stops after the first hang, and resolves within the deadline", async () => {
    const fake = neverExiting();
    const written: string[] = [];
    const { logger, infos, warns } = bootLogger();
    const started = performance.now();
    await revokeLegacyDataDirGrantsAtBoot({
      db: {} as Database,
      dataDir: "D",
      logger,
      seams: {
        platform: "win32",
        helperPath: () => "C:/helper.exe",
        helperExists: () => true,
        helperRun: (h) => deadlineHelperRunner(h, fake.spawn, 25),
        listUserServiceIds: () => ["mcp_a"],
        markerExists: () => false,
        writeMarker: (m) => {
          written.push(m);
        },
      },
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(written).toHaveLength(0);
    expect(infos).toHaveLength(0);
    // One helper call, not one per id: a hang ends the pass rather than waiting out every deadline.
    expect(fake.launched).toHaveLength(1);
    expect(fake.kills).toEqual([1]);
    expect(warns).toHaveLength(1);
    const [fields, msg] = warns[0] as [{ failed: string[]; timedOut: boolean }, string];
    expect(fields.timedOut).toBe(true);
    expect(fields.failed).toEqual(legacyDataDirGrantIds(["mcp_a"]));
    expect(msg).toMatch(/timed out; will retry next boot/);
  });

  it("the PRODUCTION runner (no helperRun override) treats an unlaunchable helper as a failure", async () => {
    const written: string[] = [];
    const { logger, infos, warns } = bootLogger();
    const missing = join(tmpdir(), `nimbus-no-such-helper-${process.pid}.exe`);
    await revokeLegacyDataDirGrantsAtBoot({
      db: {} as Database,
      dataDir: "D",
      logger,
      seams: {
        platform: "win32",
        helperPath: () => missing,
        helperExists: () => true,
        listUserServiceIds: () => [],
        markerExists: () => false,
        writeMarker: (m) => {
          written.push(m);
        },
      },
    });
    expect(written).toHaveLength(0);
    expect(infos).toHaveLength(0);
    expect(warns).toHaveLength(1);
    const [fields] = warns[0] as [{ failed: string[]; timedOut: boolean }];
    expect(fields.timedOut).toBe(false);
    expect(fields.failed).toEqual(legacyDataDirGrantIds([]));
  });
});

describe("nodeHelperSpawn", () => {
  it("reports a real child's exit code", async () => {
    const child = nodeHelperSpawn(process.execPath, ["-e", "process.exit(3)"]);
    expect(await child.exited).toBe(3);
  });

  it("kill ends a real child that would otherwise run on", async () => {
    const child = nodeHelperSpawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    child.kill();
    const code = await child.exited;
    expect(code === 0).toBe(false);
  });

  it("rejects when the executable does not exist", async () => {
    const child = nodeHelperSpawn(join(tmpdir(), `nimbus-missing-${process.pid}.exe`), []);
    await expect(child.exited).rejects.toThrow();
  });
});

describe("revokeLegacyDataDirGrants — timeout bookkeeping", () => {
  it("a timeout stops the pass and counts the remaining ids as failed; other errors do not", async () => {
    const l = logger();
    const seen: number[] = [];
    let calls = 0;
    const r = await revokeLegacyDataDirGrants({
      dataDir: "D",
      ids: ["a", "b", "c", "d"],
      run: async () => {
        calls++;
        seen.push(calls);
        if (calls === 1) throw new Error("ordinary failure");
        if (calls === 2) throw new HelperCallTimeoutError(10);
      },
      markerExists: () => false,
      writeMarker: () => {
        throw new Error("must not write");
      },
      logger: l,
    });
    expect(r).toBe("partial");
    expect(seen).toEqual([1, 2]);
    expect(l.warns).toHaveLength(1);
    const [fields] = l.warns[0] as [{ failed: string[]; timedOut: boolean }];
    expect(fields).toEqual({ failed: ["a", "b", "c", "d"], timedOut: true });
  });
});
