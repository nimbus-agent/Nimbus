// packages/gateway/src/connectors/warehouse-write-dispatch.test.ts
import { describe, expect, test } from "bun:test";
import type { ConnectorDispatcher } from "../engine/types.ts";
import { createWarehouseWriteDispatcher } from "./warehouse-write-dispatch.ts";

describe("createWarehouseWriteDispatcher", () => {
  test("delegates non-warehouse actions to the inner dispatcher", async () => {
    let innerCalled = false;
    const inner: ConnectorDispatcher = {
      dispatch: async () => {
        innerCalled = true;
        return { inner: true };
      },
    };
    const d = createWarehouseWriteDispatcher(inner, {
      vault: {} as never,
      sandboxCwd: "/tmp",
      credentialFor: () => ({ credential: "personal" }),
      runTeamInvoke: async () => ({}),
    });
    const out = await d.dispatch({ type: "slack.message.post", payload: { mcpToolId: "x" } });
    expect(out).toEqual({ inner: true });
    expect(innerCalled).toBe(true);
  });

  test("routes a warehouse-write action to invokeConnectorWrite with extracted args", async () => {
    let seen: unknown;
    const inner: ConnectorDispatcher = { dispatch: async () => ({ inner: true }) };
    const d = createWarehouseWriteDispatcher(inner, {
      vault: {} as never,
      sandboxCwd: "/tmp",
      credentialFor: () => ({ credential: "team", teamEntry: "wh" }),
      runTeamInvoke: async (req) => {
        seen = req;
        return { ok: true };
      },
    });
    const out = await d.dispatch({
      type: "tableau.datasource.refresh",
      payload: { mcpToolId: "tableau_datasource_refresh", id: "ds-1" },
    });
    expect(out).toEqual({ ok: true });
    expect(seen).toEqual({
      entry: "wh",
      service: "tableau",
      toolId: "tableau_datasource_refresh",
      args: { id: "ds-1" },
    });
  });
});
