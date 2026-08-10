import { expect, test } from "bun:test";

import type { CohortCandidate } from "../../premortem/cohort.ts";
import type { Risk, RiskKind } from "../../premortem/risks.ts";
import type { PremortemTheme } from "../../premortem/theme-store.ts";
import type { WatcherProposal } from "../../premortem/watcher-proposals.ts";
import type { PremortemBrief } from "./premortem-types.ts";
import { renderPremortem } from "./render.ts";

function member(over: Partial<CohortCandidate> = {}): CohortCandidate {
  return {
    itemId: "jira:HIST-1",
    key: "HIST-1",
    title: "A past epic",
    services: ["acme/billing-api"],
    createdAtMs: 1_680_000_000_000,
    resolvedAtMs: 1_690_000_000_000,
    statusCategory: "done",
    childCount: 4,
    score: 1,
    ...over,
  };
}

function risk(kind: RiskKind, over: Partial<Risk> = {}): Risk {
  return {
    kind,
    summary: `${kind} summary sentence`,
    value: 1,
    expectationOnly: false,
    ...over,
  };
}

function theme(over: Partial<PremortemTheme> = {}): PremortemTheme {
  return {
    id: "theme-1",
    service: "acme/billing-api",
    label: "rate limit exhaustion",
    status: "extracted",
    confidence: 0.72,
    evidenceCount: 3,
    lastSeenAt: 1_690_000_000_000,
    ...over,
  };
}

function watcher(over: Partial<WatcherProposal> = {}): WatcherProposal {
  return {
    watcherId: "w-abc123",
    service: "acme/billing-api",
    riskKind: "incident_coupling",
    state: "created",
    ...over,
  };
}

function brief(over: Partial<PremortemBrief> = {}): PremortemBrief {
  return {
    kind: "premortem",
    agentVersion: 1,
    generatedAt: 1_700_000_000_000,
    latencyMs: 42,
    gaps: [],
    query: { epicRef: "PROJ-120", serviceOverrides: null },
    epic: { itemId: "jira:PROJ-120", key: "PROJ-120", title: "Rebuild the billing pipeline" },
    services: ["acme/billing-api"],
    cohort: { members: [member()], scannedCount: 12, oldestResolvedAtMs: 1_650_000_000_000 },
    risks: [
      risk("cycle_time"),
      risk("size_overrun"),
      risk("review_drag"),
      risk("incident_coupling"),
      risk("abandonment"),
    ],
    themes: [theme()],
    watchers: [watcher()],
    ...over,
  };
}

test("renders the epic key, title and requested ref in the header", () => {
  const md = renderPremortem(brief());
  expect(md).toContain("# Pre-mortem: PROJ-120");
  expect(md).toContain("PROJ-120 — Rebuild the billing pipeline");
});

test("renders the derived services and comparable epic count", () => {
  const md = renderPremortem(brief());
  expect(md).toContain("acme/billing-api");
  expect(md).toContain("Comparable epics (1)");
  expect(md).toContain("HIST-1 — A past epic");
});

const RISK_KIND_LABELS: ReadonlyArray<[RiskKind, string]> = [
  ["cycle_time", "cycle time"],
  ["size_overrun", "size overrun"],
  ["review_drag", "review drag"],
  ["incident_coupling", "incident coupling"],
  ["abandonment", "abandonment"],
];

for (const [kind, label] of RISK_KIND_LABELS) {
  test(`renders the ${kind} risk row with its kind visible`, () => {
    const md = renderPremortem(
      brief({ risks: [risk(kind, { summary: `${kind} unique sentence` })] }),
    );
    expect(md).toContain(label);
    expect(md).toContain(`${kind} unique sentence`);
  });
}

// The mutation the reviewer caught: `expectationOnly` replaced the risk kind
// with the literal string "expectation" instead of appending it, so a young
// epic's cycle-time row lost which risk it was entirely.
test("an expectation-only risk keeps its kind label AND adds the expectation marker", () => {
  const md = renderPremortem(
    brief({
      risks: [risk("cycle_time", { expectationOnly: true, summary: "young epic sentence" })],
    }),
  );
  expect(md).toContain("cycle time");
  expect(md).toContain("(expectation)");
  expect(md).toContain("young epic sentence");
});

test("a measured (non-expectation) risk carries no expectation marker", () => {
  const md = renderPremortem(brief({ risks: [risk("cycle_time", { expectationOnly: false })] }));
  expect(md).not.toContain("(expectation)");
});

test("renders a created watcher proposal with its real id and the resume command", () => {
  const md = renderPremortem(
    brief({ watchers: [watcher({ watcherId: "w-real-uuid-1", state: "created" })] }),
  );
  expect(md).toContain("w-real-uuid-1");
  expect(md).toContain("nimbus watch resume w-real-uuid-1");
});

test("renders an already-present watcher proposal with its real id", () => {
  const md = renderPremortem(
    brief({ watchers: [watcher({ watcherId: "w-real-uuid-2", state: "already_present" })] }),
  );
  expect(md).toContain("w-real-uuid-2");
  expect(md).toContain("already present");
  expect(md).toContain("nimbus watch resume w-real-uuid-2");
});

test("renders a suppressed watcher proposal with its id and the --repropose command for THIS epic", () => {
  const md = renderPremortem(
    brief({
      query: { epicRef: "PROJ-999", serviceOverrides: null },
      watchers: [watcher({ watcherId: "w-suppressed-1", state: "suppressed" })],
    }),
  );
  expect(md).toContain("w-suppressed-1");
  expect(md).toContain("suppressed");
  expect(md).toContain("nimbus pre-mortem PROJ-999 --repropose");
  // A suppressed watcher must NOT tell the reader to `watch resume` — it was
  // deliberately deleted, not merely paused.
  expect(md).not.toContain("nimbus watch resume w-suppressed-1");
});

test("renders recurring themes with service and confidence", () => {
  const md = renderPremortem(
    brief({ themes: [theme({ label: "flaky deploy pipeline", confidence: 0.55 })] }),
  );
  expect(md).toContain("flaky deploy pipeline");
  expect(md).toContain("0.55");
});

test("omits sections whose data is empty rather than printing empty headings", () => {
  const md = renderPremortem(
    brief({
      services: [],
      cohort: { members: [], scannedCount: 0, oldestResolvedAtMs: null },
      risks: [],
      themes: [],
      watchers: [],
    }),
  );
  expect(md).not.toContain("## Services");
  expect(md).not.toContain("## Comparable epics");
  expect(md).not.toContain("## Risks");
  expect(md).not.toContain("## Recurring themes");
  expect(md).not.toContain("## Watcher proposals");
});

test("renders gap notes", () => {
  const md = renderPremortem(
    brief({
      gaps: [
        {
          category: "missing_relation_emit",
          detail: "these are correlations, not causes",
        },
      ],
    }),
  );
  expect(md).toContain("these are correlations, not causes");
});

test("renders a null epic (a non-Jira tracker ref) without a title line", () => {
  const md = renderPremortem(brief({ epic: null, services: [] }));
  expect(md).not.toContain("Rebuild the billing pipeline");
});
