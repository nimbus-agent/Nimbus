import { expect, test } from "bun:test";

import { renderWhy } from "./render.ts";
import type { WhyBrief } from "./why-types.ts";

function brief(overrides: Partial<WhyBrief>): WhyBrief {
  return {
    kind: "why",
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 1234,
    gaps: [],
    query: { ref: "src/a.ts:42", line: null },
    subject: { repoRoot: "/repo", filePath: "src/a.ts", lineNo: 42, symbol: null },
    findings: [],
    ...overrides,
  };
}

test("renders lane sections in fixed order with linked findings", () => {
  const md = renderWhy(
    brief({
      findings: [
        {
          lane: "ticket",
          title: "NIM-88 Retry backoff",
          detail: "linked via resolves",
          url: "https://linear.app/NIM-88",
          occurredAt: null,
          entityId: "e2",
        },
        {
          lane: "authorship",
          title: "alice · a1b2c3d4e5f6",
          detail: "Fix retry backoff",
          url: null,
          occurredAt: 1_700_000_000_000,
          entityId: "e1",
        },
      ],
    }),
  );
  expect(md).toContain("## Authorship");
  expect(md).toContain("## Ticket");
  expect(md.indexOf("## Authorship")).toBeLessThan(md.indexOf("## Ticket"));
  expect(md).toContain("[NIM-88 Retry backoff](https://linear.app/NIM-88)");
  expect(md).toContain("alice · a1b2c3d4e5f6");
});

test("an unresolved subject renders a could-not-resolve line, not a crash", () => {
  const md = renderWhy(brief({ subject: null }));
  expect(md).toContain("src/a.ts:42");
  expect(md.toLowerCase()).toContain("could not resolve");
});

test("gaps section renders when gaps exist", () => {
  const md = renderWhy(
    brief({ gaps: [{ category: "missing_connector", detail: "No Slack connector synced." }] }),
  );
  expect(md).toContain("No Slack connector synced.");
});
