import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_INCIDENT_CONFIG } from "../../../src/config/incident-toml.ts";
import { makeEgressSink } from "../../../src/egress/egress-ledger.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../../../src/engine/executor.ts";
import type {
  ConfirmedApprovalRequest,
  ConsentChannel,
  PlannedAction,
} from "../../../src/engine/types.ts";
import {
  configMap,
  resolverFor,
  serviceConfig,
  T0,
} from "../../../src/incident/__fixtures__/index-writers.ts";
import { writePagerdutyIncident } from "../../../src/incident/__fixtures__/trigger-writers.ts";
import { createIncidentEngine } from "../../../src/incident/incident-engine.ts";
import { mintIncidentLink } from "../../../src/incident/incident-link-mint.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { dispatchAuditRpc } from "../../../src/ipc/audit-rpc.ts";
import { canonicalJson } from "../../../src/util/canonical-json.ts";

/**
 * IC4 acceptance, `nimbus audit replay` (spec § 5.4 and § 7): an incident-linked write goes through a REAL executor
 * and a fake connector (one approved, one denied, one Wave 4 write whose typed-confirm line is part of the prompt the
 * owner was shown), then `audit.replay` (the real RPC over a real index) rebuilds the record, the actions, the
 * prompt and its hash, the paired egress rows and the verified range; two runs are byte-identical and a row
 * corrupted inside the range reports the break.
 */
const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const MERGE_TEXT = "github/merge acme/api#42";
const MERGE: PlannedAction = {
  type: "github.pr.merge",
  payload: { mcpToolId: "github_pr_merge", input: { owner: "acme", repo: "api", pullNumber: 42 } },
};

async function world() {
  const raw = new Database(":memory:");
  dbs.push(raw);
  LocalIndex.ensureSchema(raw);
  const idx = new LocalIndex(raw);
  const cfg = serviceConfig();
  const item = writePagerdutyIncident(
    raw,
    { id: "RP1", openedAtMs: T0, priority: "P1" },
    resolverFor(cfg),
  );
  const engine = createIncidentEngine({
    db: raw,
    now: () => T0 + 60_000,
    emit: () => {},
    loadServiceConfigs: () => configMap(cfg),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
    yieldToEventLoop: async () => {},
  });
  await engine.assembleNow(item);
  const recordId = (raw.query("SELECT id FROM incident_record").get() as { id: string }).id;

  const shown: string[] = [];
  const answers = { approve: true };
  const consent: ConsentChannel = {
    requestApproval: async (prompt) => {
      shown.push(prompt);
      return { approved: answers.approve, answerSource: "human" as const };
    },
    requestConfirmedApproval: async (req: ConfirmedApprovalRequest) => {
      shown.push(req.prompt);
      return { approved: true, typed: MERGE_TEXT, answerSource: "human" as const };
    },
  };
  const dispatched: PlannedAction[] = [];
  const exec = new ToolExecutor(
    consent,
    idx,
    {
      dispatch: async (a) => {
        dispatched.push(a);
        return { ok: true };
      },
    },
    undefined,
    makeEgressSink(raw),
    NO_POLICY_OVERLAY,
  );
  const link = mintIncidentLink(raw, recordId);
  return { raw, idx, exec, link, recordId, shown, answers, dispatched };
}

const replay = (w: Awaited<ReturnType<typeof world>>): Promise<Record<string, unknown>> =>
  dispatchAuditRpc("audit.replay", { id: w.recordId }, { index: w.idx, callerKind: "cli" }).then(
    (o) => {
      if (o.kind !== "hit") throw new Error("miss");
      return o.value as Record<string, unknown>;
    },
  );

describe("audit replay acceptance (IC4)", () => {
  test("approved, denied and Wave 4 linked actions replay with their prompts, hashes, paired egress rows and a verified range", async () => {
    const w = await world();
    // an unrelated action first and between, so the range has rows that are not the incident's
    await w.exec.execute({ type: "search.run", payload: {} });
    await w.exec.execute({ type: "email.send", payload: { to: "a@b.c" }, incident: w.link });
    await w.exec.execute({ type: "search.run", payload: {} });
    w.answers.approve = false;
    await w.exec.execute({ type: "slack.message.post", payload: { text: "hi" }, incident: w.link });
    w.answers.approve = true;
    await w.exec.execute({ ...MERGE, incident: w.link });

    const r = (await replay(w)) as {
      ok: boolean;
      actions: {
        actionType: string;
        hitlStatus: string;
        confirm: string | null;
        answerSource: string | null;
        prompt: { text: string; sha256: string } | null;
        egress: { resultStatus: string } | null;
      }[];
      verification: { audit: { ok: boolean; rowsRead: number }; egress: { ok: boolean } };
      record: { versions: unknown[] };
    };
    expect(r.ok).toBe(true);
    expect(r.record.versions).toHaveLength(1);
    expect(r.actions.map((a) => [a.actionType, a.hitlStatus])).toEqual([
      ["email.send", "approved"],
      ["slack.message.post", "rejected"],
      ["github.pr.merge", "approved"],
    ]);
    // the prompt the owner was shown is in the row, and the Wave 4 one carries the typed-confirm line
    const sha = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");
    expect(r.actions[0]?.prompt?.sha256).toBe(sha(w.shown[0] ?? ""));
    expect(r.actions[1]?.egress?.resultStatus).toBe("blocked");
    const merge = r.actions[2];
    expect(merge?.confirm).toBe("matched");
    expect(merge?.prompt?.text).toContain(MERGE_TEXT);
    expect(merge?.prompt?.sha256).toBe(sha(w.shown[2] ?? ""));
    expect(w.shown[2]).toContain(MERGE_TEXT);
    expect(r.verification.audit).toMatchObject({ ok: true, rowsRead: 3 });
    expect(r.verification.egress.ok).toBe(true);
    // the denied write was never dispatched
    expect(w.dispatched.map((d) => d.type)).toEqual([
      "search.run",
      "email.send",
      "search.run",
      "github.pr.merge",
    ]);
  });

  test("two runs on one database are byte-identical", async () => {
    const w = await world();
    await w.exec.execute({ type: "email.send", payload: {}, incident: w.link });
    await w.exec.execute({ ...MERGE, incident: w.link });
    expect(canonicalJson(await replay(w))).toBe(canonicalJson(await replay(w)));
  });

  test("a row corrupted inside the range reports the break; the rest is still returned", async () => {
    const w = await world();
    await w.exec.execute({ type: "email.send", payload: {}, incident: w.link });
    await w.exec.execute({ type: "search.run", payload: {} });
    await w.exec.execute({ type: "email.send", payload: { n: 2 }, incident: w.link });
    const ids = (w.raw.query("SELECT id FROM audit_log ORDER BY id").all() as { id: number }[]).map(
      (x) => x.id,
    );
    w.raw.run("UPDATE audit_log SET hitl_status = 'rejected' WHERE id = ?", [ids[1] ?? 0]);
    const r = (await replay(w)) as {
      ok: boolean;
      actions: unknown[];
      verification: { audit: { ok: boolean; firstBreak: number } };
    };
    expect(r.ok).toBe(false);
    expect(r.verification.audit.ok).toBe(false);
    expect(r.verification.audit.firstBreak).toBe(ids[1] ?? -1);
    expect(r.actions).toHaveLength(2);
  });
});
