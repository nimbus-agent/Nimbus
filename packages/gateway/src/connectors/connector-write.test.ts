// packages/gateway/src/connectors/connector-write.test.ts
import { describe, expect, test } from "bun:test";
import { type ConnectorWrite, w } from "./connector-write.ts";

describe("connector-write — shared write descriptor", () => {
  test("w() builds a 1:1 {actionType, toolId, service} row", () => {
    const row: ConnectorWrite = w("argocd.app.sync", "argocd_app_sync", "argocd");
    expect(row).toEqual({
      actionType: "argocd.app.sync",
      toolId: "argocd_app_sync",
      service: "argocd",
    });
  });
});
