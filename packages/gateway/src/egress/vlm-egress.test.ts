import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { VlmProvider } from "../multimodal/vlm/vlm-types.ts";
import { listEgress } from "./egress-verify.ts";
import { EgressAppendFailedError } from "./model-egress.ts";
import { wrapLedgeredVlm } from "./vlm-egress.ts";

// The REAL schema via the migration runner — the pattern every other `egress/*.test.ts` uses.
// `appendEgressEntry` reads the head hash and computes a BLAKE3 chain over prior rows, so a
// hand-rolled CREATE TABLE would exercise something other than the code path that runs. Rows come
// back camelCased from `listEgress`.
function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  return d;
}

function fakeVlm(isLocal: boolean, onDescribe?: () => void): VlmProvider {
  return {
    providerId: "ollama",
    isLocal,
    model: "qwen2.5vl:7b",
    isAvailable: () => Promise.resolve(true),
    describe: () => {
      onDescribe?.();
      return Promise.resolve({ text: "a caption" });
    },
  };
}

describe("wrapLedgeredVlm", () => {
  test("a LOCAL provider is returned unchanged and appends nothing", async () => {
    const d = db();
    const local = fakeVlm(true);
    const wrapped = wrapLedgeredVlm(d, local);
    expect(wrapped).toBe(local);
    await wrapped.describe({ bytes: new Uint8Array([1]), prompt: "p" });
    expect(listEgress(d, {})).toHaveLength(0);
  });

  test("a NON-LOCAL provider appends one model-class row per describe", async () => {
    const d = db();
    const wrapped = wrapLedgeredVlm(d, fakeVlm(false), () => 1234);
    await wrapped.describe({ bytes: new Uint8Array([1]), prompt: "p" });
    await wrapped.describe({ bytes: new Uint8Array([2]), prompt: "p" });
    const r = listEgress(d, {});
    expect(r).toHaveLength(2);
    expect(r[0]?.sourceType).toBe("model");
    // #1321's lesson: the destination names the VENDOR, never the word "model".
    expect(r[0]?.destination).toBe("ollama");
    expect(r[0]?.sourceId).toBe("qwen2.5vl:7b");
    expect(r[0]?.method).toBe("multimodal.vlm.describe");
    expect(r[0]?.timestamp).toBe(1234);
    expect(r[0]?.resultStatus).toBe("authorized");
  });

  test("egressMethod NAMES the row and cannot suppress it", async () => {
    const d = db();
    const wrapped = wrapLedgeredVlm(d, fakeVlm(false));
    await wrapped.describe({
      bytes: new Uint8Array([1]),
      prompt: "p",
      egressMethod: "multimodal.vlm.frame",
    });
    const r = listEgress(d, {});
    expect(r).toHaveLength(1);
    expect(r[0]?.method).toBe("multimodal.vlm.frame");
  });

  test("the append happens BEFORE the request, and a failed append aborts it", async () => {
    const d = db();
    let described = false;
    const wrapped = wrapLedgeredVlm(
      d,
      fakeVlm(false, () => (described = true)),
    );
    d.run("DROP TABLE egress_ledger");
    await expect(
      wrapped.describe({ bytes: new Uint8Array([1]), prompt: "p" }),
    ).rejects.toBeInstanceOf(EgressAppendFailedError);
    expect(described).toBe(false);
  });

  test("no image bytes and no prompt reach the payload summary", async () => {
    const d = db();
    const wrapped = wrapLedgeredVlm(d, fakeVlm(false));
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await wrapped.describe({ bytes, prompt: "secret" });
    const summary = String(listEgress(d, {})[0]?.payloadSummary ?? "");
    expect(summary).not.toContain("secret");
    expect(summary).toContain("qwen2.5vl:7b");
    // `not.toContain("dead")` alone cannot fail: `redactEgressSummary` JSON-serializes, so a
    // `Uint8Array` never renders as the string "dead" (it becomes an index-keyed object or a
    // base64 string), and neither of those forms contains that substring even if the bytes DID
    // leak. Assert positively on the summary's SHAPE instead — the exact key set, nothing more —
    // plus a targeted negative check against the one encoding an accidental leak would actually
    // take (base64), which together can fail if a future edit widens the payload.
    const parsed: unknown = JSON.parse(summary);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    expect(Object.keys(parsed as Record<string, unknown>).sort()).toEqual(
      ["imageBytes", "model"].sort(),
    );
    expect(summary).not.toContain(Buffer.from(bytes).toString("base64"));
  });

  test("locality is read off the provider, so a caller cannot fabricate or suppress rows", () => {
    const d = db();
    // No parameter exists to say "this is local" — the only source is the provider's own field.
    expect(wrapLedgeredVlm(d, fakeVlm(true)).isLocal).toBe(true);
    expect(wrapLedgeredVlm(d, fakeVlm(false)).isLocal).toBe(false);
  });
});
