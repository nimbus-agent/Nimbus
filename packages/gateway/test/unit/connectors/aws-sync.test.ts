import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createAthenaSyncable } from "../../../src/connectors/athena-sync.ts";
import { createAwsSyncable } from "../../../src/connectors/aws-sync.ts";
import { createCloudwatchSyncable } from "../../../src/connectors/cloudwatch-sync.ts";
import { createSagemakerSyncable } from "../../../src/connectors/sagemaker-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureAwsMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-aws1:";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function withIsolatedFixture(
  fn: (fixture: ConnectorSyncFixture) => Promise<void>,
): Promise<void> {
  const isolated = createConnectorSyncFixture();
  isolated.fetchMock.install();
  isolated.spawnMock.install();
  try {
    await fn(isolated);
  } finally {
    isolated.cleanup();
  }
}

describe("aws-sync — credential short-circuits", () => {
  test("no vault keys → noop, no spawn", async () => {
    await withIsolatedFixture(async (iso) => {
      const res = await createAwsSyncable(ENSURE_MCP).sync(iso.createSyncContext("aws"), null);
      expect(res.itemsUpserted).toBe(0);
      expect(iso.spawnMock.calls).toHaveLength(0);
    });
  });

  test("ak + sk but no region + no profile → noop", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("aws.access_key_id", "x");
      await iso.vault.set("aws.secret_access_key", "y");
      await createAwsSyncable(ENSURE_MCP).sync(iso.createSyncContext("aws"), null);
      expect(iso.spawnMock.calls).toHaveLength(0);
    });
  });

  test("ak alone with region → noop (sk missing)", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("aws.access_key_id", "x");
      await iso.vault.set("aws.default_region", "us-east-1");
      await createAwsSyncable(ENSURE_MCP).sync(iso.createSyncContext("aws"), null);
      expect(iso.spawnMock.calls).toHaveLength(0);
    });
  });

  test("sk alone with region → noop (ak missing)", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("aws.secret_access_key", "y");
      await iso.vault.set("aws.default_region", "us-east-1");
      await createAwsSyncable(ENSURE_MCP).sync(iso.createSyncContext("aws"), null);
      expect(iso.spawnMock.calls).toHaveLength(0);
    });
  });

  test("whitespace-only ak + sk + region → noop", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("aws.access_key_id", "   ");
      await iso.vault.set("aws.secret_access_key", "   ");
      await iso.vault.set("aws.default_region", "us-east-1");
      await createAwsSyncable(ENSURE_MCP).sync(iso.createSyncContext("aws"), null);
      expect(iso.spawnMock.calls).toHaveLength(0);
    });
  });

  test("noop preserves incoming cursor", async () => {
    await withIsolatedFixture(async (iso) => {
      const res = await createAwsSyncable(ENSURE_MCP).sync(
        iso.createSyncContext("aws"),
        "preserved-cursor",
      );
      expect(res.cursor).toBe("preserved-cursor");
    });
  });

  test("profile-only path is valid (no ak/sk) → spawn fires with AWS_PROFILE only", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("aws.profile", "dev");
      iso.spawnMock.respond("aws", { exitCode: 0, stdout: '{"Functions":[]}' });
      const res = await createAwsSyncable(ENSURE_MCP).sync(iso.createSyncContext("aws"), null);
      expect(res.itemsUpserted).toBe(0);
      expect(iso.spawnMock.calls).toHaveLength(1);
      expect(iso.spawnMock.calls[0]!.env["AWS_PROFILE"]).toBe("dev");
      expect(iso.spawnMock.calls[0]!.env["AWS_ACCESS_KEY_ID"]).toBeUndefined();
      expect(iso.spawnMock.calls[0]!.env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    });
  });

  test("ak + sk + region (no profile) → spawn fires", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("aws.access_key_id", "aws-stub-akid");
      await iso.vault.set("aws.secret_access_key", "aws-stub-skey");
      await iso.vault.set("aws.default_region", "us-east-1");
      iso.spawnMock.respond("aws", { exitCode: 0, stdout: '{"Functions":[]}' });
      await createAwsSyncable(ENSURE_MCP).sync(iso.createSyncContext("aws"), null);
      expect(iso.spawnMock.calls).toHaveLength(1);
    });
  });

  test("ak + sk + profile (no region) → spawn fires with all four env keys", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("aws.access_key_id", "aws-stub-akid");
      await iso.vault.set("aws.secret_access_key", "aws-stub-skey");
      await iso.vault.set("aws.profile", "dev");
      iso.spawnMock.respond("aws", { exitCode: 0, stdout: '{"Functions":[]}' });
      await createAwsSyncable(ENSURE_MCP).sync(iso.createSyncContext("aws"), null);
      expect(iso.spawnMock.calls).toHaveLength(1);
      const env = iso.spawnMock.calls[0]!.env;
      expect(env["AWS_ACCESS_KEY_ID"]).toBe("aws-stub-akid");
      expect(env["AWS_SECRET_ACCESS_KEY"]).toBe("aws-stub-skey");
      expect(env["AWS_PROFILE"]).toBe("dev");
      expect(env["AWS_DEFAULT_REGION"]).toBeUndefined();
    });
  });
});

