import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { capPerService, stripInternalRankField } from "./context-fairness.ts";

/**
 * F12 — two defects that compound, plus the internal field that made both legible as nonsense.
 *
 * 12a: the repo path queried `type = 'issue'` only, so asking about a repo silently excluded every
 * PR. On the audited index `github`/`issue` held ZERO rows, so that path contributed nothing at
 * all while 16 PRs sat unreachable.
 *
 * 12b: `github_actions` held 11,979 items against `github`'s 214, so one high-volume service
 * consumed the whole context budget and a repo question came back answered entirely from CI runs.
 *
 * 12c: `formatContextItem` attached `rank` — internal relevance ordering — and serialised it into
 * the `<tool_output>` envelope with no schema. The model reported it as data, twice, on unrelated
 * datasets: "PR #414691 is ranked 1st", and for CloudWatch, "the log groups also contain a 'rank'
 * value, which suggests ... a specific ordering or priority within the RequiemNexus
 * infrastructure". That is a reasonable reading of an unexplained field, which is why stripping it
 * is a smaller and more reliable fix than any prompt instruction — it works for every model.
 */

const openDbs: Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function item(service: string, id: string) {
  return { sourceId: id, service, indexedType: "pr", title: `t-${id}` };
}

describe("capPerService (F12b)", () => {
  test("one high-volume service cannot consume the whole budget", () => {
    const items = [
      ...Array.from({ length: 20 }, (_, i) => item("github_actions", `gha-${String(i)}`)),
      item("github", "pr-1"),
      item("github", "pr-2"),
    ];
    const capped = capPerService(items, 8);
    expect(capped.some((i) => i.service === "github")).toBe(true);
  });

  test("relative order within a service is preserved", () => {
    // The input is already relevance-ordered; a cap that reshuffled it would discard the ranking
    // the search just computed.
    const items = [item("github", "a"), item("github", "b"), item("github", "c")];
    expect(capPerService(items, 8).map((i) => i.sourceId)).toEqual(["a", "b", "c"]);
  });

  test("a single-service result set is untouched", () => {
    // The cap must not punish the ordinary case: if only one service matched, all of its items
    // are the whole answer and capping them would drop real results for no gain.
    const items = Array.from({ length: 6 }, (_, i) => item("github", `p-${String(i)}`));
    expect(capPerService(items, 8)).toHaveLength(6);
  });

  test("it never returns more than the budget", () => {
    const items = [
      ...Array.from({ length: 30 }, (_, i) => item("a", `a-${String(i)}`)),
      ...Array.from({ length: 30 }, (_, i) => item("b", `b-${String(i)}`)),
    ];
    expect(capPerService(items, 8).length).toBeLessThanOrEqual(8);
  });
});

describe("stripInternalRankField (F12c)", () => {
  test("rank is removed before the model sees it", () => {
    const stripped = stripInternalRankField([{ ...item("github", "a"), rank: 1 }]);
    expect(Object.hasOwn(stripped[0] ?? {}, "rank")).toBe(false);
  });

  test("every other field survives", () => {
    // The fix must be a deletion, not a rewrite: dropping `url` or `preview` would cost the model
    // the context the envelope exists to carry.
    const stripped = stripInternalRankField([
      { ...item("github", "a"), rank: 1, url: "https://x", preview: "p" },
    ]);
    expect(stripped[0]).toMatchObject({ sourceId: "a", url: "https://x", preview: "p" });
  });
});

describe("the repo path covers PRs, not issues alone (F12a)", () => {
  test("a repo question reaches a PR", () => {
    const db = new Database(":memory:");
    openDbs.push(db);
    LocalIndex.ensureSchema(db);
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, modified_at, synced_at)
       VALUES ('github:acme/app#pr-1', 'github', 'pr', 'acme/app#pr-1', 'Fix the thing', '', 'https://github.com/acme/app/pull/1', 1, 1)`,
    );
    const rows = db
      .query(
        `SELECT id FROM item
          WHERE service = 'github' AND type IN ('issue','pr')
            AND (lower(external_id) LIKE ? OR lower(url) LIKE ?)`,
      )
      .all("acme/app#%", "%github.com/acme/app/%") as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toContain("github:acme/app#pr-1");
  });
});
