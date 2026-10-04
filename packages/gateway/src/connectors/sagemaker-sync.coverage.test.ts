/**
 * SageMaker paths the existing suites do not reach: a model name carrying a control character
 * (refused as a `describe-model` argv value, like a `-` prefix), a `describe-model` reply that is
 * not a JSON object, `list-models` entries that are not objects or carry no usable name, and the
 * per-cycle `MAX_DESCRIBE` (50) enrichment budget.
 *
 * The AWS CLI is injected through the syncable's own `runAwsCli` option, so nothing is spawned.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SyncResult } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createSagemakerSyncable, type RunAwsCli } from "./sagemaker-sync.ts";

/** Mirrors `MAX_DESCRIBE` in sagemaker-sync.ts. */
const MAX_DESCRIBE = 50;

type CliReply = { ok: boolean; text: string };

let db: Database;

beforeEach(() => {
  db = createMemoryIndexDb();
});

afterEach(() => {
  db.close();
});

/** A fake `aws` runner: `list-models` answers with `models`, `describe-model` with `describe(name)`. */
function fakeCli(
  models: readonly unknown[],
  describe: (modelName: string) => CliReply,
): { run: RunAwsCli; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunAwsCli = (_ctx, args) => {
    calls.push([...args]);
    if (args[1] === "list-models") {
      return Promise.resolve({ ok: true, text: JSON.stringify({ Models: models }) });
    }
    if (args[1] === "describe-model") {
      return Promise.resolve(describe(args[3] ?? ""));
    }
    throw new Error(`unexpected aws invocation: ${args.join(" ")}`);
  };
  return { run, calls };
}

function sync(run: RunAwsCli): Promise<SyncResult> {
  return createSagemakerSyncable({
    ensureSagemakerMcpRunning: async () => {},
    runAwsCli: run,
  }).sync(
    syncTestContext(
      db,
      createStubVault({
        "aws.access_key_id": "AKIA-stub",
        "aws.secret_access_key": "secret-stub",
        "aws.default_region": "us-east-1",
      }),
      "sagemaker",
    ),
    null,
  );
}

function describedNames(calls: readonly string[][]): string[] {
  return calls.filter((c) => c[1] === "describe-model").map((c) => c[3] ?? "");
}

/** The indexed row's metadata, by external id. */
function metadataOf(externalId: string): Record<string, unknown> {
  const row = db
    .query("SELECT metadata FROM item WHERE service = 'sagemaker' AND external_id = ?")
    .get(externalId) as { metadata: string } | null;
  if (row === null) throw new Error(`no sagemaker row ${externalId}`);
  return JSON.parse(row.metadata) as Record<string, unknown>;
}

function indexedIds(): string[] {
  return (
    db
      .query("SELECT external_id FROM item WHERE service = 'sagemaker' ORDER BY external_id")
      .all() as { external_id: string }[]
  ).map((r) => r.external_id);
}

const ENRICHED: CliReply = {
  ok: true,
  text: JSON.stringify({ PrimaryContainer: { Image: "img:1" } }),
};

describe("sagemaker-sync — control characters in a model name", () => {
  test("a name with a tab or newline is never passed to describe-model, yet is still indexed", async () => {
    const { run, calls } = fakeCli(
      [{ ModelName: "evil\tname" }, { ModelName: "line\nbreak" }, { ModelName: "ok-model" }],
      () => ENRICHED,
    );

    const res = await sync(run);

    expect(calls.filter((c) => c[1] === "describe-model")).toEqual([
      ["sagemaker", "describe-model", "--model-name", "ok-model"],
    ]);
    expect(res.itemsUpserted).toBe(3);
    expect(indexedIds()).toEqual(["evil\tname", "line\nbreak", "ok-model"]);
    expect(metadataOf("evil\tname")["containerImage"]).toBeUndefined();
    expect(metadataOf("ok-model")["containerImage"]).toBe("img:1");
  });
});

describe("sagemaker-sync — describe-model replies that are not a JSON object", () => {
  test("an array or non-JSON reply leaves that model un-enriched; its bytes still count", async () => {
    const replies: Record<string, CliReply> = {
      // An array whose only element IS a describe-model reply: un-enriched proves the array was
      // refused, not unwrapped to its first element.
      "m-array": { ok: true, text: JSON.stringify([{ PrimaryContainer: { Image: "img/array" } }]) },
      "m-text": { ok: true, text: "not json at all" },
      "m-good": {
        ok: true,
        text: JSON.stringify({
          PrimaryContainer: { Image: "img/good", ModelDataUrl: "s3://b/m.tar.gz" },
          ExecutionRoleArn: "arn:aws:iam::1:role/R",
        }),
      },
    };
    const models = [{ ModelName: "m-array" }, { ModelName: "m-text" }, { ModelName: "m-good" }];
    const { run } = fakeCli(models, (name) => replies[name] ?? { ok: false, text: "" });

    const res = await sync(run);

    expect(res.itemsUpserted).toBe(3);
    for (const bare of ["m-array", "m-text"]) {
      const meta = metadataOf(bare);
      expect(meta["containerImage"]).toBeUndefined();
      expect(meta["modelDataUrl"]).toBeUndefined();
      expect(meta["executionRoleArn"]).toBeUndefined();
    }
    expect(metadataOf("m-good")).toMatchObject({
      containerImage: "img/good",
      modelDataUrl: "s3://b/m.tar.gz",
      executionRoleArn: "arn:aws:iam::1:role/R",
    });
    const describeBytes = Object.values(replies).reduce((n, r) => n + r.text.length, 0);
    expect(res.bytesTransferred).toBe(JSON.stringify({ Models: models }).length + describeBytes);
  });
});

describe("sagemaker-sync — list-models entries without a usable name", () => {
  test("non-object entries and empty or missing names are neither described nor indexed", async () => {
    const { run, calls } = fakeCli(
      [
        null,
        "model-as-string",
        7,
        { ModelName: "" },
        { ModelArn: "arn:aws:sagemaker:us-east-1:1:model/no-name" },
        { ModelName: "real" },
      ],
      () => ENRICHED,
    );

    const res = await sync(run);

    expect(describedNames(calls)).toEqual(["real"]);
    expect(res.itemsUpserted).toBe(1);
    expect(indexedIds()).toEqual(["real"]);
  });
});

describe("sagemaker-sync — MAX_DESCRIBE enrichment budget", () => {
  test("only the first 50 models are described; the 51st is still indexed, un-enriched", async () => {
    const names = Array.from(
      { length: MAX_DESCRIBE + 1 },
      (_, i) => `model-${String(i).padStart(3, "0")}`,
    );
    const { run, calls } = fakeCli(
      names.map((ModelName) => ({ ModelName })),
      (name) => ({
        ok: true,
        text: JSON.stringify({ PrimaryContainer: { Image: `img/${name}` } }),
      }),
    );

    const res = await sync(run);

    expect(describedNames(calls)).toEqual(names.slice(0, MAX_DESCRIBE));
    expect(res.itemsUpserted).toBe(MAX_DESCRIBE + 1);
    expect(metadataOf("model-049")["containerImage"]).toBe("img/model-049");
    expect(metadataOf("model-050")["containerImage"]).toBeUndefined();
  });
});