describe("aws-sync — with shared fixture", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    fixture.spawnMock.install();
    await fixture.vault.set("aws.access_key_id", "aws-stub-akid");
    await fixture.vault.set("aws.secret_access_key", "aws-stub-skey");
    await fixture.vault.set("aws.default_region", "us-east-1");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("spawn invocation", () => {
    test("argv is lambda list-functions --max-items 35 --output json", async () => {
      fixture.spawnMock.respond("aws", { exitCode: 0, stdout: '{"Functions":[]}' });
      await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(fixture.spawnMock.calls[0]!.binary).toBe("aws");
      expect(fixture.spawnMock.calls[0]!.argv).toEqual([
        "lambda",
        "list-functions",
        "--max-items",
        "35",
        "--output",
        "json",
      ]);
    });

    test("cursor with nextMarker appends --starting-token before --output", async () => {
      fixture.spawnMock.respond("aws", { exitCode: 0, stdout: '{"Functions":[]}' });
      await createAwsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("aws"),
        encodeCursor({ nextMarker: "marker-42" }),
      );
      expect(fixture.spawnMock.calls[0]!.argv).toEqual([
        "lambda",
        "list-functions",
        "--max-items",
        "35",
        "--starting-token",
        "marker-42",
        "--output",
        "json",
      ]);
    });

    test("env contains AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION", async () => {
      fixture.spawnMock.respond("aws", { exitCode: 0, stdout: '{"Functions":[]}' });
      await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      const env = fixture.spawnMock.calls[0]!.env;
      expect(env["AWS_ACCESS_KEY_ID"]).toBe("aws-stub-akid");
      expect(env["AWS_SECRET_ACCESS_KEY"]).toBe("aws-stub-skey");
      expect(env["AWS_DEFAULT_REGION"]).toBe("us-east-1");
    });

    test("non-zero exit → 0 upserts, cursor preserved", async () => {
      fixture.spawnMock.respond("aws", { exitCode: 1, stderr: "AccessDenied" });
      const res = await createAwsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("aws"),
        encodeCursor({ nextMarker: "m-1" }),
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe(encodeCursor({ nextMarker: "m-1" }));
    });

    test("non-zero exit + null cursor → falls back to encodeAwsPassCursor(null)", async () => {
      fixture.spawnMock.respond("aws", { exitCode: 1 });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.cursor).toBe(encodeCursor({ nextMarker: null }));
      expect(res.itemsUpserted).toBe(0);
      expect(res.hasMore).toBe(false);
    });

    test("invalid JSON → parse-empty pass cursor with nextMarker null", async () => {
      fixture.spawnMock.respond("aws", { exitCode: 0, stdout: "not-json" });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe(encodeCursor({ nextMarker: null }));
    });
  });

  describe("indexing", () => {
    test("upserts function with FunctionArn as external_id; title is FunctionName", async () => {
      fixture.spawnMock.respond("aws", {
        exitCode: 0,
        stdout: JSON.stringify({
          Functions: [
            {
              FunctionName: "my-fn",
              FunctionArn: "arn:aws:lambda:us-east-1:1:function:my-fn",
            },
          ],
        }),
      });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ external_id: string; title: string }, []>(
          "SELECT external_id, title FROM item WHERE service = 'aws'",
        )
        .get();
      expect(row?.external_id).toBe("arn:aws:lambda:us-east-1:1:function:my-fn");
      expect(row?.title).toBe("my-fn");
    });

    test("missing FunctionArn → falls back to FunctionName for external_id", async () => {
      fixture.spawnMock.respond("aws", {
        exitCode: 0,
        stdout: JSON.stringify({ Functions: [{ FunctionName: "only-name" }] }),
      });
      await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      const row = fixture.db
        .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'aws'")
        .get();
      expect(row?.external_id).toBe("only-name");
    });

    test("missing both FunctionArn and FunctionName → skipped", async () => {
      fixture.spawnMock.respond("aws", {
        exitCode: 0,
        stdout: JSON.stringify({ Functions: [{ Runtime: "nodejs20" }] }),
      });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.itemsUpserted).toBe(0);
    });

    test("non-record function entry skipped (string/number/null)", async () => {
      fixture.spawnMock.respond("aws", {
        exitCode: 0,
        stdout: JSON.stringify({ Functions: ["string", 42, null, { FunctionName: "fn-1" }] }),
      });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.itemsUpserted).toBe(1);
    });

    test("Functions absent → 0 upserts", async () => {
      fixture.spawnMock.respond("aws", { exitCode: 0, stdout: '{"OtherKey":[]}' });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.itemsUpserted).toBe(0);
    });

    test("Functions not an array → 0 upserts (falls back to empty list)", async () => {
      fixture.spawnMock.respond("aws", {
        exitCode: 0,
        stdout: JSON.stringify({ Functions: "not-an-array" }),
      });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.itemsUpserted).toBe(0);
    });

    test("non-record root (array) → 0 upserts", async () => {
      fixture.spawnMock.respond("aws", { exitCode: 0, stdout: "[1,2,3]" });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.itemsUpserted).toBe(0);
    });

    test("metadata captures arn and name when both present", async () => {
      fixture.spawnMock.respond("aws", {
        exitCode: 0,
        stdout: JSON.stringify({
          Functions: [
            {
              FunctionName: "my-fn",
              FunctionArn: "arn:aws:lambda:us-east-1:1:function:my-fn",
            },
          ],
        }),
      });
      await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      const row = fixture.db
        .query<{ metadata: string }, []>("SELECT metadata FROM item WHERE service = 'aws'")
        .get();
      const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.arn).toBe("arn:aws:lambda:us-east-1:1:function:my-fn");
      expect(meta.name).toBe("my-fn");
    });

    test("metadata.arn null when FunctionArn missing", async () => {
      fixture.spawnMock.respond("aws", {
        exitCode: 0,
        stdout: JSON.stringify({ Functions: [{ FunctionName: "only-name" }] }),
      });
      await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      const row = fixture.db
        .query<{ metadata: string }, []>("SELECT metadata FROM item WHERE service = 'aws'")
        .get();
      const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.arn).toBeNull();
      expect(meta.name).toBe("only-name");
    });

    test("NextMarker present → hasMore true and cursor reflects marker", async () => {
      fixture.spawnMock.respond("aws", {
        exitCode: 0,
        stdout: JSON.stringify({ Functions: [], NextMarker: "next-token-1" }),
      });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.hasMore).toBe(true);
      expect(res.cursor).toBe(encodeCursor({ nextMarker: "next-token-1" }));
    });

    test("NextMarker empty string → hasMore false, cursor with null marker", async () => {
      fixture.spawnMock.respond("aws", {
        exitCode: 0,
        stdout: JSON.stringify({ Functions: [{ FunctionName: "fn-x" }], NextMarker: "" }),
      });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.hasMore).toBe(false);
      expect(res.cursor).toBe(encodeCursor({ nextMarker: null }));
    });

    test("NextMarker explicitly null → hasMore false, cursor with null marker", async () => {
      fixture.spawnMock.respond("aws", {
        exitCode: 0,
        stdout: JSON.stringify({ Functions: [], NextMarker: null }),
      });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.hasMore).toBe(false);
      expect(res.cursor).toBe(encodeCursor({ nextMarker: null }));
    });

    test("NextMarker absent (key omitted) → hasMore false, cursor with null marker", async () => {
      fixture.spawnMock.respond("aws", {
        exitCode: 0,
        stdout: JSON.stringify({ Functions: [] }),
      });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.hasMore).toBe(false);
      expect(res.cursor).toBe(encodeCursor({ nextMarker: null }));
    });
  });

  describe("cursor decode", () => {
    test("null cursor + success → cursor with null nextMarker", async () => {
      fixture.spawnMock.respond("aws", { exitCode: 0, stdout: '{"Functions":[]}' });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.cursor).toBe(encodeCursor({ nextMarker: null }));
    });

    test("malformed (non-base64) cursor → decoded as null, spawn omits --starting-token", async () => {
      fixture.spawnMock.respond("aws", { exitCode: 0, stdout: '{"Functions":[]}' });
      await createAwsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("aws"),
        `${CURSOR_PREFIX}!!not-base64!!`,
      );
      expect(fixture.spawnMock.calls[0]!.argv).not.toContain("--starting-token");
    });

    test("cursor with non-string nextMarker → decoded as null", async () => {
      fixture.spawnMock.respond("aws", { exitCode: 0, stdout: '{"Functions":[]}' });
      await createAwsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("aws"),
        encodeCursor({ nextMarker: 42 }),
      );
      expect(fixture.spawnMock.calls[0]!.argv).not.toContain("--starting-token");
    });

    test("cursor with empty-string nextMarker → decoded as null", async () => {
      fixture.spawnMock.respond("aws", { exitCode: 0, stdout: '{"Functions":[]}' });
      await createAwsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("aws"),
        encodeCursor({ nextMarker: "" }),
      );
      expect(fixture.spawnMock.calls[0]!.argv).not.toContain("--starting-token");
    });
  });

  describe("full-cycle", () => {
    test("3 functions → 3 rows, emits no notifications, bytesTransferred = stdout length", async () => {
      const stdout = JSON.stringify({
        Functions: [
          { FunctionName: "f1", FunctionArn: "arn:1" },
          { FunctionName: "f2", FunctionArn: "arn:2" },
          { FunctionName: "f3", FunctionArn: "arn:3" },
        ],
      });
      fixture.spawnMock.respond("aws", { exitCode: 0, stdout });
      const res = await createAwsSyncable(ENSURE_MCP).sync(fixture.createSyncContext("aws"), null);
      expect(res.itemsUpserted).toBe(3);
      expect(fixture.notifications.emitted).toHaveLength(0);
      expect(res.bytesTransferred).toBe(stdout.length);
      const rows = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'aws' ORDER BY external_id",
        )
        .all();
      expect(rows.map((r) => r.external_id)).toEqual(["arn:1", "arn:2", "arn:3"]);
    });
  });
});

describe("AWS-CLI syncables share one sync cadence", () => {
  // `aws` ran at 120 s while every sibling ran at 10 min — five times the outbound API traffic,
  // indefinitely, on any machine with `aws.*` credentials in the Vault, and with no stated
  // reason for the difference. Pinned as a GROUP rather than as `aws === 600_000`, so the next
  // divergence fails here whichever member drifts.
  test("aws, cloudwatch, sagemaker and athena all use the same defaultIntervalMs", () => {
    const intervals = {
      aws: createAwsSyncable(ENSURE_MCP).defaultIntervalMs,
      cloudwatch: createCloudwatchSyncable(ENSURE_MCP).defaultIntervalMs,
      sagemaker: createSagemakerSyncable(ENSURE_MCP).defaultIntervalMs,
      athena: createAthenaSyncable(ENSURE_MCP).defaultIntervalMs,
    };
    expect(new Set(Object.values(intervals)).size).toBe(1);
    expect(intervals.aws).toBe(10 * 60 * 1000);
  });
});
