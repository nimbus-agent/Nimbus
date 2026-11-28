import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { spawnCaptureInternals } from "../../platform/spawn-capture.ts";
import type { SyncContext } from "../../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../connector-sync-test-helpers.ts";
import {
  awsCliDownload,
  awsCliJson,
  awsNextToken,
  type BaseWalkState,
  extractArray,
  parseJson,
  type RunAwsCli,
  removeTempDir,
  runAwsCliPaginatedWalk,
} from "./aws-cli.ts";

type CaptureSpawn = typeof spawnCaptureInternals.spawn;

const realSpawn = spawnCaptureInternals.spawn;
afterEach(() => {
  spawnCaptureInternals.spawn = realSpawn;
});

/** Replace the spawn seam with a fake; returns the captured argv + env. */
function stubSpawn(
  impl: (
    argv: string[],
    opts: { env: Record<string, string> },
  ) => {
    exitCode: number;
    stdout: string;
  },
): { calls: { argv: string[]; env: Record<string, string> }[] } {
  const calls: { argv: string[]; env: Record<string, string> }[] = [];
  spawnCaptureInternals.spawn = ((
    cmd: string,
    args: readonly string[],
    opts?: { env?: Record<string, string> },
  ) => {
    const argv = [cmd, ...args];
    const env = opts?.env ?? {};
    calls.push({ argv, env });
    const r = impl(argv, { env });
    return fakeChild(r.exitCode, r.stdout);
  }) as unknown as CaptureSpawn;
  return { calls };
}

/**
 * A `node:child_process` stand-in — see `gcloud-runner.test.ts`, which this pattern is copied
 * from: the connector CLI runners spawn via `platform/spawn-capture.ts`, not `Bun.spawn`.
 */
function fakeChild(exitCode: number, stdout: string): unknown {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = (): void => {};
  queueMicrotask(() => {
    if (stdout !== "") proc.stdout.emit("data", Buffer.from(stdout));
    proc.emit("close", exitCode);
  });
  return proc;
}

const CTX = {} as SyncContext;
const PASS_1 = "cursor-1";

describe("parseJson", () => {
  test("parses valid JSON", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });
  test("returns undefined on invalid JSON", () => {
    expect(parseJson("not json")).toBeUndefined();
  });
});

describe("awsNextToken", () => {
  test("returns the token under the given key", () => {
    expect(awsNextToken({ nextToken: "t" }, "nextToken")).toBe("t");
    expect(awsNextToken({ NextToken: "t2" }, "NextToken")).toBe("t2");
  });
  test("returns null for empty / missing / non-object", () => {
    expect(awsNextToken({ nextToken: "" }, "nextToken")).toBeNull();
    expect(awsNextToken({}, "nextToken")).toBeNull();
    expect(awsNextToken(null, "nextToken")).toBeNull();
  });
});

describe("extractArray", () => {
  test("returns the array at key", () => {
    expect(extractArray({ items: [1, 2] }, "items")).toEqual([1, 2]);
  });
  test("returns [] for missing / non-array / non-object", () => {
    expect(extractArray({ items: "x" }, "items")).toEqual([]);
    expect(extractArray({}, "items")).toEqual([]);
    expect(extractArray(null, "items")).toEqual([]);
  });
});

/** Build a runner that returns a canned sequence of responses, recording argv. */
function makeRun(seq: { ok?: boolean; body?: unknown }[]): { run: RunAwsCli; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const run: RunAwsCli = async (_ctx, args) => {
    calls.push(args);
    const r = seq[Math.min(i, seq.length - 1)] ?? { ok: true, body: {} };
    i += 1;
    const ok = r.ok ?? true;
    return { ok, text: ok ? JSON.stringify(r.body ?? {}) : "" };
  };
  return { run, calls };
}

function baseSpec(over: Partial<Parameters<typeof runAwsCliPaginatedWalk>[3]> = {}) {
  const seen: unknown[] = [];
  const spec = {
    ensureRunning: async () => {},
    loadCreds: async () => ({}),
    pass1Cursor: () => PASS_1,
    maxItems: 500,
    pageSize: 50,
    tokenKey: "nextToken",
    arrayKey: "items",
    initialState: () => ({ upserted: 0, bytes: 0, seen: 0 }) as BaseWalkState,
    buildPageArgs: (pageSize: number, token: string | null) =>
      token === null
        ? ["list", String(pageSize)]
        : ["list", String(pageSize), "--next-token", token],
    processEntry: async (_run, _ctx, entry, _now, state) => {
      seen.push(entry);
      state.upserted += 1;
    },
    ...over,
  } as Parameters<typeof runAwsCliPaginatedWalk>[3];
  return { spec, seen };
}

