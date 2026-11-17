import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import {
  eventKindOf,
  groupSteps,
  LINK_SCAN_CAP,
  linkPrefixFor,
  parseLinkPrefix,
  readLinkedActions,
} from "./action-links.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const ID = "inc_0123456789abcdef";
const OTHER = "inc_fedcba9876543210";
const SHA = "a".repeat(64);
const head = (id = ID, version = 2): string =>
  `{"incident":{"id":"${id}","version":${String(version)}}`;
const row = (id = ID, extra = ""): string =>
  `${head(id)}${extra},"action":{"type":"email.send","payload":{}},"answerSource":"human"}`;
const promptRow = (text: string, cut = false): string =>
  `${head()},"promptSha256":"${SHA}","prompt":${JSON.stringify(text)}${cut ? ',"promptCut":true' : ""},"action":{"type":"email.send"},"answerSource":"human","confirm":"matched"}`;

function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

let at = 1000;
function insert(d: Database, json: string, type = "email.send", status = "approved"): number {
  at += 1;
  d.run(
    "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash) VALUES (?, ?, ?, ?, ?, ?)",
    [type, status, json, at, `h${String(at)}`, `p${String(at)}`],
  );
  return (d.query("SELECT max(id) AS m FROM audit_log").get() as { m: number }).m;
}

describe("5.1 the anchored, truncation-safe parser", () => {
  test("a valid link, with and without the prompt keys", () => {
    expect(parseLinkPrefix(row())).toEqual({
      id: ID,
      version: 2,
      step: undefined,
      subStep: false,
      prompt: undefined,
    });
    const p = parseLinkPrefix(promptRow('line one\n"quoted" é'));
    expect(p?.prompt).toEqual({ sha256: SHA, text: 'line one\n"quoted" é', cut: false });
    expect(parseLinkPrefix(promptRow("x", true))?.prompt?.cut).toBe(true);
  });

  test("a row cut mid-prompt by the row cap still yields the link and a cut prompt", () => {
    const full = promptRow("y".repeat(200));
    const cut = `${full.slice(0, 160)}…[truncated]`;
    const p = parseLinkPrefix(cut);
    expect(p?.id).toBe(ID);
    expect(p?.prompt?.cut).toBe(true);
    expect(p?.prompt?.sha256).toBe(SHA);
  });

  test("rows that must NOT match", () => {
    // the same text later in the row (an input spelling a link), another shape, a malformed or loose id
    expect(
      parseLinkPrefix(`{"action":{"type":"x","payload":${JSON.stringify(head())}}}`),
    ).toBeUndefined();
    expect(parseLinkPrefix(` ${row()}`)).toBeUndefined();
    expect(parseLinkPrefix(row("inc_0123456789abcdeg"))).toBeUndefined();
    expect(parseLinkPrefix(row("inc_0123456789ABCDEF"))).toBeUndefined();
    expect(parseLinkPrefix(row("inc_0123456789abcde"))).toBeUndefined();
    expect(parseLinkPrefix(row("xnc_0123456789abcdef"))).toBeUndefined();
    expect(parseLinkPrefix(`${head(ID, 0)},"action":{}}`)).toBeUndefined();
    expect(parseLinkPrefix(`${head(ID, 1000001)},"action":{}}`)).toBeUndefined();
    expect(parseLinkPrefix("")).toBeUndefined();
  });
});

