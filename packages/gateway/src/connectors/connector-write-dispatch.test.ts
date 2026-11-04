// packages/gateway/src/connectors/connector-write-dispatch.test.ts

import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import type { ConnectorDispatcher } from "../engine/types.ts";
import { createConnectorWriteDispatcher } from "./connector-write-dispatch.ts";

const SANDBOX_CWD = path.join(os.tmpdir(), "nimbus-test");

describe("createConnectorWriteDispatcher", () => {
  test("delegates non-write actions to the inner dispatcher", async () => {
    let innerCalled = false;
    const inner: ConnectorDispatcher = {
      dispatch: async () => {
        innerCalled = true;
        return { inner: true };
      },
    };
    const d = createConnectorWriteDispatcher(inner, {
      vault: {} as never,
      sandboxCwd: SANDBOX_CWD,
      isConnectorAllowed: () => true,
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
    const d = createConnectorWriteDispatcher(inner, {
      vault: {} as never,
      sandboxCwd: SANDBOX_CWD,
      isConnectorAllowed: () => true,
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

  test("routes a GitOps write action (argocd.app.sync) to the right service/toolId", async () => {
    let seen: unknown;
    const inner: ConnectorDispatcher = { dispatch: async () => ({ inner: true }) };
    const d = createConnectorWriteDispatcher(inner, {
      vault: {} as never,
      sandboxCwd: SANDBOX_CWD,
      isConnectorAllowed: () => true,
      credentialFor: () => ({ credential: "team", teamEntry: "argo" }),
      runTeamInvoke: async (req) => {
        seen = req;
        return { ok: true };
      },
    });
    const out = await d.dispatch({
      type: "argocd.app.sync",
      payload: { mcpToolId: "argocd_app_sync", name: "web" },
    });
    expect(out).toEqual({ ok: true });
    expect(seen).toEqual({
      entry: "argo",
      service: "argocd",
      toolId: "argocd_app_sync",
      args: { name: "web" },
    });
  });

  describe("the listed-key guard", () => {
    function guarded(): { d: ConnectorDispatcher; sent: unknown[] } {
      const sent: unknown[] = [];
      const d = createConnectorWriteDispatcher(
        { dispatch: async () => ({ inner: true }) },
        {
          vault: {} as never,
          sandboxCwd: SANDBOX_CWD,
          isConnectorAllowed: () => true,
          credentialFor: () => ({ credential: "team", teamEntry: "argo" }),
          runTeamInvoke: async (req) => {
            sent.push(req);
            return { ok: true };
          },
        },
      );
      return { d, sent };
    }

    test("an mcpToolId naming another tool is refused and nothing is sent", async () => {
      const { d, sent } = guarded();
      await expect(
        d.dispatch({
          type: "argocd.app.sync",
          payload: { mcpToolId: "argocd_argocd_app_rollback", name: "web" },
        }),
      ).rejects.toThrow(/mcpToolId does not name its tool/);
      await expect(
        d.dispatch({ type: "argocd.app.sync", payload: { mcpToolId: "", name: "web" } }),
      ).rejects.toThrow(/mcpToolId does not name its tool/);
      expect(sent).toEqual([]);
    });

    test("the row's bare id, its listed key, or no id at all is dispatched", async () => {
      const { d, sent } = guarded();
      for (const payload of [
        { mcpToolId: "argocd_app_sync", name: "web" },
        { mcpToolId: "argocd_argocd_app_sync", name: "web" },
        { name: "web" },
      ]) {
        expect(await d.dispatch({ type: "argocd.app.sync", payload })).toEqual({ ok: true });
      }
      expect(sent).toHaveLength(3);
      for (const req of sent) {
        expect(req).toEqual({
          entry: "argo",
          service: "argocd",
          toolId: "argocd_app_sync",
          args: { name: "web" },
        });
      }
    });
  });
});
