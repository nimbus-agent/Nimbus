import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { NOW, prUrl, seedDb, seedGithubPr } from "../prreview/__fixtures__/prereview-seed.ts";
import { checkLanMethodAllowed } from "./lan-rpc.ts";
import {
  dispatchPrereviewRpc,
  type PrereviewResult,
  type PrereviewRpcCtx,
  PrereviewRpcError,
} from "./prreview-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function seeded(): Database {
  const db = seedDb();
  dbs.push(db);
  for (let i = 1; i <= 4; i++) {
    seedGithubPr(db, { number: i, files: ["src/a.ts", "docs/a.md"] });
  }
  seedGithubPr(db, { number: 9, merged: false, files: ["src/a.ts"] });
  return db;
}

function ctxFor(db: Database, extra: Partial<PrereviewRpcCtx> = {}): PrereviewRpcCtx {
  return { db, now: () => NOW, runner: () => undefined, ...extra };
}

async function call(
  params: unknown,
  ctx: PrereviewRpcCtx,
  kind: ClientKind = "cli",
  method = "prreview.run",
): Promise<PrereviewResult> {
  const out = await dispatchPrereviewRpc(method, params, ctx, { kind });
  if (out.kind !== "hit") throw new Error("miss");
  return out.value as PrereviewResult;
}

async function rejects(p: Promise<unknown>): Promise<PrereviewRpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PrereviewRpcError) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

describe("prreview.run", () => {
  test("returns the deterministic brief with no runner built", async () => {
    const db = seeded();
    let built = 0;
    const r = await call(
      { url: prUrl("acme/app", 9) },
      ctxFor(db, {
        runner: () => {
          built += 1;
          return undefined;
        },
      }),
    );
    expect(built).toBe(0);
    expect(r.synthesis).toBeNull();
    expect(r.brief.kind).toBe("pr_prereview");
    expect(r.markdown).toContain("`docs/a.md` also changed");
    expect(r.markdown.endsWith("\n")).toBe(true);
  });

  test("synthesize: true reaches the runner; no runner available reads as disabled", async () => {
    const db = seeded();
    const runner: SynthesisRunner = {
      run: async () => ({ ok: true, markdown: "VIA-RUNNER", model: "m", remote: false }),
    };
    const r = await call({ url: prUrl("acme/app", 9), synthesize: true }, ctxFor(db, { runner: () => runner }));
    expect(r.markdown).toContain("VIA-RUNNER");
    expect(r.markdown).toContain("## Gaps");
    expect(r.synthesis).toMatchObject({ attempted: true, used: true });
    const none = await call({ url: prUrl("acme/app", 9), synthesize: true }, ctxFor(db));
    expect(none.synthesis).toEqual({ attempted: false, reason: "disabled" });
    expect(none.markdown).toContain("## Usually changes with this");
  });

  test("a non-owner kind is refused before any query", async () => {
    const throwingDb = new Proxy({} as Database, {
      get() {
        throw new Error("the index was read");
      },
    });
    for (const kind of ["unknown", "mcp", "chatops"] as ClientKind[]) {
      const e = await rejects(call({ url: "https://x" }, ctxFor(throwingDb), kind));
      expect(e.rpcCode).toBe(-32000);
      expect(e.message).toContain("ERR_PREREVIEW_FORBIDDEN_CLIENT");
    }
    // the desktop is an owner surface
    const db = seeded();
    expect((await call({ url: prUrl("acme/app", 9) }, ctxFor(db), "ui")).brief.target.number).toBe(9);
  });

  test("bad parameters are -32602", async () => {
    const db = seeded();
    for (const bad of [null, [], "x", { url: "" }, { url: 7 }, { url: "u", extra: 1 }, { url: "u", synthesize: "yes" }, { url: "x".repeat(3_000) }]) {
      expect((await rejects(call(bad, ctxFor(db)))).rpcCode).toBe(-32602);
    }
  });

  test("an unresolved URL is a typed error naming the reason", async () => {
    const db = seeded();
    const e = await rejects(call({ url: prUrl("acme/app", 777) }, ctxFor(db)));
    expect(e.rpcCode).toBe(-32602);
    expect(e.message).toContain("ERR_PREREVIEW_UNRESOLVED");
    expect(e.message).toContain("not in the local index");
  });

  test("an unexpected failure is not turned into a typed error", async () => {
    const db = seeded();
    const broken = ctxFor(db, {
      now: () => {
        throw new Error("boom");
      },
    });
    let caught: unknown;
    try {
      await call({ url: prUrl("acme/app", 9) }, broken);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(PrereviewRpcError);
  });

  test("another method is a miss", async () => {
    const out = await dispatchPrereviewRpc("prreview.other", {}, ctxFor(seeded()), { kind: "cli" });
    expect(out.kind).toBe("miss");
  });

  test("the whole prreview namespace is off the LAN (I5)", () => {
    for (const writeAllowed of [true, false]) {
      expect(() => checkLanMethodAllowed("prreview.run", { peerId: "p", writeAllowed })).toThrow(
        /not callable over LAN/,
      );
    }
  });
});
