import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  createCloudLoggingSyncable,
  type RunGcloud,
} from "../../../src/connectors/cloud-logging-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CURSOR_PREFIX = "nimbus-gcplog1:";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

const ENSURE = { ensureCloudLoggingMcpRunning: async (): Promise<void> => {} };

/** Build a runGcloud stub returning canned JSON; records (credPath, project) calls. */
function makeRunner(seq: { ok?: boolean; body?: unknown }[]): {
  run: RunGcloud;
  calls: { credPath: string; project: string }[];
} {
  const calls: { credPath: string; project: string }[] = [];
  let i = 0;
  const run: RunGcloud = async (credPath, project) => {
    calls.push({ credPath, project });
    const r = seq[Math.min(i, seq.length - 1)] ?? { ok: true, body: [] };
    i += 1;
    const ok = r.ok ?? true;
    return { ok, text: ok ? JSON.stringify(r.body ?? []) : "" };
  };
  return { run, calls };
}

async function seedGcpCreds(fx: ConnectorSyncFixture): Promise<void> {
  await fx.vault.set("gcp.credentials_json_path", "/etc/gcp.json");
  await fx.vault.set("gcp.project_id", "my-project");
}

describe("cloud-logging-sync — credential short-circuit", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(() => {
    fx = createConnectorSyncFixture();
  });
  afterEach(() => fx.cleanup());

  test("no gcp vault keys → noop, runner never called, cursor preserved", async () => {
    const { run, calls } = makeRunner([]);
    const res = await createCloudLoggingSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("cloud_logging"),
      "prev",
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(calls).toHaveLength(0);
  });

  test("cred path but no project id → noop", async () => {
    await fx.vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    const { run, calls } = makeRunner([]);
    await createCloudLoggingSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("cloud_logging"),
      null,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("cloud-logging-sync — sink metadata walk", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    await seedGcpCreds(fx);
  });
  afterEach(() => fx.cleanup());

  test("lists sinks and upserts sink metadata (single pass, no token pagination)", async () => {
    const { run, calls } = makeRunner([
      {
        body: [
          {
            name: "bq-audit-sink",
            destination: "bigquery.googleapis.com/projects/p/datasets/audit",
            filter: 'logName:"cloudaudit.googleapis.com"',
            disabled: false,
            createTime: "2024-01-01T00:00:00Z",
            updateTime: "2024-06-15T12:00:00Z",
          },
          { name: "gcs-archive-sink", destination: "storage.googleapis.com/my-bucket" },
        ],
      },
    ]);
    const res = await createCloudLoggingSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("cloud_logging"),
      null,
    );
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(res.hasMore).toBe(false);

    // Exactly one gcloud invocation per cycle, with the configured creds + project.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ credPath: "/etc/gcp.json", project: "my-project" });

    const rows = fx.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'cloud_logging' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual([
      "my-project/bq-audit-sink",
      "my-project/gcs-archive-sink",
    ]);

    // No log-entry / row data stored anywhere in the indexed metadata.
    const meta = fx.db
      .query<{ metadata: string }, []>("SELECT metadata FROM item WHERE service = 'cloud_logging'")
      .all()
      .map((r) => r.metadata)
      .join("");
    expect(meta).not.toContain("textPayload");
    expect(meta).not.toContain("jsonPayload");
  });

  test("gcloud failure → parse-empty pass cursor, 0 upserts, no throw", async () => {
    const { run } = makeRunner([{ ok: false }]);
    const res = await createCloudLoggingSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("cloud_logging"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("non-array gcloud output → 0 upserts, success cursor", async () => {
    const { run } = makeRunner([{ body: { error: "unexpected" } }]);
    const res = await createCloudLoggingSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("cloud_logging"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("skips entries with no sink name", async () => {
    const { run } = makeRunner([{ body: [{ destination: "x" }, { name: "good-sink" }] }]);
    const res = await createCloudLoggingSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("cloud_logging"),
      null,
    );
    expect(res.itemsUpserted).toBe(1);
  });

  test("emits no notifications and reports bytesTransferred", async () => {
    const { run } = makeRunner([{ body: [{ name: "s" }] }]);
    const res = await createCloudLoggingSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("cloud_logging"),
      null,
    );
    expect(fx.notifications.emitted).toHaveLength(0);
    expect(res.bytesTransferred).toBeGreaterThan(0);
  });

  test("multiple sinks with mixed fields all upsert", async () => {
    const { run } = makeRunner([
      {
        body: [
          { name: "full-sink", destination: "d", filter: "f", description: "x", disabled: true },
          { name: "bare-sink" },
          { name: "extra-fields-sink", destination: "d2", writerIdentity: "ignored", foo: 1 },
        ],
      },
    ]);
    const res = await createCloudLoggingSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("cloud_logging"),
      null,
    );
    expect(res.itemsUpserted).toBe(3);
  });
});

// Exercise the real (non-DI) `gcloudLoggingSinksList` runner body without spawning
// a real subprocess: mock Bun.spawn to return a fake process. `new Response(<string>)`
// reads the canned stdout, so the spawn → exited → parse path is covered hermetically.
function fakeProc(code: number, stdout: string): ReturnType<typeof Bun.spawn> {
  return { exited: Promise.resolve(code), stdout } as unknown as ReturnType<typeof Bun.spawn>;
}

describe("cloud-logging-sync — default gcloud runner (hermetic Bun.spawn mock)", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    await seedGcpCreds(fx);
  });
  afterEach(() => fx.cleanup());

  test("spawn exits 0 with sink JSON → sinks upserted", async () => {
    const sinks = [
      { name: "s1", destination: "storage.googleapis.com/b", filter: "severity>=ERROR" },
    ];
    const spy = spyOn(Bun, "spawn").mockReturnValue(fakeProc(0, JSON.stringify(sinks)));
    try {
      const res = await createCloudLoggingSyncable(ENSURE).sync(
        fx.createSyncContext("cloud_logging"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("spawn throws (gcloud absent) → graceful empty pass, no throw", async () => {
    const spy = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("ENOENT: gcloud not found");
    });
    try {
      const res = await createCloudLoggingSyncable(ENSURE).sync(
        fx.createSyncContext("cloud_logging"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe(PASS_1_CURSOR);
    } finally {
      spy.mockRestore();
    }
  });
});
