import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  parsePostmortemTemplate,
  renderIncidentPostmortem,
} from "../agents/_lib/incident-postmortem-render.ts";
import type { SynthesisAttempt, SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { seedPostmortemRecord } from "../incident/__fixtures__/postmortem-seed.ts";
import { buildPostmortemBrief, PostmortemError } from "../incident/postmortem-brief.ts";
import { draftPostmortem } from "./postmortem-draft.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const NOW = 5_000_000;

async function seeded(resolved = true) {
  const s = await seedPostmortemRecord({ resolved });
  dbs.push(s.db);
  return s;
}

function runner(
  attempt: (prompt: string) => Promise<SynthesisAttempt>,
  seen: string[] = [],
): SynthesisRunner {
  return {
    run: async (prompt) => {
      seen.push(prompt);
      return attempt(prompt);
    },
  };
}

const ok = (markdown: string): SynthesisAttempt => ({
  ok: true,
  markdown,
  model: "test-model",
  remote: false,
});

describe("draftPostmortem without a model", () => {
  test("is the deterministic render, ends with one newline and calls no model", async () => {
    const { db, recordId } = await seeded();
    const d = await draftPostmortem({ db, nowMs: NOW, recordId, template: null });
    const brief = buildPostmortemBrief(db, recordId, NOW, null);
    expect(d.markdown).toBe(`${renderIncidentPostmortem(brief)}\n`);
    expect(d.synthesis).toBeNull();
    expect(d.version).toBe(1);
    // no footer about a model on a page the owner may publish
    expect(d.markdown).not.toContain("Rendered deterministically");
  });

  test("drafting appends no egress row and makes no request", async () => {
    const { db, recordId } = await seeded();
    const before = (db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n;
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.reject(new Error("no network in a draft"));
    }) as unknown as typeof fetch;
    try {
      await draftPostmortem({ db, nowMs: NOW, recordId, template: null });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n).toBe(
      before,
    );
  });

  test("an open record is refused and a template reaches the render", async () => {
    const open = await seeded(false);
    await expect(
      draftPostmortem({ db: open.db, nowMs: NOW, recordId: open.recordId, template: null }),
    ).rejects.toBeInstanceOf(PostmortemError);
    const { db, recordId } = await seeded();
    const d = await draftPostmortem({
      db,
      nowMs: NOW,
      recordId,
      template: parsePostmortemTemplate("{{summary}}"),
    });
    expect(d.markdown).toContain("## Summary");
    expect(d.markdown).not.toContain("## Candidate causes");
    expect(d.markdown).not.toContain("## Timeline");
    expect(d.markdown).toContain("## Gaps");
  });
});

describe("draftPostmortem with a model (I31)", () => {
  test("uses the rewrite, withholds the reserved sections from the model and re-attaches them verbatim", async () => {
    const { db, recordId } = await seeded();
    const seen: string[] = [];
    const d = await draftPostmortem({
      db,
      nowMs: NOW,
      recordId,
      template: null,
      runner: runner(async () => ok("## Summary\n\nREWRITTEN-PROSE"), seen),
    });
    const brief = buildPostmortemBrief(db, recordId, NOW, null);
    expect(d.markdown).toContain("REWRITTEN-PROSE");
    expect(d.markdown).toContain("_Synthesized by test-model (local)._");
    expect(d.synthesis).toMatchObject({ attempted: true, used: true, model: "test-model" });
    // the four reserved blocks, from the deterministic render, in place
    const full = renderIncidentPostmortem(brief);
    for (const h of ["## Timeline", "## Decision log", "## Gaps", "## Data freshness"]) {
      const start = full.indexOf(`${h}\n`);
      const block = full.slice(
        start,
        full.indexOf("\n\n## ", start + 1) === -1 ? undefined : full.indexOf("\n\n## ", start + 1),
      );
      expect(d.markdown).toContain(block.trim());
    }
    // the prompt carried the brief inside the I11 envelope and none of the reserved headings
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("<tool_output");
    expect(seen[0]).toContain("agents.incident_postmortem");
    for (const h of ["## Timeline", "## Decision log", "## Gaps", "## Data freshness"]) {
      expect(seen[0]).not.toContain(`\n${h}\n`);
    }
    expect(seen[0]).toContain("Do not write a `Timeline`");
  });

  test("a rewrite that invents its own reserved sections has them stripped", async () => {
    const { db, recordId } = await seeded();
    const d = await draftPostmortem({
      db,
      nowMs: NOW,
      recordId,
      template: null,
      runner: runner(async () =>
        ok("## Summary\n\nbody\n\n## Timeline\n\nFORGED-TIMELINE\n\n## Gaps\n\nFORGED-GAP"),
      ),
    });
    expect(d.markdown).not.toContain("FORGED-TIMELINE");
    expect(d.markdown).not.toContain("FORGED-GAP");
    expect(d.markdown).toContain("## Timeline");
  });

  test("a rewrite that is only a forged reserved section falls back to the deterministic draft", async () => {
    const { db, recordId } = await seeded();
    const d = await draftPostmortem({
      db,
      nowMs: NOW,
      recordId,
      template: null,
      runner: runner(async () => ok("## Gaps\n\nonly a forgery")),
    });
    expect(d.synthesis).toMatchObject({ attempted: true, used: false, reason: "empty_result" });
    expect(d.markdown).toContain("## Candidate causes");
    expect(d.markdown).toContain("synthesis was attempted and discarded");
  });

  test("a provider that fails, times out or throws gives the deterministic draft and says why", async () => {
    const { db, recordId } = await seeded();
    const failed = await draftPostmortem({
      db,
      nowMs: NOW,
      recordId,
      template: null,
      runner: runner(async () => ({ ok: false, reason: "timeout" })),
    });
    expect(failed.synthesis).toMatchObject({ attempted: true, used: false, reason: "timeout" });
    expect(failed.markdown).toContain("## Summary");
    const thrown = await draftPostmortem({
      db,
      nowMs: NOW,
      recordId,
      template: null,
      runner: runner(async () => {
        throw new Error("secret-token-abc");
      }),
    });
    expect(thrown.synthesis).toMatchObject({
      attempted: true,
      used: false,
      reason: "provider_error",
    });
    const none = await draftPostmortem({
      db,
      nowMs: NOW,
      recordId,
      template: null,
      runner: runner(async () => ({ ok: false, reason: "no_eligible_provider" })),
    });
    expect(none.synthesis).toEqual({ attempted: false, reason: "no_eligible_provider" });
  });

  test("a template that omits the timeline gets no timeline back from the rewrite", async () => {
    const { db, recordId } = await seeded();
    const d = await draftPostmortem({
      db,
      nowMs: NOW,
      recordId,
      template: parsePostmortemTemplate("{{summary}}\n"),
      runner: runner(async () => ok("## Summary\n\nfine")),
    });
    expect(d.markdown).not.toContain("## Timeline");
    expect(d.markdown).not.toContain("## Decision log");
    expect(d.markdown).toContain("## Data freshness");
  });
});
