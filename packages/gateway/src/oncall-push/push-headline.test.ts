import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAgentCommand } from "../agent-commands/parse-agent-command.ts";
import { selectIncidentById } from "../agents/_lib/oncall-queries.ts";
import { fireDemoPage, seedDemoCorpus } from "../demo/seed.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { EXTERNAL_AGENT_NAMES } from "../ipc/agents-rpc.ts";
import {
  FIELD_MAX_CODEPOINTS,
  oneLine,
  parseHeadlineBrief,
  pushAgentCommand,
  renderPushHeadline,
  renderPushSummary,
  SUMMARY_ID_CAP,
} from "./push-headline.ts";
import type { PushDelivery } from "./push-runner.ts";
import { assembleOncallPushRuntime } from "./push-runtime.ts";

let dbs: Database[] = [];
let roots: string[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  dbs = [];
  roots = [];
});

/** A REAL pushed row: the demo seed, then the same run a PagerDuty sync triggers. */
async function realDelivery(): Promise<PushDelivery> {
  const root = mkdtempSync(join(tmpdir(), "nimbus-push-headline-"));
  roots.push(root);
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  const nowMs = Date.now();
  await seedDemoCorpus(db, { configDir, dataDir, nowMs });
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: { error: () => {} },
    now: () => nowMs,
    settleImmediately: true,
  });
  const fired = await fireDemoPage(db, rt, nowMs);
  const row = rt.store.get(fired.incidentId);
  const incident = selectIncidentById(db, fired.incidentId);
  if (row === null || incident === null) throw new Error("fixture: no pushed row");
  if (row.status !== "ok") throw new Error(`fixture: expected ok, got ${row.failureCode}`);
  return { row, incident };
}

/** The real brief JSON with one top-level key replaced. */
function withBrief(d: PushDelivery, patch: Record<string, unknown>): PushDelivery {
  const base = JSON.parse(d.row.briefJson ?? "null") as Record<string, unknown>;
  return { ...d, row: { ...d.row, briefJson: JSON.stringify({ ...base, ...patch }) } };
}
function lines(s: string): string[] {
  return s.split("\n");
}

describe("parseHeadlineBrief over the REAL stored brief", () => {
  test("reads the binding and the story deployment", async () => {
    const d = await realDelivery();
    const b = parseHeadlineBrief(d.row.briefJson);
    expect(b).not.toBeNull();
    expect(b?.nimbusServiceId).toBe("payment-service");
    expect(typeof b?.deployment?.title).toBe("string");
  });
  test("null, malformed and wrong-shape JSON all mean no brief", () => {
    expect(parseHeadlineBrief(null)).toBeNull();
    expect(parseHeadlineBrief("{not json")).toBeNull();
    expect(parseHeadlineBrief("{}")).toBeNull();
    expect(parseHeadlineBrief("[]")).toBeNull();
    expect(parseHeadlineBrief('{"binding":{"nimbusServiceId":3},"deployment":null}')).toBeNull();
    expect(parseHeadlineBrief('{"binding":{"nimbusServiceId":null}}')).toBeNull(); // deployment key absent
    expect(
      parseHeadlineBrief(
        '{"binding":{},"deployment":{"title":"D","startedAtMs":1,"finishedAtMs":"x"}}',
      ),
    ).toBeNull(); // a nullable field with the WRONG TYPE still rejects
  });
  test("a MISSING nullable key reads as null rather than rejecting a real brief", () => {
    expect(parseHeadlineBrief('{"binding":{},"deployment":{"title":"D","startedAtMs":5}}')).toEqual(
      { nimbusServiceId: null, deployment: { title: "D", startedAtMs: 5, finishedAtMs: null } },
    );
  });
});