describe("runAwsCliPaginatedWalk", () => {
  test("loadCreds → null yields a noop preserving the input cursor", async () => {
    const { run, calls } = makeRun([]);
    const { spec } = baseSpec({ loadCreds: async () => null });
    const res = await runAwsCliPaginatedWalk(CTX, "prev", run, spec);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(calls).toHaveLength(0);
  });

  test("first-page failure → parse-empty pass cursor, 0 upserts", async () => {
    const { run } = makeRun([{ ok: false }]);
    const { spec } = baseSpec();
    const res = await runAwsCliPaginatedWalk(CTX, null, run, spec);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1);
  });

  test("walks + upserts each entry, single page", async () => {
    const { run, calls } = makeRun([{ body: { items: [{ id: 1 }, { id: 2 }] } }]);
    const { spec } = baseSpec();
    const res = await runAwsCliPaginatedWalk(CTX, null, run, spec);
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1);
    expect(res.hasMore).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("paginates via the token key", async () => {
    const { run, calls } = makeRun([
      { body: { items: [{ id: 1 }], nextToken: "t2" } },
      { body: { items: [{ id: 2 }] } },
    ]);
    const { spec } = baseSpec();
    const res = await runAwsCliPaginatedWalk(CTX, null, run, spec);
    expect(res.itemsUpserted).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--next-token");
    expect(calls[1]).toContain("t2");
  });

  test("a later-page failure breaks without throwing (keeps prior upserts)", async () => {
    const { run } = makeRun([{ body: { items: [{ id: 1 }], nextToken: "t2" } }, { ok: false }]);
    const { spec } = baseSpec();
    const res = await runAwsCliPaginatedWalk(CTX, null, run, spec);
    expect(res.itemsUpserted).toBe(1);
    expect(res.cursor).toBe(PASS_1);
  });

  test("stops at maxItems even when more entries are present", async () => {
    const { run } = makeRun([{ body: { items: [{ id: 1 }, { id: 2 }, { id: 3 }] } }]);
    const { spec } = baseSpec({ maxItems: 2 });
    const res = await runAwsCliPaginatedWalk(CTX, null, run, spec);
    expect(res.itemsUpserted).toBe(2);
  });
});

describe("awsCliJson", () => {
  test("forwards AWS_CONFIG_FILE so a non-default config the detector saw is the one the sync reads", async () => {
    const prev = process.env["AWS_CONFIG_FILE"];
    process.env["AWS_CONFIG_FILE"] = "/cfg/aws/config";
    try {
      const { calls } = stubSpawn(() => ({ exitCode: 0, stdout: "[]" }));
      const db = createMemoryIndexDb();
      const vault = createStubVault({
        "aws.access_key_id": null,
        "aws.secret_access_key": null,
        "aws.default_region": null,
        "aws.profile": "dev",
      });
      const ctx = syncTestContext(db, vault, "aws");
      const res = await awsCliJson(ctx, ["s3api", "list-buckets"]);
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.env["AWS_CONFIG_FILE"]).toBe("/cfg/aws/config");
    } finally {
      if (prev === undefined) delete process.env["AWS_CONFIG_FILE"];
      else process.env["AWS_CONFIG_FILE"] = prev;
    }
  });
});

describe("awsCliDownload", () => {
  test("copies the object to a temp file, returns its bytes, removes the file, scopes the env", async () => {
    let target = "";
    const payload = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x80]);
    const { calls } = stubSpawn((argv) => {
      target = argv[4] ?? "";
      require("node:fs").writeFileSync(target, payload);
      return { exitCode: 0, stdout: "" };
    });
    const r = await awsCliDownload("s3://b/k.csv.gz", { AWS_PROFILE: "p" });
    expect(r).toEqual({ ok: true, bytes: payload });
    expect(calls[0]?.argv.slice(0, 4)).toEqual(["aws", "s3", "cp", "s3://b/k.csv.gz"]);
    expect(calls[0]?.argv).not.toContain("--output");
    expect(calls[0]?.env["AWS_PROFILE"]).toBe("p");
    expect(require("node:fs").existsSync(target)).toBe(false);
    expect(require("node:fs").existsSync(require("node:path").dirname(target))).toBe(false);
  });

  test("a non-zero exit, or no file written, is not ok", async () => {
    stubSpawn(() => ({ exitCode: 1, stdout: "" }));
    expect(await awsCliDownload("s3://b/k", {})).toEqual({ ok: false });
    stubSpawn(() => ({ exitCode: 0, stdout: "" }));
    expect(await awsCliDownload("s3://b/k", {})).toEqual({ ok: false });
  });
});

describe("awsCliDownload: timeout and cleanup", () => {
  /** A child that never closes: only the timeout ends it. */
  function hangingChild(): unknown {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = (): void => {};
    return proc;
  }

  test("a download that does not finish in time is not ok", async () => {
    spawnCaptureInternals.spawn = (() => hangingChild()) as unknown as CaptureSpawn;
    expect(await awsCliDownload("s3://b/k", {}, 20)).toEqual({ ok: false });
  });

  test("a listing call that does not finish in time is not ok", async () => {
    spawnCaptureInternals.spawn = (() => hangingChild()) as unknown as CaptureSpawn;
    const ctx = {
      getSharedSecret: async (_s: string, k: string) => (k === "profile" ? "p" : null),
    } as unknown as SyncContext;
    const r = await awsCliJson(ctx, ["s3api", "list-objects-v2"], 20);
    expect(r.ok).toBe(false);
    expect(r.text).toBe("");
  });

  test("removeTempDir retries a busy directory three times and never throws", async () => {
    let calls = 0;
    await removeTempDir(
      "d",
      () => {
        calls++;
        if (calls < 3) throw new Error("EBUSY");
      },
      1,
    );
    expect(calls).toBe(3);
    let always = 0;
    await removeTempDir(
      "d",
      () => {
        always++;
        throw new Error("EBUSY");
      },
      1,
    );
    expect(always).toBe(3);
  });
});
