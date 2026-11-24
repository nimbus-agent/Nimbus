import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { renderIncidentUpdateBrief } from "../agents/_lib/incident-update-brief-render.ts";
import { RESERVED_HEADINGS_BY_KIND, reservedBlocksFor } from "../agents/_lib/reserved-sections.ts";
import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { synthesize } from "../agents/_lib/synthesize.ts";
import { seedPostmortemRecord } from "../incident/__fixtures__/postmortem-seed.ts";
import { buildUpdateBriefFixture } from "../incident/__fixtures__/update-brief.ts";
import { draftIncidentUpdate } from "../incident-update/update-draft.ts";
import { draftUpdateWithLead, LEAD_MAX, leadOf } from "./update-lead.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

async function seeded() {
  const s = await seedPostmortemRecord({ resolved: false });
  dbs.push(s.db);
  return s;
}

const runnerSaying = (markdown: string): SynthesisRunner => ({
  run: async () => ({ ok: true, markdown, model: "m1", remote: false }),
});

describe("the incident_update brief and I31", () => {
  test("reserves the update text and the gaps, rebuilt from the brief", () => {
    const brief = buildUpdateBriefFixture();
    expect(RESERVED_HEADINGS_BY_KIND.incident_update).toEqual(["## Update text", "## Gaps"]);
    const blocks = reservedBlocksFor(brief);
    expect(blocks.map((b) => b.heading)).toEqual(["## Update text", "## Gaps"]);
    expect(blocks[0]?.markdown).toContain("Not checked with the provider.");
  });

  test("omitReserved shows the model the facts but not the reserved copy", () => {
    const body = renderIncidentUpdateBrief(buildUpdateBriefFixture(), { omitReserved: true });
    expect(body).toContain("## Lead");
    expect(body).toContain("## Known so far");
    expect(body).not.toContain("## Update text");
    expect(body).not.toContain("## Gaps");
  });

  test("a model that rewrites the reserved block has it replaced by the deterministic one", async () => {
    const brief = buildUpdateBriefFixture();
    const out = await synthesize(brief, {
      runner: runnerSaying(
        "## Lead\n\nShort lead.\n\n## Update text\n\nINVENTED: it is all fine, no footer",
      ),
    });
    expect(out.markdown).toContain("Short lead.");
    expect(out.markdown).not.toContain("INVENTED");
    expect(out.markdown).toContain("Drafted by Nimbus from the local index");
  });
});

describe("leadOf", () => {
  test("takes the lead section as one chat-safe paragraph", () => {
    expect(leadOf("## Lead\n\nFirst line\nsecond line.\n\n## Known so far\n\nx")).toBe(
      "First line second line.",
    );
  });

  test("none, the placeholder and an empty lead are null", () => {
    expect(leadOf("## Known so far\n\nx")).toBeNull();
    expect(leadOf("## Lead\n\n_No lead written._\n")).toBeNull();
    expect(leadOf("## Lead\n\n   \n## Known so far")).toBeNull();
  });

  test("chat control sequences are defused and the lead is capped", () => {
    const lead = leadOf(`## Lead\n\nHello <!here> <@U1> *bold* ${"x".repeat(2_000)}`) ?? "";
    expect(lead).not.toContain("<");
    expect(lead).not.toContain("*");
    expect(lead.length).toBeLessThanOrEqual(LEAD_MAX + 1);
  });
});

describe("draftUpdateWithLead", () => {
  test("with no model it is the deterministic update, byte for byte", async () => {
    const { db, recordId } = await seeded();
    const plain = draftIncidentUpdate(db, recordId, { audience: "stakeholders", nowMs: 9_000_000 });
    const out = await draftUpdateWithLead({
      db,
      recordId,
      audience: "stakeholders",
      nowMs: 9_000_000,
    });
    expect(out.text).toBe(plain.text);
    expect(out.lead).toBeNull();
    expect(out.synthesis).toEqual({ attempted: false, reason: "disabled" });
  });

  test("with a model the text is the lead followed by the deterministic update, verbatim", async () => {
    const { db, recordId } = await seeded();
    const plain = draftIncidentUpdate(db, recordId, { audience: "engineers", nowMs: 9_000_000 });
    const out = await draftUpdateWithLead({
      db,
      recordId,
      audience: "engineers",
      nowMs: 9_000_000,
      runner: runnerSaying(
        "## Lead\n\nWe are looking at the payments path.\n\n## Known so far\n\nz",
      ),
    });
    expect(out.lead).toBe("We are looking at the payments path.");
    expect(out.text).toBe(`We are looking at the payments path.\n\n${plain.text}`);
    expect(out.synthesis.attempted).toBe(true);
  });

  test("a model that invents the facts changes nothing but the lead", async () => {
    const { db, recordId } = await seeded();
    const plain = draftIncidentUpdate(db, recordId, { audience: "stakeholders", nowMs: 9_000_000 });
    const out = await draftUpdateWithLead({
      db,
      recordId,
      audience: "stakeholders",
      nowMs: 9_000_000,
      runner: runnerSaying("## Lead\n\nLead.\n\n## Update text\n\nFAKE FACTS"),
    });
    expect(out.text).toBe(`Lead.\n\n${plain.text}`);
    expect(out.text).not.toContain("FAKE FACTS");
  });

  test("a failing model falls back to the deterministic text", async () => {
    const { db, recordId } = await seeded();
    const plain = draftIncidentUpdate(db, recordId, { audience: "stakeholders", nowMs: 9_000_000 });
    const out = await draftUpdateWithLead({
      db,
      recordId,
      audience: "stakeholders",
      nowMs: 9_000_000,
      runner: { run: async () => ({ ok: false, reason: "provider_error" }) },
    });
    expect(out.text).toBe(plain.text);
    expect(out.lead).toBeNull();
    expect(out.synthesis.attempted).toBe(true);
  });
});
