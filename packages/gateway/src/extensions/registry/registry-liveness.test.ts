import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVENESS_FILE,
  type LivenessFile,
  type RegistryIndex,
  signLivenessFile,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { RegistryFetchDeps } from "./registry-fetch.ts";
import { readRegistryLiveness } from "./registry-liveness.ts";

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const SEED = Uint8Array.from({ length: 32 }, (_, i) => 50 + i);
const KEY = b64(nacl.sign.keyPair.fromSeed(SEED).publicKey);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 90 + i);
const OTHER_KEY = b64(nacl.sign.keyPair.fromSeed(OTHER_SEED).publicKey);

const ENTRY = { checkedAt: "2026-11-02T00:00:00Z", hosts: { declared: 3, answered: 2 } };

function indexWith(livenessKey?: unknown): RegistryIndex {
  return {
    format: 1,
    rootKey: KEY,
    sequence: 1,
    generatedAt: "2026-11-02T00:00:00Z",
    extensions: {},
    ...(livenessKey === undefined ? {} : { livenessKey }),
    signature: "x",
  } as RegistryIndex;
}

function file(over: Record<string, unknown> = {}, seed = SEED): Promise<LivenessFile> {
  return signLivenessFile(
    {
      format: 1,
      livenessKey: KEY,
      sequence: 4,
      generatedAt: "2026-11-02T00:00:00Z",
      nimbusVersion: "10.15.0",
      extensions: { "pkg@1.0.0": ENTRY },
      ...over,
    } as Omit<LivenessFile, "signature">,
    seed,
  );
}

let db: Database;
let tmp: string;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 80);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-liveness-"));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const egressRows = (): Array<{ destination: string; method: string }> =>
  db.query("SELECT destination, method FROM egress_ledger").all() as Array<{
    destination: string;
    method: string;
  }>;

function deps(
  body: () => Promise<Response>,
  over: Partial<RegistryFetchDeps> & { livenessTimeoutMs?: number } = {},
): RegistryFetchDeps & { livenessTimeoutMs?: number } {
  return {
    db,
    fetchFn: () => body(),
    enforceAirGap: () => false,
    now: () => 1000,
    production: false,
    ...over,
  };
}

const json = (v: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(v)));
const REG = { name: "main", url: "https://reg.example/" };
const read = (d: RegistryFetchDeps, key: unknown = KEY, id = "pkg", version = "1.0.0") =>
  readRegistryLiveness(d, REG, indexWith(key), id, version);

describe("readRegistryLiveness", () => {
  test("none, with no egress, when the index names no key", async () => {
    expect(
      await readRegistryLiveness(
        deps(() => json(null)),
        REG,
        indexWith(undefined),
        "pkg",
        "1.0.0",
      ),
    ).toEqual({ state: "none" });
    expect(egressRows()).toHaveLength(0);
  });

  test("unavailable, with no egress, for a malformed key", async () => {
    expect(
      await read(
        deps(() => json(null)),
        "nope",
      ),
    ).toEqual({ state: "unavailable" });
    expect(egressRows()).toHaveLength(0);
  });

  test("a good file is verified and found, with one registry.liveness row", async () => {
    const doc = await file();
    const r = await read(deps(() => json(doc)));
    expect(r).toEqual({
      state: "verified",
      nimbusVersion: "10.15.0",
      entry: { state: "found", entry: ENTRY },
    });
    expect(egressRows()).toEqual([{ destination: "main", method: "registry.liveness" }]);
  });

  test("another version is verified and absent", async () => {
    const doc = await file();
    const r = await read(
      deps(() => json(doc)),
      KEY,
      "pkg",
      "9.9.9",
    );
    expect(r).toEqual({ state: "verified", nimbusVersion: "10.15.0", entry: { state: "absent" } });
  });

  test("a bad signature is unavailable", async () => {
    const doc = await file();
    expect(await read(deps(() => json({ ...doc, sequence: 9 })))).toEqual({ state: "unavailable" });
  });

  test("a file signed for another key than the index names is unavailable", async () => {
    const doc = await file({ livenessKey: OTHER_KEY }, OTHER_SEED);
    expect(await read(deps(() => json(doc)))).toEqual({ state: "unavailable" });
  });

  test("a 404 and non-JSON are unavailable", async () => {
    expect(await read(deps(() => Promise.resolve(new Response("no", { status: 404 }))))).toEqual({
      state: "unavailable",
    });
    expect(await read(deps(() => Promise.resolve(new Response("not json"))))).toEqual({
      state: "unavailable",
    });
  });

  test("a replayed lower sequence and an equal sequence with other content are unavailable", async () => {
    expect((await read(deps(async () => json(await file({ sequence: 5 }))))).state).toBe(
      "verified",
    );
    expect(await read(deps(async () => json(await file({ sequence: 4 }))))).toEqual({
      state: "unavailable",
    });
    expect(
      await read(deps(async () => json(await file({ sequence: 5, nimbusVersion: "10.16.0" })))),
    ).toEqual({ state: "unavailable" });
  });

  test("a fetch that never resolves is unavailable within the timeout", async () => {
    const started = Date.now();
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      });
    const r = await read(deps(() => json(null), { fetchFn: hang, livenessTimeoutMs: 100 }));
    expect(r).toEqual({ state: "unavailable" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("a fetch that ignores the signal and never resolves is still bounded, and records no floor", async () => {
    const started = Date.now();
    const r = await read(
      deps(() => json(null), {
        fetchFn: () => new Promise<Response>(() => {}),
        livenessTimeoutMs: 100,
      }),
    );
    expect(r).toEqual({ state: "unavailable" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(
      (db.query("SELECT COUNT(*) AS n FROM registry_liveness_state").get() as { n: number }).n,
    ).toBe(0);
  });

  test("air gap is unavailable with no egress row", async () => {
    const doc = await file();
    expect(await read(deps(() => json(doc), { enforceAirGap: () => true }))).toEqual({
      state: "unavailable",
    });
    expect(egressRows()).toHaveLength(0);
  });

  test("a local registry directory is verified with no egress row", async () => {
    writeFileSync(join(tmp, LIVENESS_FILE), JSON.stringify(await file()));
    const r = await readRegistryLiveness(
      deps(() => json(null)),
      { name: "main", url: tmp },
      indexWith(KEY),
      "pkg",
      "1.0.0",
    );
    expect(r.state).toBe("verified");
    expect(egressRows()).toHaveLength(0);
  });

  test("a V79 database is unavailable and fetches nothing", async () => {
    const old = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(old, 79);
      let called = 0;
      const d = deps(() => {
        called++;
        return json(null);
      });
      expect(await read({ ...d, db: old })).toEqual({ state: "unavailable" });
      expect(called).toBe(0);
    } finally {
      old.close();
    }
  });
});
