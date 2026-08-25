import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createKubernetesSyncable } from "../../../src/connectors/kubernetes-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureKubernetesMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-k8s1:";
const KUBECONFIG_PATH = "/var/secrets/kubeconfig.yaml";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

const ZERO_RV_CURSOR = encodeCursor({ resourceVersion: "0" });

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

describe("kubernetes-sync — credential short-circuits", () => {
  test("no vault keys → noop, no spawn", async () => {
    await withIsolatedFixture(async (iso) => {
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        iso.createSyncContext("kubernetes"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(iso.spawnMock.calls).toHaveLength(0);
      expect(res.cursor).toBeNull();
    });
  });

  test("empty kubeconfig → noop", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("kubernetes.kubeconfig", "");
      await createKubernetesSyncable(ENSURE_MCP).sync(iso.createSyncContext("kubernetes"), null);
      expect(iso.spawnMock.calls).toHaveLength(0);
    });
  });

  test("whitespace kubeconfig → noop", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("kubernetes.kubeconfig", "   ");
      await createKubernetesSyncable(ENSURE_MCP).sync(iso.createSyncContext("kubernetes"), null);
      expect(iso.spawnMock.calls).toHaveLength(0);
    });
  });

  test("noop preserves incoming cursor", async () => {
    await withIsolatedFixture(async (iso) => {
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        iso.createSyncContext("kubernetes"),
        "preserved-cursor",
      );
      expect(res.cursor).toBe("preserved-cursor");
    });
  });
});

