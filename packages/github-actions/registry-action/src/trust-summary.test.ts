import { describe, expect, test } from "bun:test";
import type { FeedPlan } from "../../../registry-format/src/index.ts";
import { planLines } from "./trust-summary.ts";

const EMPTY: FeedPlan = {
  status: "unchanged",
  blocks: [],
  verified: [],
  unverified: [],
  admitted: [],
  skipped: [],
};

describe("planLines", () => {
  test("an empty plan says so; skips are listed after it", () => {
    expect(planLines(EMPTY, [])).toEqual(["Nothing to sign."]);
    const lines = planLines({ ...EMPTY, skipped: [{ path: "requests/b.json", reason: "bad" }] }, [
      { path: "requests/a.json", reason: "not valid JSON" },
    ]);
    expect(lines.slice(0, 3)).toEqual(["Nothing to sign.", "", "**Skipped** (not signed):"]);
    expect(lines).toContain("- `requests/a.json`: `not valid JSON`");
    expect(lines).toContain("- `requests/b.json`: `bad`");
  });

  test("takedowns name their versions, or all of them; un-verified publishers are listed", () => {
    const lines = planLines(
      {
        ...EMPTY,
        status: "changed",
        blocks: [
          {
            path: "requests/a.json",
            request: {
              kind: "extension.takedown",
              extensionId: "acme/tool",
              publisherId: "acme",
              versions: ["1.0.0", "1.0.1"],
              reason: "malware",
            },
          },
          {
            path: "requests/b.json",
            request: {
              kind: "extension.takedown",
              extensionId: "acme/other",
              versions: "*",
              reason: "x",
            },
          },
        ],
        unverified: ["gone"],
      },
      [],
    );
    expect(lines[0]).toContain("`1.0.0, 1.0.1`");
    expect(lines[1]).toContain("`all versions`");
    expect(lines[1]).toContain("publisher `?`");
    expect(lines[2]).toBe("- **un-verify** publisher `gone`");
  });

  test("a pull request's strings render as code spans, never as Markdown", () => {
    const [line] = planLines(
      {
        ...EMPTY,
        status: "changed",
        blocks: [
          {
            path: "requests/x.json",
            request: {
              kind: "key.revoke",
              publisherId: "acme",
              keyFingerprint: "a".repeat(32),
              reason: "**bold** [link](https://evil.example)\nnext",
            },
          },
        ],
      },
      [],
    );
    expect(line).toContain("`**bold** [link](https://evil.example) next`");
  });
});