describe("renderPushHeadline", () => {
  test("ok with a deployment: three lines, minutes before, the timing disclosure", async () => {
    const d = await realDelivery();
    const out = lines(renderPushHeadline(d));
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("P1 · payment-service — payment-service: 5xx rate above 5% on /v1/charges");
    expect(out[1]).toStartWith("Last deployment before the alert: ");
    // The seeded story deploy finishes ~8 minutes before the page (demo/corpus/acme.ts).
    expect(out[1]).toContain("(8 min before) — timing only, not a proven cause");
    expect(out[2]).toBe(
      "@nimbus agent oncall incidentId=pagerduty:PDEMO412  ·  locally: nimbus oncall pushed pagerduty:PDEMO412",
    );
  });

  test("the call to action parses through the REAL ChatOps agent grammar", async () => {
    const d = await realDelivery();
    const cmd = pushAgentCommand(d.row.incidentId);
    expect(renderPushHeadline(d)).toContain(cmd);
    expect(parseAgentCommand(cmd, new Set(EXTERNAL_AGENT_NAMES))).toEqual({
      ok: true,
      agent: "oncall",
      params: { incidentId: "pagerduty:PDEMO412" },
    });
  });

  test("finishedAtMs null falls back to startedAtMs; a deploy after the alert floors at 0", async () => {
    const d = await realDelivery();
    const opened = d.incident.openedAtMs ?? 0;
    const startedOnly = withBrief(d, {
      deployment: { title: "Deploy", startedAtMs: opened - 30 * 60_000, finishedAtMs: null },
    });
    expect(lines(renderPushHeadline(startedOnly))[1]).toContain("(30 min before)");
    const after = withBrief(d, {
      deployment: { title: "Deploy", startedAtMs: opened + 60_000, finishedAtMs: opened + 120_000 },
    });
    expect(lines(renderPushHeadline(after))[1]).toContain("(0 min before)");
  });

  test("openedAtMs null omits the minutes clause", async () => {
    const d = await realDelivery();
    const noOpen: PushDelivery = { ...d, incident: { ...d.incident, openedAtMs: null } };
    const l = lines(renderPushHeadline(noOpen))[1] ?? "";
    expect(l).not.toContain("min before");
    expect(l).toEndWith(" — timing only, not a proven cause");
  });

  test("no deployment", async () => {
    const d = withBrief(await realDelivery(), { deployment: null });
    expect(lines(renderPushHeadline(d))[1]).toBe("No deployment found before the alert");
  });

  test("a failed row and unusable JSON: could-not-be-assembled, with no second agent command", async () => {
    const d = await realDelivery();
    const failed: PushDelivery = {
      ...d,
      row: { ...d.row, status: "failed", briefJson: null, failureCode: "timeout: x" },
    };
    const malformed: PushDelivery = { ...d, row: { ...d.row, briefJson: "{oops" } };
    for (const x of [failed, malformed]) {
      const out = lines(renderPushHeadline(x));
      expect(out[1]).toBe("Brief could not be assembled; rerun the agent below to retry");
      expect(out[1]).not.toContain("@nimbus");
      expect(out[2]).toContain(pushAgentCommand(x.row.incidentId));
    }
  });

  test("service fallbacks: null AND empty fall through; then unknown service", async () => {
    const d = await realDelivery();
    const pd = d.incident.pagerdutyServiceId;
    for (const sid of [null, "", "   "]) {
      const x = withBrief(d, { binding: { nimbusServiceId: sid, pagerdutyServiceId: pd } });
      expect(lines(renderPushHeadline(x))[0]).toStartWith(`P1 · ${pd} — `);
    }
    const none: PushDelivery = {
      ...withBrief(d, { binding: { nimbusServiceId: null, pagerdutyServiceId: null } }),
      incident: { ...d.incident, pagerdutyServiceId: null },
    };
    expect(lines(renderPushHeadline(none))[0]).toStartWith("P1 · unknown service — ");
  });

  test("severity falls back to P1 when null or blank", async () => {
    const d = await realDelivery();
    for (const severity of [null, " "]) {
      const x: PushDelivery = { ...d, incident: { ...d.incident, severity } };
      expect(lines(renderPushHeadline(x))[0]).toStartWith("P1 · ");
    }
    const sev2: PushDelivery = { ...d, incident: { ...d.incident, severity: "SEV2" } };
    expect(lines(renderPushHeadline(sev2))[0]).toStartWith("SEV2 · ");
  });

  test("a hostile title renders inert", async () => {
    const d = await realDelivery();
    const x: PushDelivery = {
      ...d,
      incident: { ...d.incident, title: "DB down <!channel> <https://evil|Rollback docs> & more" },
    };
    const first = lines(renderPushHeadline(x))[0] ?? "";
    expect(first).not.toContain("<");
    expect(first).toContain(
      "DB down &lt;!channel&gt; &lt;https://evil|Rollback docs&gt; &amp; more",
    );
  });

  test("line breaks in either title cannot forge a line: still exactly three lines", async () => {
    const d = await realDelivery();
    const x: PushDelivery = {
      ...withBrief(d, {
        deployment: {
          title: "Deploy\r\nNo deployment found before the alert",
          startedAtMs: 1,
          finishedAtMs: 2,
        },
      }),
      incident: { ...d.incident, title: "a\nb\u2028c\td\u0085e" },
    };
    const out = lines(renderPushHeadline(x));
    expect(out).toHaveLength(3);
    expect(out[0]).toEndWith("— a b c d e");
    expect(out[1]).toContain("Deploy No deployment found before the alert");
    expect(out[1]).toEndWith(" — timing only, not a proven cause");
  });

  // Review Focus 1
  test("an empty or whitespace-only title renders (untitled)", async () => {
    const d = await realDelivery();
    for (const title of ["", " \n\t "]) {
      const x: PushDelivery = { ...d, incident: { ...d.incident, title } };
      expect(lines(renderPushHeadline(x))[0]).toEndWith("— (untitled)");
    }
  });

  // Review Focus 4
  test("an id with Slack control characters (<, &, >) renders escaped", async () => {
    const d = await realDelivery();
    const x: PushDelivery = { ...d, row: { ...d.row, incidentId: "pagerduty:P<&>" } };
    const third = lines(renderPushHeadline(x))[2] ?? "";
    expect(third).not.toContain("<");
    expect(third).toContain("incidentId=pagerduty:P&lt;&amp;&gt;");
  });
});