describe("kubernetes-sync — with shared fixture", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    fixture.spawnMock.install();
    await fixture.vault.set("kubernetes.kubeconfig", KUBECONFIG_PATH);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("spawn invocation", () => {
    test("argv without --context: get deployments -A -o json", async () => {
      fixture.spawnMock.respond("kubectl", { exitCode: 0, stdout: '{"items":[]}' });
      await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(fixture.spawnMock.calls[0]!.binary).toBe("kubectl");
      expect(fixture.spawnMock.calls[0]!.argv).toEqual(["get", "deployments", "-A", "-o", "json"]);
    });

    test("argv with --context when kubernetes.context is set", async () => {
      await fixture.vault.set("kubernetes.context", "prod-cluster");
      fixture.spawnMock.respond("kubectl", { exitCode: 0, stdout: '{"items":[]}' });
      await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(fixture.spawnMock.calls[0]!.argv).toEqual([
        "--context",
        "prod-cluster",
        "get",
        "deployments",
        "-A",
        "-o",
        "json",
      ]);
    });

    test("whitespace context is trimmed and used", async () => {
      await fixture.vault.set("kubernetes.context", "  prod-cluster  ");
      fixture.spawnMock.respond("kubectl", { exitCode: 0, stdout: '{"items":[]}' });
      await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(fixture.spawnMock.calls[0]!.argv).toEqual([
        "--context",
        "prod-cluster",
        "get",
        "deployments",
        "-A",
        "-o",
        "json",
      ]);
    });

    test("whitespace-only context → --context omitted", async () => {
      await fixture.vault.set("kubernetes.context", "   ");
      fixture.spawnMock.respond("kubectl", { exitCode: 0, stdout: '{"items":[]}' });
      await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(fixture.spawnMock.calls[0]!.argv).not.toContain("--context");
    });

    test("env contains KUBECONFIG = kubeconfig path", async () => {
      fixture.spawnMock.respond("kubectl", { exitCode: 0, stdout: '{"items":[]}' });
      await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(fixture.spawnMock.calls[0]!.env["KUBECONFIG"]).toBe(KUBECONFIG_PATH);
    });

    test("kubeconfig is trimmed before being passed to env", async () => {
      await fixture.vault.set("kubernetes.kubeconfig", `  ${KUBECONFIG_PATH}  `);
      fixture.spawnMock.respond("kubectl", { exitCode: 0, stdout: '{"items":[]}' });
      await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(fixture.spawnMock.calls[0]!.env["KUBECONFIG"]).toBe(KUBECONFIG_PATH);
    });

    test("non-zero exit → preserves prior cursor", async () => {
      fixture.spawnMock.respond("kubectl", { exitCode: 1, stderr: "AuthError" });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        "preserved-cursor",
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe("preserved-cursor");
    });

    test("non-zero exit + null cursor → zero-rv cursor fallback", async () => {
      fixture.spawnMock.respond("kubectl", { exitCode: 1 });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.cursor).toBe(ZERO_RV_CURSOR);
    });

    test("invalid JSON → parse-empty with zero-rv cursor", async () => {
      fixture.spawnMock.respond("kubectl", { exitCode: 0, stdout: "not-json" });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe(ZERO_RV_CURSOR);
    });
  });

  describe("indexing", () => {
    test("upserts deployment with external_id `deploy:<ns>/<name>` and title `<ns>/<name>`", async () => {
      fixture.spawnMock.respond("kubectl", {
        exitCode: 0,
        stdout: JSON.stringify({
          metadata: { resourceVersion: "12345" },
          items: [
            {
              metadata: { namespace: "default", name: "frontend" },
            },
          ],
        }),
      });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<
          { external_id: string; title: string; body_preview: string | null; metadata: string },
          []
        >(
          "SELECT external_id, title, body_preview, metadata FROM item WHERE service = 'kubernetes'",
        )
        .get();
      expect(row?.external_id).toBe("deploy:default/frontend");
      expect(row?.title).toBe("default/frontend");
      expect(row?.body_preview).toBe("deployment");
      const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.namespace).toBe("default");
      expect(meta.name).toBe("frontend");
      expect(meta.kind).toBe("Deployment");
      expect(res.cursor).toBe(encodeCursor({ resourceVersion: "12345" }));
    });

    test("missing list metadata → cursor falls back to zero-rv", async () => {
      fixture.spawnMock.respond("kubectl", {
        exitCode: 0,
        stdout: JSON.stringify({
          items: [{ metadata: { namespace: "default", name: "f" } }],
        }),
      });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      expect(res.cursor).toBe(ZERO_RV_CURSOR);
    });

    test("list metadata is not a record → cursor falls back to zero-rv", async () => {
      fixture.spawnMock.respond("kubectl", {
        exitCode: 0,
        stdout: JSON.stringify({
          metadata: "not-a-record",
          items: [],
        }),
      });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.cursor).toBe(ZERO_RV_CURSOR);
    });

    test("items absent → 0 upserts; cursor reflects rv if present", async () => {
      fixture.spawnMock.respond("kubectl", {
        exitCode: 0,
        stdout: JSON.stringify({ metadata: { resourceVersion: "9" } }),
      });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe(encodeCursor({ resourceVersion: "9" }));
    });

    test("items not an array → 0 upserts", async () => {
      fixture.spawnMock.respond("kubectl", {
        exitCode: 0,
        stdout: JSON.stringify({ items: "not-array" }),
      });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
    });

    test("deployment missing namespace → skipped", async () => {
      fixture.spawnMock.respond("kubectl", {
        exitCode: 0,
        stdout: JSON.stringify({
          items: [
            { metadata: { name: "no-ns" } },
            { metadata: { namespace: "kube-system", name: "ok" } },
          ],
        }),
      });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'kubernetes'",
        )
        .get();
      expect(row?.external_id).toBe("deploy:kube-system/ok");
    });

    test("deployment missing name → skipped", async () => {
      fixture.spawnMock.respond("kubectl", {
        exitCode: 0,
        stdout: JSON.stringify({
          items: [
            { metadata: { namespace: "default" } },
            { metadata: { namespace: "default", name: "ok" } },
          ],
        }),
      });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });

    test("deployment missing metadata → skipped", async () => {
      fixture.spawnMock.respond("kubectl", {
        exitCode: 0,
        stdout: JSON.stringify({
          items: [{ spec: { replicas: 3 } }, { metadata: { namespace: "default", name: "ok" } }],
        }),
      });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });

    test("non-record items (string/number/null) → skipped", async () => {
      fixture.spawnMock.respond("kubectl", {
        exitCode: 0,
        stdout: JSON.stringify({
          items: ["string", 42, null, { metadata: { namespace: "default", name: "ok" } }],
        }),
      });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });

    test("non-record root (array) → 0 upserts; zero-rv cursor", async () => {
      fixture.spawnMock.respond("kubectl", { exitCode: 0, stdout: "[1,2,3]" });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe(ZERO_RV_CURSOR);
    });
  });

  describe("full-cycle", () => {
    test("3 deployments → 3 rows, bytesTransferred = stdout length, emits no notifications", async () => {
      const stdout = JSON.stringify({
        metadata: { resourceVersion: "999" },
        items: [
          { metadata: { namespace: "default", name: "a" } },
          { metadata: { namespace: "default", name: "b" } },
          { metadata: { namespace: "kube-system", name: "c" } },
        ],
      });
      fixture.spawnMock.respond("kubectl", { exitCode: 0, stdout });
      const res = await createKubernetesSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("kubernetes"),
        null,
      );
      expect(res.itemsUpserted).toBe(3);
      expect(res.bytesTransferred).toBe(stdout.length);
      expect(res.cursor).toBe(encodeCursor({ resourceVersion: "999" }));
      expect(fixture.notifications.emitted).toHaveLength(0);
      const rows = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'kubernetes' ORDER BY external_id",
        )
        .all();
      expect(rows.map((r) => r.external_id)).toEqual([
        "deploy:default/a",
        "deploy:default/b",
        "deploy:kube-system/c",
      ]);
    });
  });
});
