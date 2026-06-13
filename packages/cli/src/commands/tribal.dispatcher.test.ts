import { expect, test } from "bun:test";
import { runTribalCommand, type TribalIpc } from "./tribal.ts";

interface Call {
  method: string;
  params?: unknown;
}

function fakeClient(result: unknown = {}): { client: TribalIpc; calls: Call[] } {
  const calls: Call[] = [];
  const client: TribalIpc = {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return result as T;
    },
  };
  return { client, calls };
}

test("status → tribal.status", async () => {
  const { client, calls } = fakeClient({ enabled: true, clusters: 3 });
  await runTribalCommand(client, { kind: "status" });
  expect(calls[0]?.method).toBe("tribal.status");
});

test("start / stop → tribal.start / tribal.stop", async () => {
  const a = fakeClient();
  await runTribalCommand(a.client, { kind: "start" });
  expect(a.calls[0]?.method).toBe("tribal.start");
  const b = fakeClient();
  await runTribalCommand(b.client, { kind: "stop" });
  expect(b.calls[0]?.method).toBe("tribal.stop");
});

test("list without filter sends empty params", async () => {
  const { client, calls } = fakeClient([]);
  await runTribalCommand(client, { kind: "list" });
  expect(calls[0]).toEqual({ method: "tribal.list", params: {} });
});

test("list with filter forwards the status", async () => {
  const { client, calls } = fakeClient([
    {
      clusterId: "k1",
      representativeQuestion: "how to deploy?",
      occurrenceCount: 3,
      status: "suggested",
      channelId: "C1",
    },
  ]);
  await runTribalCommand(client, { kind: "list", status: "suggested" });
  expect(calls[0]).toEqual({ method: "tribal.list", params: { status: "suggested" } });
});

test("dismiss forwards the clusterId", async () => {
  const { client, calls } = fakeClient();
  await runTribalCommand(client, { kind: "dismiss", clusterId: "k9" });
  expect(calls[0]).toEqual({ method: "tribal.dismiss", params: { clusterId: "k9" } });
});

test("scan → tribal.scan", async () => {
  const { client, calls } = fakeClient({ scanned: 5, fired: 1 });
  await runTribalCommand(client, { kind: "scan" });
  expect(calls[0]?.method).toBe("tribal.scan");
});

test("capture without target sends only the clusterId", async () => {
  const { client, calls } = fakeClient({ ok: true, pageRef: "notion:pg1" });
  await runTribalCommand(client, { kind: "capture", clusterId: "k1" });
  expect(calls[0]).toEqual({ method: "tribal.capture", params: { clusterId: "k1" } });
});

test("capture with target forwards the target", async () => {
  const { client, calls } = fakeClient({ ok: true, pageRef: "confluence:pg2" });
  await runTribalCommand(client, { kind: "capture", clusterId: "k1", target: "confluence" });
  expect(calls[0]).toEqual({
    method: "tribal.capture",
    params: { clusterId: "k1", target: "confluence" },
  });
});
