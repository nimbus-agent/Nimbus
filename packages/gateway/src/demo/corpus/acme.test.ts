import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ACME_TOUR, buildAcmeCorpus } from "./acme.ts";

const corpus = buildAcmeCorpus();
const SOURCE = readFileSync(join(import.meta.dir, "acme.ts"), "utf8");
const allItems = [
  ...corpus.issues,
  ...corpus.pullRequests,
  ...corpus.reviews,
  ...corpus.ciRuns,
  ...corpus.incidents,
  ...corpus.messages,
];

describe("acme corpus hygiene", () => {
  test("no absolute timestamp anywhere in the corpus source (only offsets)", () => {
    // A 12+ digit literal would be an epoch-ms constant; Date constructors would anchor to a day.
    expect(SOURCE).not.toMatch(/\b\d{12,}\b/);
    expect(SOURCE).not.toMatch(/new Date\(|Date\.UTC\(|Date\.now\(/);
  });

  test("every email and URL is on a .example domain", () => {
    for (const p of corpus.people) expect(p.email.endsWith(".example")).toBe(true);
    for (const i of allItems) {
      if (i.url !== undefined) expect(new URL(i.url).hostname.endsWith(".example")).toBe(true);
    }
    for (const m of SOURCE.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      expect(m[1]?.endsWith(".example")).toBe(true);
    }
  });

  test("every referenced person exists", () => {
    const keys = new Set(corpus.people.map((p) => p.key));
    expect(keys.has(corpus.meKey)).toBe(true);
    for (const i of allItems)
      if (i.authorKey !== undefined) expect(keys.has(i.authorKey)).toBe(true);
    for (const c of corpus.commits) expect(keys.has(c.authorKey)).toBe(true);
  });

  test("every blame entry names a known commit, one per line", () => {
    const shas = new Set(corpus.commits.map((c) => c.sha));
    for (const f of corpus.files) {
      expect(f.blame).toHaveLength(f.lines.length);
      for (const s of f.blame) expect(shas.has(s)).toBe(true);
      expect(f.lines[0]).toContain("Synthetic demo file");
    }
  });

  test("the tour targets exist: why-line 42 is the capped delay, owners dir has a file", () => {
    const [file, line] = ACME_TOUR.whyRef.split(":");
    const f = corpus.files.find((x) => x.path === file);
    expect(f?.lines[Number(line) - 1]).toContain("MAX_BACKOFF_MS");
    expect(corpus.files.some((x) => x.path.startsWith(`${ACME_TOUR.ownersPath}/`))).toBe(true);
  });

  test("all blame under the owners dir is ONE author (bus factor 1)", () => {
    const authorBySha = new Map(corpus.commits.map((c) => [c.sha, c.authorKey]));
    const authors = new Set(
      corpus.files
        .filter((f) => f.path.startsWith(`${ACME_TOUR.ownersPath}/`))
        .flatMap((f) => f.blame.map((s) => authorBySha.get(s))),
    );
    expect([...authors]).toEqual(["dana"]);
  });

  test("the paging incident is assigned to me and opened after the story deploy", () => {
    const at = (o: number): number => 1_000 + o; // any base — only ordering matters
    const page = corpus.incidents.find((i) => i.externalId === "PDEMO412");
    const meta = page?.metadata?.(at);
    const me = corpus.people.find((p) => p.key === corpus.meKey);
    expect(meta?.["assignee_emails"]).toEqual([me?.email]);
    const deploy = corpus.deployments.find((d) => d.runId === "7412");
    expect((deploy?.offsetMs ?? 0) < (page?.offsetMs ?? 0)).toBe(true);
  });

  test("external ids are unique per service/type", () => {
    const ids = allItems.map((i) => `${i.service}:${i.type}:${i.externalId}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
