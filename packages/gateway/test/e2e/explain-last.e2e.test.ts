// E2E over a REAL gateway socket for `nimbus explain last` (spec §3.1, §9).
//
// This is the ONE layer that catches a handler wired into `diagnostics-rpc.ts`'s
// `dispatchDiagnosticsRpc` switch without a matching entry in `tryDispatchDiagnosticsRpc`'s own
// method-prefix/name match in `ipc/server/dispatchers.ts` — that combination compiles cleanly and
// every unit test that calls `dispatchDiagnosticsRpc` directly stays green, because those tests
// never go through the outer router at all. Over a real socket, the outer router is exactly what
// decides whether the request reaches the inner dispatcher in the first place: miss the routing
// entry and a real client gets "Method not found", live. This repo has shipped exactly that
// defect before.
//
// Boots a real gateway subprocess (the same `gateway-runner.ts` fixture `tail-stream.e2e.test.ts`
// uses) and drives it over a real Unix-socket/named-pipe connection with a minimal JSON-RPC client
// — no mocks at the IPC layer.
import { describe, expect, test } from "bun:test";
import {
  startRealGateway,
  TEST_TIMEOUT_MS,
  TinyIpcClient,
} from "./_fixtures/real-gateway-client.ts";

describe("explain last over a real socket", () => {
  test(
    "reports the empty state on a fresh gateway, then the ask, over a real ask.explainLast route",
    async () => {
      const gw = await startRealGateway("basic");
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);

        // Over a REAL socket: this is the only layer that catches a handler wired into
        // `dispatchDiagnosticsRpc` but never added to `tryDispatchDiagnosticsRpc`'s outer match —
        // that returns "Method not found" live while every unit test calling the sub-dispatcher
        // directly stays green.
        const empty = await client.call<{ record: unknown; reason: string }>(
          "ask.explainLast",
          null,
        );
        expect(empty).toEqual({ record: null, reason: "no_ask_since_start" });

        // A fresh gateway has an empty index, so this ask takes the `empty_index` route rather
        // than actually answering — and records WITHOUT throwing either way (`run-ask.ts`'s
        // `recordExplainSafely` runs on every exit path). Assert on the recorded question, not on
        // a particular route, so this test does not depend on which route a fresh index happens
        // to take.
        const askReply = await client.raw("agent.invoke", {
          input: "what is indexed?",
          stream: false,
        });
        // `agent.invoke` may itself surface a domain error on an empty index (a separate,
        // already-covered concern) — what matters here is only that a record now exists.
        void askReply;

        const after = await client.call<{ record: Record<string, unknown> | null }>(
          "ask.explainLast",
          null,
        );
        expect(after.record?.["question"]).toBe("what is indexed?");

        // Assert the KEY SET a real gateway produced (fix-wave finding CRITICAL 2), not just that
        // SOME record came back. `explain-format.ts`'s CLI-side parser is a strict, independently
        // declared mirror of the gateway's `AskExplainRecord` — a gateway-side rename of any field
        // here would not degrade the CLI report, it would replace it with a malformed-response
        // error, and no unit test on either side alone can catch that: this is the one place both
        // shapes are checked against what actually crossed the wire. A fresh, empty index takes
        // the `empty_index` route, whose only field beyond the shared base is `route` itself;
        // `modelRoute` and `fallbackFromLocalRouter` are never set on this route, so they must be
        // ABSENT here, not merely unchecked.
        const record = after.record;
        expect(record).not.toBeNull();
        if (record !== null && record !== undefined) {
          expect(new Set(Object.keys(record))).toEqual(
            new Set([
              "askedAt",
              "durationMs",
              "question",
              "source",
              "persona",
              "classifier",
              "route",
            ]),
          );
          expect(record["route"]).toBe("empty_index");
        }
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