describe("5.2 the scan: an exact bound prefix, never LIKE", () => {
  test("returns this record's rows in id order and nothing else", () => {
    const d = db();
    const a = insert(d, row());
    insert(d, row(OTHER));
    const b = insert(d, promptRow("hello"));
    insert(d, `{"action":{"type":"x","payload":{"a":${JSON.stringify(head())}}}}`);
    const r = readLinkedActions(d, ID);
    expect(r.rows.map((x) => x.auditId)).toEqual([a, b]);
    expect(r.truncated).toBe(false);
    expect(r.rows[1]?.prompt?.text).toBe("hello");
    expect(r.rows[1]?.confirm).toBe("matched");
    expect(r.rows[0]?.answerSource).toBe("human");
  });

  test("an id that differs only by '_' position or letter case does not match (LIKE would)", () => {
    const d = db();
    insert(d, row("inc_0123456789abcdef"));
    insert(d, row("incX0123456789abcdef"));
    insert(d, row("INC_0123456789abcdef"));
    expect(readLinkedActions(d, "inc_0123456789abcdef").rows).toHaveLength(1);
    expect(readLinkedActions(d, "inc_0123456789ABCDEF").rows).toEqual([]);
    expect(readLinkedActions(d, "inc_01234567_9abcdef").rows).toEqual([]);
    expect(readLinkedActions(d, "inc_%").rows).toEqual([]);
    expect(linkPrefixFor("not an id")).toBeUndefined();
    expect(linkPrefixFor(ID)?.length).toBe(40);
  });

  test("a 5,001st row sets truncated and the rows are the first by id", () => {
    const d = db();
    d.exec("BEGIN");
    const stmt = d.prepare(
      "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash) VALUES ('t','approved',?,1,'h','p')",
    );
    for (let i = 0; i < LINK_SCAN_CAP + 1; i += 1) stmt.run(row());
    d.exec("COMMIT");
    const r = readLinkedActions(d, ID);
    expect(r.rows).toHaveLength(LINK_SCAN_CAP);
    expect(r.truncated).toBe(true);
  });
});

describe("5.3 event mapping and steps", () => {
  test("approved, not_required, rejected and undo rows map to the action kinds", () => {
    expect(eventKindOf({ actionType: "x.y", hitlStatus: "approved" })).toBe("action_approved");
    expect(eventKindOf({ actionType: "x.y", hitlStatus: "not_required" })).toBe("action_approved");
    expect(eventKindOf({ actionType: "x.y", hitlStatus: "rejected" })).toBe("action_denied");
    expect(eventKindOf({ actionType: "x.undo", hitlStatus: "approved" })).toBe("action_undone");
  });

  test("marked sub-step rows attach to the gate row that follows them; an unmarked discard is a step of its own", () => {
    const d = db();
    const sub = (type: string): number =>
      insert(d, row(ID, ',"subStep":true'), type, "not_required");
    sub("jira.before.read");
    sub("iac.write.prepare");
    insert(d, row(), "iac.terraform.apply");
    insert(d, row(), "iac.cloudformation.changeset.discard", "not_required");
    insert(d, row(), "email.send");
    const steps = groupSteps(readLinkedActions(d, ID).rows);
    expect(steps.map((s) => s.gate.actionType)).toEqual([
      "iac.terraform.apply",
      "iac.cloudformation.changeset.discard",
      "email.send",
    ]);
    expect(steps[0]?.subSteps.map((s) => s.actionType)).toEqual([
      "jira.before.read",
      "iac.write.prepare",
    ]);
    expect(steps[1]?.subSteps).toEqual([]);
    expect(steps[2]?.subSteps).toEqual([]);
  });

  test("the sub-step marker parses with and without a prompt, and only as the key right after the link", () => {
    expect(parseLinkPrefix(row(ID, ',"subStep":true'))?.subStep).toBe(true);
    expect(parseLinkPrefix(row())?.subStep).toBe(false);
    expect(
      parseLinkPrefix(`${head()},"subStep":true,"promptSha256":"${SHA}","prompt":"x","action":{}}`),
    ).toMatchObject({
      subStep: true,
      prompt: { text: "x" },
    });
    // a marker spelled later in the row (inside the action) is no marker
    expect(parseLinkPrefix(`${head()},"action":{"subStep":true}}`)?.subStep).toBe(false);
  });

  test("the step identity parses right after the link, with and without a sub-step marker and a prompt, and cut", () => {
    const S1 = "0123456789abcdef";
    const stepRow = (extra: string): string => `${head()},"step":"${S1}"${extra},"action":{}}`;
    expect(parseLinkPrefix(stepRow(""))).toMatchObject({ step: S1, subStep: false });
    expect(parseLinkPrefix(stepRow(',"subStep":true'))).toMatchObject({ step: S1, subStep: true });
    const withPrompt = `${head()},"step":"${S1}","promptSha256":"${SHA}","prompt":"hi","action":{}}`;
    expect(parseLinkPrefix(withPrompt)).toMatchObject({ step: S1, prompt: { text: "hi" } });
    const open = `${head()},"step":"${S1}","subStep":true,"promptSha256":"${SHA}","prompt":"abc…[truncated]`;
    expect(parseLinkPrefix(open)).toMatchObject({
      step: S1,
      subStep: true,
      prompt: { sha256: SHA, cut: true },
    });
    // a malformed step is no step: the row then has no well-formed prefix at all
    expect(parseLinkPrefix(`${head()},"step":"XYZ","action":{}}`)?.step).toBeUndefined();
  });

  test("reads attach to the action that owns them by step, not to the next gate row (two actions in flight)", () => {
    const d = db();
    const A = "aaaaaaaaaaaaaaaa";
    const B = "bbbbbbbbbbbbbbbb";
    const r = (step: string, sub: boolean): string =>
      `${head()},"step":"${step}"${sub ? ',"subStep":true' : ""},"action":{}}`;
    // order of writing: A read, B read, B gate, A gate
    insert(d, r(A, true), "jira.before.read", "not_required");
    insert(d, r(B, true), "github.before.read", "not_required");
    insert(d, r(B, false), "github.issue.update");
    insert(d, r(A, false), "jira.issue.update");
    const steps = groupSteps(readLinkedActions(d, ID).rows);
    expect(steps.map((s) => s.gate.actionType)).toEqual([
      "github.issue.update",
      "jira.issue.update",
    ]);
    expect(steps[0]?.subSteps.map((s) => s.actionType)).toEqual(["github.before.read"]);
    expect(steps[1]?.subSteps.map((s) => s.actionType)).toEqual(["jira.before.read"]);
  });

  test("a read whose gate row never arrives is returned alone, a keyed one and an unkeyed one alike", () => {
    const d = db();
    insert(
      d,
      `${head()},"step":"cccccccccccccccc","subStep":true,"action":{}}`,
      "x.before.read",
      "not_required",
    );
    insert(d, row(ID, ',"subStep":true'), "y.before.read", "not_required");
    const steps = groupSteps(readLinkedActions(d, ID).rows);
    expect(steps.map((s) => s.gate.actionType)).toEqual(["x.before.read", "y.before.read"]);
    expect(steps.every((s) => s.gate.role === "sub_step" && s.subSteps.length === 0)).toBe(true);
  });

  test("a row cut by the row cap has no answer source (it is not JSON)", () => {
    const d = db();
    insert(d, `${promptRow("z").slice(0, 200)}…[truncated]`);
    const r = readLinkedActions(d, ID).rows[0];
    expect(r?.rowTruncated).toBe(true);
    expect(r?.answerSource).toBeUndefined();
  });

  test("sub-step rows with no gate row on either side are returned alone", () => {
    const d = db();
    insert(d, row(ID, ',"subStep":true'), "jira.before.read", "not_required");
    const steps = groupSteps(readLinkedActions(d, ID).rows);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.gate.actionType).toBe("jira.before.read");
  });
});