describe("oneLine", () => {
  // Review Focus 3
  test("removes bidi overrides, isolates, zero-width characters and the BOM", () => {
    expect(oneLine("abc\u202Edef\u2066g\u200Bh\uFEFF")).toBe("abcdefgh");
  });
  // Review Focus 2
  test("caps at FIELD_MAX_CODEPOINTS with an ellipsis, never splitting a surrogate pair", () => {
    const long = "😀".repeat(FIELD_MAX_CODEPOINTS + 5);
    const out = oneLine(long);
    expect(Array.from(out)).toHaveLength(FIELD_MAX_CODEPOINTS);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
    expect(oneLine("short")).toBe("short");
  });
});

describe("renderPushSummary", () => {
  function fake(id: string, status: "ok" | "failed", base: PushDelivery): PushDelivery {
    return { ...base, row: { ...base.row, incidentId: id, status } };
  }
  test("N and M count ALL rows like the toast; the id list is the coalesced rest", async () => {
    const d = await realDelivery();
    const all = [
      fake("pagerduty:A", "ok", d),
      fake("pagerduty:B", "failed", d),
      fake("pagerduty:C", "ok", d),
      fake("pagerduty:D", "ok", d),
      fake("pagerduty:E", "failed", d),
    ];
    const rest = all.slice(3);
    expect(renderPushSummary(all, rest)).toBe(
      "5 P1 incidents paged (3 briefs ready). Not posted individually: pagerduty:D, pagerduty:E — @nimbus agent oncall incidentId=&lt;id&gt; for any of them",
    );
  });
  test("singular brief", async () => {
    const d = await realDelivery();
    const all = [fake("pagerduty:A", "ok", d), fake("pagerduty:B", "failed", d)];
    expect(renderPushSummary(all, all.slice(1))).toContain("(1 brief ready)");
  });
  // Review Focus 5
  test("all failed: 0 briefs ready, ids still listed", async () => {
    const d = await realDelivery();
    const all = [fake("pagerduty:A", "failed", d), fake("pagerduty:B", "failed", d)];
    const out = renderPushSummary(all, all);
    expect(out).toContain("(0 briefs ready)");
    expect(out).toContain("pagerduty:A, pagerduty:B");
  });
  test(`an incident storm lists ${SUMMARY_ID_CAP} ids, then names the local command`, async () => {
    const d = await realDelivery();
    const rest = Array.from({ length: 47 }, (_, i) => fake(`pagerduty:S${i}`, "ok", d));
    const out = renderPushSummary(rest, rest);
    expect(out).toContain("pagerduty:S9 … and 37 more (locally: nimbus oncall pushed list)");
    expect(out).not.toContain("pagerduty:S10,");
    expect(out).not.toContain("<");
  });
});
