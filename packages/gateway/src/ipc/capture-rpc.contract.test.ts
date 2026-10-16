// The binding between packages/gateway and the desktop Captures page (packages/ui may not import
// gateway source). It drives the REAL `captures.list` / `captures.get` over REAL rows written by the
// gate's own submit/accept/revoke, then requires the committed UI fixture to have the SAME SHAPE.
// Regenerate with UPDATE_CAPTURES_FIXTURE=1 after an intended shape change; the desktop tests then
// run on the new shape. The clock and ids are fixed, so a regenerated fixture is byte-stable.
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { resolveCaptureCapability } from "../mcp-sink/capture-capability.ts";
import type { CaptureGateDeps } from "../mcp-sink/capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "../mcp-sink/capture-rate-limit.ts";
import { CaptureStore } from "../mcp-sink/capture-store.ts";
import { dispatchCaptureRpc } from "./capture-rpc.ts";

const FIXTURE = join(import.meta.dir, "..", "..", "..", "ui", "test", "fixtures", "captures.json");
const FIXED_EPOCH = 1_790_000_000_000;

let dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs) d.close();
  dbs = [];
});

/**
 * A value's type tree: what the desktop depends on, without the values. A field that is null in
 * every fixture row is checked only as null, so the rows below make decidedAt, clientLabel,
 * nativeStatus, nativeRef, itemId and payload non-null somewhere. expiresAt, outcomeRef and
 * errorCode belong to the act door's rows (an action needs a routed connector to submit) and are
 * pinned by key only.
 */
function shape(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.map(shape);
  if (typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, shape(x)]),
    );
  }
  return typeof v;
}

const MCP = { clientId: "m", kind: "mcp" as const };
const OWNER = { clientId: "o", kind: "ui" as const };

test("the UI fixture has the shape the real captures.list / captures.get return", async () => {
  const db = openMigratedMemoryDb();
  dbs.push(db);
  let seq = 0;
  let now = FIXED_EPOCH;
  const gate: CaptureGateDeps = {
    db,
    store: new CaptureStore(db),
    capability: () =>
      resolveCaptureCapability(
        { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } },
        { capabilitiesDisabled: new Set() },
      ),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_contract_${String(++seq)}`,
    now: () => now,
  };
  const ctx = { gate };
  const call = async (
    method: string,
    params: unknown,
    caller: typeof MCP | typeof OWNER,
  ): Promise<unknown> => {
    const out = await dispatchCaptureRpc(method, params, ctx, caller);
    if (out.kind !== "hit") throw new Error(`miss: ${method}`);
    return out.value;
  };

  // A live note, a proposed decision the owner then accepts, and a note the owner revokes: every
  // nullable field the page renders is non-null on at least one of them. The owner caller is `ui`,
  // the kind the desktop wears, so the owner check is exercised as the renderer meets it.
  await call(
    "capture.submit",
    { kind: "note", clientLabel: "claude-desktop", payload: { title: "Kept", body: "b" } },
    MCP,
  );
  now += 60_000;
  await call(
    "capture.submit",
    { kind: "decision", clientLabel: "claude-desktop", payload: { statement: "Use WAL" } },
    MCP,
  );
  now += 60_000;
  await call("capture.submit", { kind: "note", payload: { title: "Revoked", body: "gone" } }, MCP);
  now += 60_000;
  await call("captures.accept", { id: "cap_contract_2" }, OWNER);
  await call("captures.revoke", { id: "cap_contract_3" }, OWNER);

  const live = {
    list: await call("captures.list", { limit: 200 }, OWNER),
    get: await call("captures.get", { id: "cap_contract_2" }, OWNER),
    getRevoked: await call("captures.get", { id: "cap_contract_3" }, OWNER),
  };
  if (process.env["UPDATE_CAPTURES_FIXTURE"] === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(live, null, 2)}\n`);
  }
  const committed: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));
  expect(shape(live)).toEqual(shape(committed));
  // The values the desktop tests rely on, pinned so a regenerated fixture cannot quietly lose them.
  const l = live as {
    list: { captures: { id: string; state: string }[] };
    get: { state: string; nativeStatus: unknown; payload: unknown };
    getRevoked: { state: string; payload: unknown };
  };
  expect(l.list.captures.map((c) => [c.id, c.state])).toEqual([
    ["cap_contract_3", "revoked"],
    ["cap_contract_2", "accepted"],
    ["cap_contract_1", "live"],
  ]);
  expect(l.get.state).toBe("accepted");
  expect(l.get.nativeStatus).toBe("owned");
  expect(l.getRevoked.payload).toBeNull();
});