describe("5.4 a forged payload is not matched (the offset-0 anchor)", () => {
  test("an agent door row whose INPUT carries a nested incident object, spelled with unescaped quotes, is not a linked row", () => {
    const d = db();
    // a nested object key reaches the stored row with plain quotes: the exact prefix text, but not at offset 0
    const forged = JSON.stringify({
      action: {
        type: "slack.message.post",
        origin: "agent",
        payload: { input: { incident: { id: ID, version: 1 }, text: "x" } },
      },
    });
    expect(forged).toContain(head(ID, 1));
    insert(d, forged);
    expect(readLinkedActions(d, ID).rows).toEqual([]);
    // the parser agrees
    expect(parseLinkPrefix(forged)).toBeUndefined();
    // and the genuine row beside it is found
    const real = insert(d, row());
    expect(readLinkedActions(d, ID).rows.map((r) => r.auditId)).toEqual([real]);
  });
});

describe("5.5 budget", () => {
  test("a 20,000-row audit table scans well inside the CI budget", () => {
    const d = db();
    d.exec("BEGIN");
    const stmt = d.prepare(
      "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash) VALUES ('t','approved',?,1,'h','p')",
    );
    for (let i = 0; i < 20_000; i += 1) {
      stmt.run(i % 100 === 0 ? row() : `{"action":{"type":"t","payload":{"n":${String(i)}}}}`);
    }
    d.exec("COMMIT");
    const t0 = performance.now();
    const r = readLinkedActions(d, ID);
    const ms = performance.now() - t0;
    expect(r.rows).toHaveLength(200);
    // Measured on the dev machine: a few milliseconds. CI runners are 13 to 18 times slower; 3 s is generous.
    expect(ms).toBeLessThan(3000);
  });
});
