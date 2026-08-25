import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStorybookSyncable } from "../../../src/connectors/storybook-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CURSOR_PREFIX = "nimbus-storybook1:";
function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

function indexJson() {
  return {
    v: 5,
    entries: {
      "components-button--primary": {
        id: "components-button--primary",
        title: "Components/Button",
        name: "Primary",
        importPath: "./src/Button.stories.tsx",
        tags: ["autodocs"],
        type: "story",
      },
      "components-button--secondary": {
        id: "components-button--secondary",
        title: "Components/Button",
        name: "Secondary",
        importPath: "./src/Button.stories.tsx",
        tags: [],
        type: "story",
      },
    },
  };
}

describe("storybook-sync", () => {
  let fx: ConnectorSyncFixture;
  let dir: string;
  const ensureCalls: number[] = [];

  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    dir = await mkdtemp(join(tmpdir(), "nimbus-storybook-test-"));
    ensureCalls.length = 0;
  });
  afterEach(async () => {
    fx.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  function makeSyncable() {
    return createStorybookSyncable({
      ensureStorybookMcpRunning: async (): Promise<void> => {
        ensureCalls.push(1);
      },
    });
  }

  test("no dir → noop, preserves cursor, still ensures the mesh", async () => {
    const res = await makeSyncable().sync(fx.createSyncContext("storybook"), "prev");
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(ensureCalls).toHaveLength(1);
  });

  test("reads index.json and upserts one storybook:story per entry", async () => {
    await writeFile(join(dir, "index.json"), JSON.stringify(indexJson()), "utf8");
    await fx.vault.set("storybook.dir", dir);

    const res = await makeSyncable().sync(fx.createSyncContext("storybook"), null);
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1_CURSOR);

    const rows = fx.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'storybook' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual([
      "components-button--primary",
      "components-button--secondary",
    ]);
  });

  test("falls back to the legacy stories.json when index.json is absent", async () => {
    await writeFile(
      join(dir, "stories.json"),
      JSON.stringify({
        v: 3,
        stories: { "b--d": { id: "b--d", kind: "Button", story: "Default" } },
      }),
      "utf8",
    );
    await fx.vault.set("storybook.dir", dir);
    const res = await makeSyncable().sync(fx.createSyncContext("storybook"), null);
    expect(res.itemsUpserted).toBe(1);
  });

  test("no readable manifest yet (Storybook not built) → success with zero upserts", async () => {
    await fx.vault.set("storybook.dir", dir);
    const res = await makeSyncable().sync(fx.createSyncContext("storybook"), null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });
});
