import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { CaptureStore } from "../mcp-sink/capture-store.ts";
import { contractViolations, requiredPhrases } from "./_lib/brief-contract.ts";
import { AGENT_ACTION_LANES, agentActionExclusions } from "./_lib/negotiate-agent-actions.ts";
import { renderNegotiate } from "./_lib/render.ts";
import { runNegotiate } from "./negotiate.ts";

/**
 * `nimbus negotiate` vs. the I28 act door: an artifact an MCP agent proposed and the owner approved
 * ran on the owner's credentials, so a sync indexes it as the owner's work. Seeded through the real
 * writers — `upsertIndexedItem` (which also derives `resolve_key` and the `opened` graph edge) and
 * `CaptureStore`'s own insert → claim → finalize — so the join is exercised on the shapes
 * production writes, not on hand-written rows.
 */

const DAY = 86_400_000;
let db: Database;
let seq = 0;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  db.run("INSERT INTO person (id, display_name) VALUES ('person:me', 'Me')");
  db.run("INSERT INTO person (id, display_name) VALUES ('person:other', 'Other')");
});
afterEach(() => db.close());

function ctx() {
  return { db, notify: () => {}, sessionId: "negotiate-agent-1", personalSources: [] };
}

function seedMessage(id: string, url: string, authorId = "person:me"): void {
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: id,
    title: `message ${id}`,
    bodyPreview: "",
    url,
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId,
    metadata: {},
  });
}

function seedIssue(n: number, url: string, authorId = "person:me"): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "issue",
    externalId: `acme/app#issue-${String(n)}`,
    title: `Issue ${String(n)}`,
    bodyPreview: "",
    url,
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId,
    metadata: { repo: "acme/app", number: n },
  });
}

/** An EXECUTED action, written the way the act door writes one. */
function seedExecuted(actionType: string, outcomeRef: string | null, decidedAt = Date.now()): void {
  const store = new CaptureStore(db);
  const id = `cap_${String(++seq)}`;
  store.insert({
    id,
    kind: "action",
    state: "proposed",
    itemId: null,
    payloadJson: JSON.stringify({ actionType, input: { text: "agent-written" }, summary: "s" }),
    payloadBytes: 10,
    clientLabel: "claude-code",
    sessionId: "s",
    createdAt: decidedAt - 1,
    expiresAt: decidedAt + DAY,
  });
  expect(store.claimAction(id, decidedAt)).toBe(true);
  expect(
    store.finalizeAction(id, "executed", outcomeRef === null ? {} : { outcomeRef }, decidedAt),
  ).toBe(true);
}

const SLACK_A = "https://acme.slack.com/archives/C1/p1700000000000100";
const SLACK_B = "https://acme.slack.com/archives/C1/p1700000000000200";
const ISSUE_7 = "https://github.com/acme/app/issues/7";
const ISSUE_8 = "https://github.com/acme/app/issues/8";

