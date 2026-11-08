// packages/gateway/src/ipc/consent-diff-frame.test.ts
// D1c (plan 2.8, risk R8): a commit's diff travels TWICE in one `consent.request` frame (the prompt
// text and the structured details, whose per-line objects are much larger than the lines). The
// worst case the caps allow is a new file of empty lines (about 32,700 diff lines of 2 bytes each),
// MEASURED here at about 785 KB: under the 1 MiB NDJSON line limit with a 25% margin, not the
// 400 KiB the plan guessed.
import { afterEach, describe, expect, test } from "bun:test";
import { COMMIT_LIMITS } from "../connectors/connector-writes/commit-limits.ts";
import { diffTextLines, renderUnifiedDiff } from "../connectors/connector-writes/diff.ts";
import { ConsentCoordinatorImpl } from "./consent.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";
import { IPC_MAX_LINE_BYTES, type JsonRpcNotification } from "./jsonrpc.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

const NL = "\n";
const BACKSLASH = String.fromCharCode(92);

describe("the consent.request frame of a worst-case commit diff", () => {
  function frameBytes(oldContent: string | undefined, newContent: string): number {
    const r = renderUnifiedDiff([{ path: "worst.txt", oldContent, newContent, mode: "100644" }], {
      maxBytes: COMMIT_LIMITS.maxDiffBytes,
    });
    if (!r.ok) throw new Error("the case must fit the cap");
    const text = diffTextLines(r.diff).join(NL);
    const prompt = `${text}${NL}End of diff: 1 file${NL}${NL}To approve, type exactly: github/commit acme/api@main`;
    const sent: JsonRpcNotification[] = [];
    const c = new ConsentCoordinatorImpl(() => (n) => sent.push(n));
    c.requestConfirmedConsent("a", {
      requestId: "r1",
      prompt,
      details: { kind: "connector-write", diff: r.diff },
      actionType: "github.file.commit",
      confirmText: "github/commit acme/api@main",
    }).catch(() => undefined);
    c.rejectAllPending("test", "test");
    return new TextEncoder().encode(`${JSON.stringify(sent[0])}${NL}`).length;
  }

  test("empty lines (the most lines the cap allows): under the IPC line cap with a 20% margin", () => {
    const bytes = frameBytes(undefined, NL.repeat(32_700));
    expect(bytes).toBeGreaterThan(700_000); // the test measures the real worst case
    expect(bytes).toBeLessThan(IPC_MAX_LINE_BYTES * 0.8);
  });

  test("quote and backslash heavy text (JSON doubles each): also under the cap", () => {
    const bytes = frameBytes(`${BACKSLASH}${NL}`.repeat(8000), `"${NL}`.repeat(10_000));
    expect(bytes).toBeLessThan(IPC_MAX_LINE_BYTES * 0.8);
  });

  test("the cap relationship holds by arithmetic as well", () => {
    // at most one diff line per 2 bytes, each a structured object of at most ~24 bytes, plus the
    // prompt copy with JSON doubling at worst, plus 64 KiB of everything else
    const lines = COMMIT_LIMITS.maxDiffBytes / 2;
    expect(lines * 24 + COMMIT_LIMITS.maxDiffBytes * 2 + 64 * 1024).toBeLessThan(
      IPC_MAX_LINE_BYTES,
    );
  });
});
