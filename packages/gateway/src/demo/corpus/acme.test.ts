import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ACME_TOUR_STEPS, buildAcmeCorpus, PAGE_FOLLOW_UPS, PAGING_INCIDENT } from "./acme.ts";

/** The single arg of the step whose kind is `kind` — the tour's own target for that step. */
function soleArg(kind: (typeof ACME_TOUR_STEPS)[number]["kind"]): string {
  const step = ACME_TOUR_STEPS.find((s) => s.kind === kind);
  if (step === undefined) throw new Error(`no ${kind} step in ACME_TOUR_STEPS`);
  expect(step.args).toHaveLength(1);
  return step.args[0] as string;
}

const corpus = buildAcmeCorpus();
const SOURCE = readFileSync(join(import.meta.dir, "acme.ts"), "utf8");
const allItems = [
  ...corpus.issues,
  ...corpus.pullRequests,
  ...corpus.reviews,
  ...corpus.ciRuns,
  ...corpus.incidents,
  ...corpus.messages,
  // Written by `fireDemoPage`, not the seed — but held to the same hygiene rules.
  PAGING_INCIDENT,
  ...PAGE_FOLLOW_UPS,
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
    const [file, line] = soleArg("why").split(":");
    const f = corpus.files.find((x) => x.path === file);
    expect(f?.lines[Number(line) - 1]).toContain("MAX_BACKOFF_MS");
    expect(corpus.files.some((x) => x.path.startsWith(`${soleArg("owners")}/`))).toBe(true);
  });

  test("the oncall step shows the pushed brief of the page that just fired", () => {
    const step = ACME_TOUR_STEPS.find((s) => s.kind === "oncall");
    expect(step?.args).toEqual(["pushed"]);
    expect(step?.title).toBe("On-call triage");
    expect(PAGING_INCIDENT.title).toContain("payment-service");
  });

  test("the paging incident and its chatter are NOT seeded — `fireDemoPage` writes them", () => {
    expect(corpus.incidents.some((i) => i.externalId === PAGING_INCIDENT.externalId)).toBe(false);
    const followUpIds = new Set(PAGE_FOLLOW_UPS.map((m) => m.externalId));
    expect(corpus.messages.some((m) => followUpIds.has(m.externalId))).toBe(false);
    expect(PAGE_FOLLOW_UPS.map((m) => m.offsetMs)).toEqual([0, 1, 2]);
    expect(PAGE_FOLLOW_UPS[1]?.body).toContain("about eight minutes before the alert");
  });

  test("all blame under the owners dir is ONE author (bus factor 1)", () => {
    const authorBySha = new Map(corpus.commits.map((c) => [c.sha, c.authorKey]));
    const authors = new Set(
      corpus.files
        .filter((f) => f.path.startsWith(`${soleArg("owners")}/`))
        .flatMap((f) => f.blame.map((s) => authorBySha.get(s))),
    );
    expect([...authors]).toEqual(["dana"]);
  });

  test("the paging incident is assigned to me and opened after the story deploy", () => {
    const at = (o: number): number => 1_000 + o; // any base — only ordering matters
    const page = PAGING_INCIDENT;
    const meta = page.metadata?.(at);
    const me = corpus.people.find((p) => p.key === corpus.meKey);
    expect(meta?.["assignee_emails"]).toEqual([me?.email]);
    const deploy = corpus.deployments.find((d) => d.runId === "7412");
    expect((deploy?.offsetMs ?? 0) < page.offsetMs).toBe(true);
  });

  test("external ids are unique per service/type", () => {
    const ids = allItems.map((i) => `${i.service}:${i.type}:${i.externalId}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
