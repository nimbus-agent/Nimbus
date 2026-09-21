import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { insertPerson } from "../people/person-store.ts";
import { buildSelectorCtx, dispatchTourRpc, TourRpcError } from "./tour-rpc.ts";

/**
 * A tmpdir with a `nimbus.toml` covering every `buildSelectorCtx` field that reads from
 * `configDir`: a filesystem root (`fsRoots`/`ownershipRoots`), a `[decisions]` confidence
 * floor, and a `[user] me_person_id` override.
 */
function makeTmpConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-tour-rpc-"));
  writeFileSync(
    join(dir, "nimbus.toml"),
    [
      "[[filesystem.roots]]",
      `path = "${dir.replaceAll("\\", "/")}"`,
      "",
      "[decisions]",
      "min_confidence = 0.5",
      "",
      "[user]",
      'me_person_id = "person-tour-1"',
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

describe("dispatchTourRpc", () => {
  let db: Database;
  let ctx: { db: Database; configDir: string | undefined; demo: boolean; nowMs: () => number };

  beforeEach(() => {
    db = openMigratedMemoryDb();
    ctx = { db, configDir: undefined, demo: false, nowMs: () => 7 };
  });

  afterEach(() => {
    db.close();
  });

  test("an unknown method is a miss", async () => {
    expect((await dispatchTourRpc("tour.nope", {}, ctx)).kind).toBe("miss");
  });

  test("defaults to 3 steps and stamps t0 from the gateway clock", async () => {
    const out = await dispatchTourRpc("tour.plan", {}, ctx);
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") expect((out.value as { t0: number }).t0).toBe(7);
  });

  for (const bad of [0, 7, 1.5, "3", null]) {
    test(`refuses steps=${JSON.stringify(bad)} rather than clamping`, async () => {
      await expect(dispatchTourRpc("tour.plan", { steps: bad }, ctx)).rejects.toBeInstanceOf(
        TourRpcError,
      );
    });
  }

  // Every case above supplies an in-range-or-not NUMBER for `steps`; none ever reaches the
  // success path (`requireSteps`'s final `return raw;`) because none is actually valid.
  test("an in-range steps value is accepted verbatim, not clamped to the default", async () => {
    const out = await dispatchTourRpc("tour.plan", { steps: 5 }, ctx);
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") expect((out.value as { t0: number }).t0).toBe(7);
  });

  // `requireSteps` treats a non-object `params` exactly like `{}` (falls back to the default step
  // count) rather than throwing — the RPC layer hands it whatever the caller sent, untyped.
  test("a non-object params falls back to the default step count instead of throwing", async () => {
    const out = await dispatchTourRpc("tour.plan", "not-an-object", ctx);
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") expect((out.value as { t0: number }).t0).toBe(7);
  });

  // The tour must never offer a step (`standup`) that then refuses when the owner actually runs
  // it: `nimbus standup` never resolves identity via OS username in production, so `tour.plan`
  // must not either, even though `resolveSelfPerson` supports that tier. Built with the current
  // machine's REAL OS username on purpose — the point is that a person who WOULD match it still
  // does not resolve, because `osUsername` is never sent at all, not because this fixture happens
  // to miss. `runGit` is injected returning no email so the outcome cannot depend on whether the
  // machine running this test happens to have a matching `git config user.email`.
  test('a person reachable only via OS username does not resolve — matches "nimbus standup"', async () => {
    const osUsername = userInfo().username;
    insertPerson(db, {
      id: "p-os-only",
      displayName: "OS-only person",
      canonicalEmail: null,
      githubLogin: osUsername,
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      bitbucketUuid: null,
      linked: false,
      metadata: {},
    });
    const selectorCtx = buildSelectorCtx({
      ...ctx,
      runGit: async () => null,
    });
    expect(await selectorCtx.resolveSelf()).toBeNull();
  });

  // With `ctx.configDir === undefined` (every test above), `buildSelectorCtx` never reads
  // `nimbus.toml` at all — `fsRoots`/`ownershipRoots`/`decisionsMinConfidence` stay at their
  // empty/zero defaults and `mePersonId` stays `undefined`. A real configDir exercises the
  // OTHER side of each of those four ternaries in one pass, plus the `override` arm they feed
  // into `resolveSelf`.
  test("a configured configDir feeds fsRoots, ownershipRoots, decisionsMinConfidence, and the me_person_id override", async () => {
    const dir = makeTmpConfigDir();
    try {
      const selectorCtx = buildSelectorCtx({ ...ctx, configDir: dir });
      expect(selectorCtx.fsRoots).toEqual([resolve(dir)]);
      expect(selectorCtx.ownershipRoots).toEqual([resolve(dir)]);
      expect(selectorCtx.decisionsMinConfidence).toBe(0.5);
      // Proof the override actually reaches `resolveSelfPerson` (not merely parsed): a person
      // that exists ONLY under this id resolves, with no git/OS lookup involved.
      insertPerson(db, {
        id: "person-tour-1",
        displayName: "Tour Person",
        canonicalEmail: null,
        githubLogin: null,
        gitlabLogin: null,
        slackHandle: null,
        linearMemberId: null,
        jiraAccountId: null,
        notionUserId: null,
        bitbucketUuid: null,
        linked: false,
        metadata: {},
      });
      expect(await selectorCtx.resolveSelf()).toBe("person-tour-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // `resolveSelf` "MUST NOT throw" per its own comment — this is the arm that keeps that true:
  // `resolveSelfPerson` propagates a rejecting `runGit` uncaught (no override is configured here,
  // so it reaches the git-email tier), and `buildSelectorCtx`'s own try/catch turns that into
  // `null` rather than an unhandled rejection reaching the RPC layer.
  test("resolveSelf's catch arm: a runGit that throws resolves to null rather than rejecting", async () => {
    const selectorCtx = buildSelectorCtx({
      ...ctx,
      runGit: async () => {
        throw new Error("git exploded");
      },
    });
    await expect(selectorCtx.resolveSelf()).resolves.toBeNull();
  });
});
