import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createSagemakerSyncable, type RunAwsCli } from "../../../src/connectors/sagemaker-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CURSOR_PREFIX = "nimbus-sm1:";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

const ENSURE = { ensureSagemakerMcpRunning: async (): Promise<void> => {} };

/** Build a runAwsCli stub returning canned JSON keyed by the `aws sagemaker` subcommand. */
function makeRunner(responses: Record<string, { ok?: boolean; body?: unknown }[]>): {
  run: RunAwsCli;
  calls: string[][];
} {
  const calls: string[][] = [];
  const cursors: Record<string, number> = {};
  const run: RunAwsCli = async (_ctx, args) => {
    calls.push(args);
    // args are passed to `aws <args> --output json`; args[0] is "sagemaker" and
    // args[1] is the subcommand (list-models / describe-model).
    const cmd = args[1] ?? "";
    const seq = responses[cmd] ?? [];
    const i = cursors[cmd] ?? 0;
    cursors[cmd] = i + 1;
    const r = seq[Math.min(i, seq.length - 1)] ?? { ok: true, body: {} };
    const ok = r.ok ?? true;
    return { ok, text: ok ? JSON.stringify(r.body ?? {}) : "" };
  };
  return { run, calls };
}

async function seedAwsCreds(fx: ConnectorSyncFixture): Promise<void> {
  await fx.vault.set("aws.access_key_id", "AKIA-stub");
  await fx.vault.set("aws.secret_access_key", "secret-stub");
  await fx.vault.set("aws.default_region", "us-east-1");
}

describe("sagemaker-sync — credential short-circuit", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(() => {
    fx = createConnectorSyncFixture();
  });
  afterEach(() => fx.cleanup());

  test("no aws vault keys → noop, runner never called, cursor preserved", async () => {
    const { run, calls } = makeRunner({});
    const res = await createSagemakerSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("sagemaker"),
      "prev",
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(calls).toHaveLength(0);
  });

  test("ak + sk but no region/profile → noop", async () => {
    await fx.vault.set("aws.access_key_id", "AKIA");
    await fx.vault.set("aws.secret_access_key", "S");
    const { run, calls } = makeRunner({});
    await createSagemakerSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("sagemaker"),
      null,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("sagemaker-sync — model metadata walk", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    await seedAwsCreds(fx);
  });
  afterEach(() => fx.cleanup());

  test("walks models, describes each, and upserts model-registry metadata", async () => {
    const { run, calls } = makeRunner({
      "list-models": [
        {
          body: {
            Models: [
              {
                ModelName: "fraud-detector",
                ModelArn: "arn:aws:sagemaker:us-east-1:1:model/fraud-detector",
                CreationTime: 1_700_000_000,
              },
              { ModelName: "churn-model" },
            ],
          },
        },
      ],
      "describe-model": [
        {
          body: {
            ModelName: "fraud-detector",
            PrimaryContainer: {
              Image: "1.dkr.ecr.us-east-1.amazonaws.com/xgboost:latest",
              ModelDataUrl: "s3://my-bucket/models/fraud-detector/model.tar.gz",
            },
            ExecutionRoleArn: "arn:aws:iam::1:role/SageMakerRole",
          },
        },
      ],
    });
    const res = await createSagemakerSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("sagemaker"),
      null,
    );
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(res.hasMore).toBe(false);

    // First call is list-models; each model triggers a describe-model.
    expect(calls[0]?.[1]).toBe("list-models");
    expect(calls.filter((c) => c[1] === "describe-model")).toHaveLength(2);
    // FORBIDDEN: never invoke-endpoint / inference.
    for (const c of calls) {
      expect(c).not.toContain("invoke-endpoint");
      expect(c).not.toContain("sagemaker-runtime");
    }

    const rows = fx.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'sagemaker' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual([
      "arn:aws:sagemaker:us-east-1:1:model/fraud-detector",
      "churn-model",
    ]);
  });

  test("first-page list-models failure → parse-empty pass cursor, 0 upserts", async () => {
    const { run } = makeRunner({ "list-models": [{ ok: false }] });
    const res = await createSagemakerSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("sagemaker"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("paginates models via NextToken", async () => {
    const { run, calls } = makeRunner({
      "list-models": [
        { body: { Models: [{ ModelName: "m1" }], NextToken: "tok-2" } },
        { body: { Models: [{ ModelName: "m2" }] } },
      ],
      "describe-model": [{ body: {} }],
    });
    const res = await createSagemakerSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("sagemaker"),
      null,
    );
    expect(res.itemsUpserted).toBe(2);
    const listCalls = calls.filter((c) => c[1] === "list-models");
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]).toContain("--next-token");
    expect(listCalls[1]).toContain("tok-2");
  });

  test("a describe-model failure is best-effort — the model is still upserted", async () => {
    const { run } = makeRunner({
      "list-models": [{ body: { Models: [{ ModelName: "m" }] } }],
      "describe-model": [{ ok: false }],
    });
    const res = await createSagemakerSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("sagemaker"),
      null,
    );
    expect(res.itemsUpserted).toBe(1);
    expect(res.hasMore).toBe(false);
  });

  test("a `-`-prefixed model name is never passed to describe-model (flag-smuggle guard)", async () => {
    const { run, calls } = makeRunner({
      "list-models": [{ body: { Models: [{ ModelName: "--profile=attacker" }] } }],
      "describe-model": [{ body: {} }],
    });
    const res = await createSagemakerSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("sagemaker"),
      null,
    );
    // The model is still mapped/upserted from list-models metadata...
    expect(res.itemsUpserted).toBe(1);
    // ...but describe-model is NEVER called with the unsafe name.
    expect(calls.filter((c) => c[1] === "describe-model")).toHaveLength(0);
  });

  test("emits no notifications and reports bytesTransferred", async () => {
    const { run } = makeRunner({
      "list-models": [{ body: { Models: [{ ModelName: "m" }] } }],
      "describe-model": [{ body: {} }],
    });
    const res = await createSagemakerSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("sagemaker"),
      null,
    );
    expect(fx.notifications.emitted).toHaveLength(0);
    expect(res.bytesTransferred).toBeGreaterThan(0);
  });
});
