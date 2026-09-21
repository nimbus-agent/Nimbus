import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { insertPerson } from "../people/person-store.ts";
import { buildSelectorCtx, dispatchTourRpc, TourRpcError } from "./tour-rpc.ts";

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
});
