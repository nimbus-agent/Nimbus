import { describe, expect, test } from "bun:test";

import type { OwnershipBrief } from "./ownership-types.ts";
import { renderOwnership } from "./render.ts";
import { synthesize } from "./synthesize.ts";

const BRIEF: OwnershipBrief = {
  kind: "ownership",
  agentVersion: 1,
  generatedAt: 1_800_000_000_000,
  latencyMs: 4,
  gaps: [],
  query: { path: "src/a.ts", service: null },
  target: {
    kind: "source_file",
    displayPath: "src/a.ts",
    owners: [{ externalId: "p1", label: "Ann", share: 0.75, resolved: true }],
    ownerCount: 3,
    ownersAboveFloor: 1,
    truncated: false,
  },
  parentDirectory: null,
  service: null,
  coverage: {
    lastPassAt: 1_800_000_000_000,
    lastDurationMs: 12,
    rootsTotal: 1,
    rootsCovered: 1,
    rootsWithRemote: 1,
    filesCovered: 1,
    filesExcluded: 0,
    servicesBound: 1,
    ownersEmitted: 1,
    entitiesReaped: 0,
  },
};

describe("ownership brief synthesis", () => {
  test("renders through renderOwnership, never renderHuddle", async () => {
    const out = await synthesize(BRIEF);
    expect(out).toContain("Ownership");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("Ann");
    // The fall-through trap: an unhandled kind silently renders as a huddle.
    expect(out).not.toContain("Huddle");
  });

  test("renderOwnership states the floor separately from the cap", () => {
    const md = renderOwnership(BRIEF);
    expect(md).toContain("1 of 3");
    expect(md).not.toContain("showing top");
  });

  test("an unrecorded breakdown is stated, not guessed", () => {
    const md = renderOwnership({
      ...BRIEF,
      target: {
        ...(BRIEF.target ?? {}),
        ownerCount: null,
        ownersAboveFloor: null,
        truncated: null,
      },
    } as OwnershipBrief);
    expect(md).toContain("not recorded");
  });

  test("recorded contributors below the share floor are not confused with no data", () => {
    // 25 contributors, none clearing a 5% min_share: `emitted` is empty but the
    // counts are real. The reader must see "nobody cleared the floor", never the
    // same text a path with genuinely zero recorded data would show.
    const md = renderOwnership({
      ...BRIEF,
      target: {
        ...(BRIEF.target ?? { kind: "source_file" as const, displayPath: "src/a.ts" }),
        owners: [],
        ownerCount: 25,
        ownersAboveFloor: 0,
        truncated: false,
      },
    } as OwnershipBrief);
    expect(md).toContain("No owners cleared the share floor");
    expect(md).toContain("0 of 25");
    expect(md).not.toContain("No owners recorded");
  });

  test("a legacy row (ownerCount recorded, ownersAboveFloor never split out) reports unrecorded, not a floor result", () => {
    // A row written before the ownerCount/ownersAboveFloor split parses to
    // ownerCount: 23, ownersAboveFloor: null — see ownership-store.ts `parseCounts`,
    // which gates on `ownersAboveFloor` presence, not on `ownerCount`. The renderer
    // must follow the same rule or it asserts a floor result the row never recorded.
    const md = renderOwnership({
      ...BRIEF,
      target: {
        ...(BRIEF.target ?? { kind: "source_file" as const, displayPath: "src/a.ts" }),
        owners: [],
        ownerCount: 23,
        ownersAboveFloor: null,
        truncated: null,
      },
    } as OwnershipBrief);
    expect(md).toContain("not recorded");
    expect(md).not.toContain("cleared the share floor");
  });
});
