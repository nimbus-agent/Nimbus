import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchAgentsRpc } from "./agents-rpc.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function makeCtx(db: Database, extras?: { configDir?: string }) {
  return { db, notify: () => {}, ...extras };
}

/** A target-epic-only seed: a Jira Epic item with no children — enough to resolve, not enough to cohort. */
function seedChildlessEpic(db: Database, key: string): void {
  upsertIndexedItem(db, {
    service: "jira",
    type: "issue",
    externalId: key,
    title: `${key} title`,
    metadata: { issue_type: "Epic", status_category: "in_progress" },
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
  });
}

describe("dispatchAgentsRpc — agents.premortem param validation", () => {
  test("rejects a missing epicRef", async () => {
    await expect(
      dispatchAgentsRpc("agents.premortem", {}, makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602, message: expect.stringContaining("epicRef") });
  });

  test("rejects a non-string epicRef", async () => {
    await expect(
      dispatchAgentsRpc("agents.premortem", { epicRef: 5 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects an empty epicRef after trim", async () => {
    await expect(
      dispatchAgentsRpc("agents.premortem", { epicRef: "   " }, makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects params that are not an object", async () => {
    await expect(
      dispatchAgentsRpc("agents.premortem", "PROJ-1", makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      dispatchAgentsRpc("agents.premortem", ["PROJ-1"], makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      dispatchAgentsRpc("agents.premortem", null, makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects a non-array services", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.premortem",
        { epicRef: "PROJ-1", services: "billing" },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({ rpcCode: -32602, message: expect.stringContaining("services") });
  });

  test("rejects a non-string element inside services", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.premortem",
        { epicRef: "PROJ-1", services: ["billing", 5] },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects an empty-after-trim service entry", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.premortem",
        { epicRef: "PROJ-1", services: ["   "] },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects an over-length service entry", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.premortem",
        { epicRef: "PROJ-1", services: ["s".repeat(65)] },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects a non-boolean repropose", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.premortem",
        { epicRef: "PROJ-1", repropose: "yes" },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({ rpcCode: -32602, message: expect.stringContaining("repropose") });
  });
});

describe("dispatchAgentsRpc — agents.premortem happy paths", () => {
  test("resolves a bare epic key and returns a premortem-prefixed sessionId", async () => {
    const db = freshDb();
    seedChildlessEpic(db, "PROJ-1");
    const out = await dispatchAgentsRpc("agents.premortem", { epicRef: "PROJ-1" }, makeCtx(db));
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { sessionId: string };
      expect(v.sessionId).toMatch(/^premortem/);
    }
  });

  test("accepts a jira: prefixed ref, repeatable services, and repropose together", async () => {
    const db = freshDb();
    seedChildlessEpic(db, "PROJ-2");
    const out = await dispatchAgentsRpc(
      "agents.premortem",
      { epicRef: "jira:PROJ-2", services: ["acme/billing", "acme/checkout"], repropose: true },
      makeCtx(db),
    );
    expect(out.kind).toBe("hit");
  });

  test("an unrelated method still misses so the next dispatcher can claim it", async () => {
    const out = await dispatchAgentsRpc("premortem.refresh", null, makeCtx(freshDb()));
    expect(out.kind).toBe("miss");
  });

  test("with no configDir, resolveServiceId is left unset (no throw; incident coupling degrades to a gap)", async () => {
    const db = freshDb();
    seedChildlessEpic(db, "PROJ-3");
    const out = await dispatchAgentsRpc("agents.premortem", { epicRef: "PROJ-3" }, makeCtx(db));
    expect(out.kind).toBe("hit");
  });

  // Exercises `premortemResolveServiceId`'s configDir-set branch, mirroring
  // `ipc/index-regraph-rpc.ts`'s construction of the same resolver. Not just "does not throw" —
  // proves the real `loadNimbusServiceConfigsFromConfigDir` + `buildServiceIdentityResolver` wiring
  // survives a real `[ci.service.*]` block on disk (the `agents-rpc.test.ts` `makeTmpConfigDir`
  // pattern, extended with a `[ci.service.*]` table instead of `[user]`).
  test("with a configDir carrying [ci.service.*], resolveServiceId is threaded through with no throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-premortem-rpc-"));
    writeFileSync(
      join(dir, "nimbus.toml"),
      '[ci.service.billing]\nrepos = ["github:acme/billing"]\n',
      "utf8",
    );
    const db = freshDb();
    seedChildlessEpic(db, "PROJ-4");
    const out = await dispatchAgentsRpc(
      "agents.premortem",
      { epicRef: "PROJ-4" },
      makeCtx(db, { configDir: dir }),
    );
    expect(out.kind).toBe("hit");
  });
});
