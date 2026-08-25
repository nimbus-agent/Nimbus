import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createCloudwatchSyncable,
  type RunAwsCli,
} from "../../../src/connectors/cloudwatch-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CURSOR_PREFIX = "nimbus-cw1:";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

const ENSURE = { ensureCloudwatchMcpRunning: async (): Promise<void> => {} };

/** Build a runAwsCli stub that returns canned JSON keyed by the `aws logs` subcommand. */
function makeRunner(responses: Record<string, { ok?: boolean; body?: unknown }[]>): {
  run: RunAwsCli;
  calls: string[][];
} {
  const calls: string[][] = [];
  const cursors: Record<string, number> = {};
  const run: RunAwsCli = async (_ctx, args) => {
    calls.push(args);
    // args are passed to `aws <args> --output json`; for `aws logs describe-...`
    // args[0] is "logs" and args[1] is the subcommand.
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

describe("cloudwatch-sync — credential short-circuit", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(() => {
    fx = createConnectorSyncFixture();
  });
  afterEach(() => fx.cleanup());

  test("no aws vault keys → noop, runner never called, cursor preserved", async () => {
    const { run, calls } = makeRunner({});
    const res = await createCloudwatchSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("cloudwatch"),
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
    await createCloudwatchSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("cloudwatch"),
      null,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("cloudwatch-sync — log-group metadata walk", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    await seedAwsCreds(fx);
  });
  afterEach(() => fx.cleanup());

  test("walks log groups, peeks streams, and upserts log-group metadata", async () => {
    const { run, calls } = makeRunner({
      "describe-log-groups": [
        {
          body: {
            logGroups: [
              {
                logGroupName: "/aws/lambda/api",
                arn: "arn:aws:logs:us-east-1:1:log-group:/aws/lambda/api:*",
                retentionInDays: 30,
                storedBytes: 1024,
                metricFilterCount: 1,
                creationTime: 1_700_000_000_000,
              },
              { logGroupName: "/aws/ecs/web", storedBytes: 2048 },
            ],
          },
        },
      ],
      "describe-log-streams": [
        { body: { logStreams: [{ logStreamName: "a", lastEventTimestamp: 1_700_000_500_000 }] } },
      ],
    });
    const res = await createCloudwatchSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("cloudwatch"),
      null,
    );
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(res.hasMore).toBe(false);

    // First call is describe-log-groups; each group triggers a describe-log-streams peek.
    expect(calls[0]?.[1]).toBe("describe-log-groups");
    expect(calls.filter((c) => c[1] === "describe-log-streams")).toHaveLength(2);
    // The stream peek MUST NOT fetch events.
    for (const c of calls) {
      expect(c).not.toContain("get-log-events");
      expect(c).not.toContain("filter-log-events");
    }

    const rows = fx.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'cloudwatch' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual([
      "/aws/ecs/web",
      "arn:aws:logs:us-east-1:1:log-group:/aws/lambda/api:*",
    ]);
  });

  test("first-page describe-log-groups failure → parse-empty pass cursor, 0 upserts", async () => {
    const { run } = makeRunner({ "describe-log-groups": [{ ok: false }] });
    const res = await createCloudwatchSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("cloudwatch"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("paginates log groups via nextToken", async () => {
    const { run, calls } = makeRunner({
      "describe-log-groups": [
        { body: { logGroups: [{ logGroupName: "g1" }], nextToken: "tok-2" } },
        { body: { logGroups: [{ logGroupName: "g2" }] } },
      ],
      "describe-log-streams": [{ body: { logStreams: [] } }],
    });
    const res = await createCloudwatchSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("cloudwatch"),
      null,
    );
    expect(res.itemsUpserted).toBe(2);
    const groupCalls = calls.filter((c) => c[1] === "describe-log-groups");
    expect(groupCalls).toHaveLength(2);
    expect(groupCalls[1]).toContain("--next-token");
    expect(groupCalls[1]).toContain("tok-2");
  });

  test("a stream-peek failure is best-effort — the group is still upserted", async () => {
    const { run } = makeRunner({
      "describe-log-groups": [{ body: { logGroups: [{ logGroupName: "g" }] } }],
      "describe-log-streams": [{ ok: false }],
    });
    const res = await createCloudwatchSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("cloudwatch"),
      null,
    );
    expect(res.itemsUpserted).toBe(1);
    expect(res.hasMore).toBe(false);
  });

  test("emits no notifications and reports bytesTransferred", async () => {
    const { run } = makeRunner({
      "describe-log-groups": [{ body: { logGroups: [{ logGroupName: "g" }] } }],
      "describe-log-streams": [{ body: { logStreams: [] } }],
    });
    const res = await createCloudwatchSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("cloudwatch"),
      null,
    );
    expect(fx.notifications.emitted).toHaveLength(0);
    expect(res.bytesTransferred).toBeGreaterThan(0);
  });
});
