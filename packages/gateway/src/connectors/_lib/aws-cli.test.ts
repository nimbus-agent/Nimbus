import { describe, expect, test } from "bun:test";

import type { SyncContext } from "../../sync/types.ts";
import {
  awsNextToken,
  type BaseWalkState,
  extractArray,
  parseJson,
  type RunAwsCli,
  runAwsCliPaginatedWalk,
} from "./aws-cli.ts";

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