describe("negotiate — agent-caused artifacts", () => {
  test("a matched agent-created message is excluded from writing, its evidence, and disclosed", async () => {
    seedMessage("C1/1", SLACK_A);
    seedMessage("C1/2", SLACK_B);
    // The tool's URL carries a tracking param and a fragment: canonicalisation must still match.
    seedExecuted("slack.message.post", `${SLACK_A}?utm_source=nimbus#top`);
    const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctx());
    expect(brief.writing?.messages).toBe(1);
    expect(brief.writing?.agentActions).toEqual({ excluded: 1, unmatched: 0 });
    expect(brief.writing?.evidence.total).toBe(1);
    expect(brief.writing?.evidence.refs.map((r) => r.title)).toEqual(["message C1/2"]);
    const md = renderNegotiate(brief);
    expect(md).toContain(
      "- 1 item(s) were created by actions an MCP agent proposed and you approved, and are not counted above",
    );
    expect(md).not.toContain("could not be matched");
  });

  test("a matched agent-created issue is excluded from tickets opened and its evidence", async () => {
    seedIssue(7, ISSUE_7);
    seedIssue(8, ISSUE_8);
    seedExecuted("github.issue.create", ISSUE_8);
    const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctx());
    expect(brief.tickets?.opened).toBe(1);
    expect(brief.tickets?.agentActions).toEqual({ excluded: 1, unmatched: 0 });
    expect(brief.tickets?.evidence.refs.map((r) => r.title)).toEqual(["Issue 7"]);
    // Lanes are independent: the issue never touches writing.
    expect(brief.writing?.agentActions).toEqual({ excluded: 0, unmatched: 0 });
  });

  test("unmatched creates and every edit are disclosed, never excluded", async () => {
    seedMessage("C1/1", SLACK_A);
    seedExecuted("slack.message.post", null); // no URL returned (e.g. Teams)
    seedExecuted("slack.message.post", "https://acme.slack.com/archives/C9/p1"); // not synced
    // An edit whose URL DOES resolve: excluding it could remove the subject's own page.
    upsertIndexedItem(db, {
      service: "confluence",
      type: "page",
      externalId: "page-1",
      title: "My page",
      bodyPreview: "",
      url: "https://acme.atlassian.net/wiki/page-1",
      modifiedAt: Date.now(),
      syncedAt: Date.now(),
      authorId: "person:me",
      metadata: {},
    });
    seedExecuted("confluence.page.update", "https://acme.atlassian.net/wiki/page-1");
    const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctx());
    expect(brief.writing?.messages).toBe(1);
    expect(brief.writing?.docs).toBe(1);
    expect(brief.writing?.agentActions).toEqual({ excluded: 0, unmatched: 3 });
    expect(renderNegotiate(brief)).toContain(
      "- 3 more action(s) an MCP agent proposed and you approved ran in this window but could not be matched to an indexed item, or edited an existing one; they may still be counted above",
    );
  });

  test("exclusion is not windowed; the unmatched disclosure is", async () => {
    seedMessage("C1/1", SLACK_A);
    const old = Date.now() - 200 * DAY;
    seedExecuted("slack.message.post", SLACK_A, old); // created long ago, item touched now
    seedExecuted("slack.message.post", null, old); // unmatched, but outside the window
    const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctx());
    expect(brief.writing?.messages).toBe(0);
    expect(brief.writing?.agentActions).toEqual({ excluded: 1, unmatched: 0 });
  });

  test("a brief about someone else is untouched: the actions ran as the local owner", async () => {
    seedMessage("C1/1", SLACK_A, "person:other");
    seedExecuted("slack.message.post", SLACK_A);
    seedExecuted("slack.message.post", null);
    const brief = await runNegotiate(
      { personId: "person:other", mePersonIdOverride: "person:me" },
      ctx(),
    );
    expect(brief.writing?.messages).toBe(1);
    expect(brief.writing?.agentActions).toEqual({ excluded: 0, unmatched: 0 });
    expect(renderNegotiate(brief)).not.toContain("MCP agent");
  });

  test("action types outside every lane, and non-executed actions, count nothing", async () => {
    seedMessage("C1/1", SLACK_A);
    seedExecuted("gmail.message.send", SLACK_A); // a mail send lands in no negotiate lane
    const store = new CaptureStore(db);
    store.insert({
      id: "cap_failed",
      kind: "action",
      state: "proposed",
      itemId: null,
      payloadJson: JSON.stringify({ actionType: "slack.message.post", input: {}, summary: "s" }),
      payloadBytes: 2,
      clientLabel: null,
      sessionId: "s",
      createdAt: Date.now() - 1,
      expiresAt: Date.now() + DAY,
    });
    store.claimAction("cap_failed", Date.now());
    store.finalizeAction("cap_failed", "failed", { errorCode: "ERR_ACTION_DISPATCH" }, Date.now());
    const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctx());
    expect(brief.writing?.messages).toBe(1);
    expect(brief.writing?.agentActions).toEqual({ excluded: 0, unmatched: 0 });
  });

  test("the rewrite guard requires both agent lines, and only when they are rendered", async () => {
    seedMessage("C1/1", SLACK_A);
    seedExecuted("slack.message.post", SLACK_A);
    seedExecuted("slack.message.post", null);
    const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctx());
    const md = renderNegotiate(brief);
    expect(contractViolations(brief, md)).toEqual([]);
    const anchors = requiredPhrases(brief).flatMap((r) => r.anchors);
    expect(anchors).toContain("created by actions an MCP agent proposed");
    expect(anchors).toContain("may still be counted above");
    // A rewrite that keeps "excluded" but drops the caveat that more may remain is rejected.
    const dropped = md.replace("; they may still be counted above", "");
    expect(contractViolations(brief, dropped).length).toBeGreaterThan(0);
    // With nothing agent-caused, nothing extra is required.
    const clean = new Database(":memory:");
    LocalIndex.ensureSchema(clean);
    clean.run("INSERT INTO person (id, display_name) VALUES ('person:me', 'Me')");
    const plain = await runNegotiate({ mePersonIdOverride: "person:me" }, { ...ctx(), db: clean });
    expect(requiredPhrases(plain).flatMap((r) => r.anchors)).not.toContain(
      "may still be counted above",
    );
    clean.close();
  });

  test("the lane table names only proposable action types", async () => {
    const { PROPOSABLE_WRITE_TOOLS } = await import("../connectors/proposable-actions.ts");
    for (const t of Object.keys(AGENT_ACTION_LANES)) {
      expect(Object.keys(PROPOSABLE_WRITE_TOOLS)).toContain(t);
    }
  });

  test("agentActionExclusions dedupes an item matched by two creates", () => {
    seedMessage("C1/1", SLACK_A);
    seedExecuted("slack.message.post", SLACK_A);
    seedExecuted("slack.message.post", SLACK_A);
    expect(agentActionExclusions(db, 0).writing).toEqual({
      itemIds: ["slack:C1/1"],
      unmatched: 0,
    });
  });
});
