import { expect, test } from "bun:test";

import { PremortemRefresherError } from "../premortem/premortem-refresh.ts";
import { dispatchPremortemRpc, PremortemRpcError } from "./premortem-rpc.ts";

const RESULT = { scanned: 4, themesWritten: 2, demoted: 1, prunedEvidence: 0, llmCalls: 1 };

test("premortem.refresh runs the pass and returns its counts", async () => {
  let ran = 0;
  const out = await dispatchPremortemRpc("premortem.refresh", null, {
    premortemRefresher: {
      runNow: async () => {
        ran += 1;
        return RESULT;
      },
    },
  });
  expect(ran).toBe(1);
  expect(out).toEqual({ kind: "hit", value: RESULT });
});

test("an unrelated method misses so the next dispatcher can claim it", async () => {
  const out = await dispatchPremortemRpc("glossary.refresh", null, {
    premortemRefresher: { runNow: async () => RESULT },
  });
  expect(out.kind).toBe("miss");
});

test("refresh with the pass disabled is an explicit error, not a silent no-op", async () => {
  // A silent success would tell the user their themes were refreshed when the
  // subsystem is switched off entirely.
  await expect(
    dispatchPremortemRpc("premortem.refresh", null, { premortemRefresher: undefined }),
  ).rejects.toThrow(/premortem.*disabled/i);
});

test("refresh with no premortemRefresher key at all is also an explicit error", async () => {
  await expect(dispatchPremortemRpc("premortem.refresh", null, {})).rejects.toThrow(
    /premortem.*disabled/i,
  );
});

test("premortem.refresh rejects parameters rather than ignoring them", async () => {
  // It takes none. Accepting and dropping one would let a caller believe they
  // had scoped the refresh.
  await expect(
    dispatchPremortemRpc(
      "premortem.refresh",
      { service: "jira" },
      { premortemRefresher: { runNow: async () => RESULT } },
    ),
  ).rejects.toThrow(/no parameters/i);
});

test("premortem.refresh rejects a non-empty array param", async () => {
  await expect(
    dispatchPremortemRpc("premortem.refresh", ["jira"], {
      premortemRefresher: { runNow: async () => RESULT },
    }),
  ).rejects.toThrow(/no parameters/i);
});

test("premortem.refresh accepts an empty object as equivalent to no params", async () => {
  const out = await dispatchPremortemRpc(
    "premortem.refresh",
    {},
    { premortemRefresher: { runNow: async () => RESULT } },
  );
  expect(out).toEqual({ kind: "hit", value: RESULT });
});

test("a single-flight PremortemRefresherError surfaces as a PremortemRpcError with the same rpcCode", async () => {
  // The gateway CANNOT assume runNow() always resolves: it carries a single-flight
  // guard and rejects with PremortemRefresherError (ERR_PREMORTEM_PASS_RUNNING /
  // ERR_PREMORTEM_STOPPED) when a pass is already in flight or the gateway is
  // shutting down. That rejection must surface as a proper JSON-RPC error, not an
  // unhandled rejection or a generic 500.
  const refresherErr = new PremortemRefresherError(
    "ERR_PREMORTEM_PASS_RUNNING: a pre-mortem pass is already running",
  );
  let caught: unknown;
  try {
    await dispatchPremortemRpc("premortem.refresh", null, {
      premortemRefresher: {
        runNow: async () => {
          throw refresherErr;
        },
      },
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(PremortemRpcError);
  expect((caught as PremortemRpcError).rpcCode).toBe(refresherErr.rpcCode);
  expect((caught as PremortemRpcError).message).toBe(refresherErr.message);
});

test("a non-PremortemRefresherError from runNow propagates unchanged", async () => {
  const boom = new Error("unexpected db failure");
  let caught: unknown;
  try {
    await dispatchPremortemRpc("premortem.refresh", null, {
      premortemRefresher: {
        runNow: async () => {
          throw boom;
        },
      },
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBe(boom);
});
