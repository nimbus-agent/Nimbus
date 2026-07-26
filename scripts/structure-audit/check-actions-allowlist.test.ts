import { describe, expect, test } from "bun:test";

import {
  collectActionRefs,
  evaluateAllowlist,
  isActiveWorkflow,
  isCoveredByPatterns,
  latestStartupFailures,
  parsePermissions,
  parseRuns,
  parseSelectedActions,
  parseWorkflows,
  type RunSummary,
  type SelectedActions,
} from "./check-actions-allowlist.ts";

const sel = (over: Partial<SelectedActions> = {}): SelectedActions => ({
  githubOwnedAllowed: false,
  verifiedAllowed: false,
  patternsAllowed: [],
  ...over,
});

describe("collectActionRefs", () => {
  test("collects uses: refs and attributes them to their workflow", () => {
    const refs = collectActionRefs([
      { path: "ci.yml", text: "steps:\n  - uses: actions/checkout@abc123\n" },
    ]);
    expect(refs).toEqual([{ ref: "actions/checkout@abc123", workflow: "ci.yml" }]);
  });

  test("ignores local ./ and docker:// references — the allowlist does not govern them", () => {
    const refs = collectActionRefs([
      { path: "a.yml", text: "  - uses: ./.github/actions/setup\n  - uses: docker://alpine:3\n" },
    ]);
    expect(refs).toEqual([]);
  });

  test("handles quoted refs and a subdirectory path", () => {
    const refs = collectActionRefs([
      { path: "a.yml", text: '  - uses: "github/codeql-action/init@v3"\n' },
    ]);
    expect(refs[0]?.ref).toBe("github/codeql-action/init@v3");
  });

  test("deduplicates the same ref used twice in one workflow", () => {
    const refs = collectActionRefs([{ path: "a.yml", text: "  - uses: a/b@1\n  - uses: a/b@1\n" }]);
    expect(refs).toHaveLength(1);
  });
});

describe("isCoveredByPatterns", () => {
  test("exact owner/repo match", () => {
    expect(isCoveredByPatterns("acme/tool@sha", ["acme/tool"])).toBe(true);
  });
  test("owner wildcard", () => {
    expect(isCoveredByPatterns("acme/tool@sha", ["acme/*"])).toBe(true);
  });
  test("trailing star suffix", () => {
    expect(isCoveredByPatterns("acme/tool@sha", ["acme/tool@*"])).toBe(true);
  });
  test("a subdirectory action is covered by its owner/repo pattern", () => {
    expect(isCoveredByPatterns("github/codeql-action/init@v3", ["github/codeql-action@*"])).toBe(
      true,
    );
  });
  test("a different owner is NOT covered", () => {
    expect(isCoveredByPatterns("evil/tool@sha", ["acme/*"])).toBe(false);
  });
  test("empty pattern list covers nothing", () => {
    expect(isCoveredByPatterns("acme/tool@sha", [])).toBe(false);
  });
});

describe("evaluateAllowlist", () => {
  const refs = [{ ref: "contributor-assistant/github-action@ca4a40a7", workflow: "cla.yml" }];

  test("a repo that does not restrict actions is skipped entirely", () => {
    const r = evaluateAllowlist("Nimbus", "all", null, refs);
    expect(r.verdict).toBe("skipped");
    expect(r.findings).toEqual([]);
  });

  test("an unpermitted action is a finding naming the workflow", () => {
    const r = evaluateAllowlist("Nimbus", "selected", sel({ patternsAllowed: ["other/*"] }), refs);
    expect(r.verdict).toBe("not-permitted");
    expect(r.findings[0]?.ref).toBe("contributor-assistant/github-action@ca4a40a7");
    expect(r.findings[0]?.workflow).toBe("cla.yml");
  });

  test("the CLA outage: adding the pattern makes it permitted", () => {
    const r = evaluateAllowlist(
      "Nimbus",
      "selected",
      sel({ patternsAllowed: ["contributor-assistant/github-action@*"] }),
      refs,
    );
    expect(r.verdict).toBe("ok");
  });

  test("github_owned_allowed covers actions/* and github/*", () => {
    const r = evaluateAllowlist("Nimbus", "selected", sel({ githubOwnedAllowed: true }), [
      { ref: "actions/checkout@sha", workflow: "ci.yml" },
      { ref: "github/codeql-action/init@sha", workflow: "ci.yml" },
    ]);
    expect(r.verdict).toBe("ok");
  });

  test("github_owned_allowed does NOT cover a third party", () => {
    const r = evaluateAllowlist("Nimbus", "selected", sel({ githubOwnedAllowed: true }), refs);
    expect(r.verdict).toBe("not-permitted");
  });

  test("verified_allowed + an uncovered ref => unverifiable, never a finding", () => {
    // Whether a creator is a verified partner is not derivable from any API.
    // Calling it a violation would false-red a legitimately permitted action;
    // calling it covered would restore the blind spot. `unverifiable` is a
    // PERMANENT unknown and so must not be strict-red, unlike `indeterminate`.
    const r = evaluateAllowlist("Nimbus", "selected", sel({ verifiedAllowed: true }), refs);
    expect(r.verdict).toBe("unverifiable");
    expect(r.findings).toEqual([]);
  });

  test("an action owned by the consuming repo's own org is always permitted", () => {
    const r = evaluateAllowlist("nimbus-agent/Nimbus", "selected", sel(), [
      { ref: "nimbus-agent/.github/actions/verify-npm-provenance@sha", workflow: "release.yml" },
    ]);
    expect(r.verdict).toBe("ok");
  });

  test("a pattern match wins over verified_allowed ambiguity", () => {
    const r = evaluateAllowlist(
      "Nimbus",
      "selected",
      sel({ verifiedAllowed: true, patternsAllowed: ["contributor-assistant/*"] }),
      refs,
    );
    expect(r.verdict).toBe("ok");
  });

  test("unreadable selected-actions => indeterminate", () => {
    const r = evaluateAllowlist("Nimbus", "selected", null, refs);
    expect(r.verdict).toBe("indeterminate");
  });
});

describe("latestStartupFailures", () => {
  const run = (workflow: string, createdAt: string, conclusion: string | null): RunSummary => ({
    workflow,
    createdAt,
    conclusion,
    status: "completed",
  });

  test("a workflow whose latest run failed at startup is reported", () => {
    expect(latestStartupFailures([run("cla", "2026-07-24T10:00:00Z", "startup_failure")])).toEqual([
      "cla",
    ]);
  });

  test("a SINCE-FIXED historical failure is not reported", () => {
    // The question is "can this workflow start now", not "has it ever failed" —
    // otherwise one bad day reds the sweep forever and the gate gets ignored.
    expect(
      latestStartupFailures([
        run("cla", "2026-07-24T10:00:00Z", "startup_failure"),
        run("cla", "2026-07-26T10:00:00Z", "success"),
      ]),
    ).toEqual([]);
  });

  test("a newly-broken workflow is reported even with older green runs", () => {
    expect(
      latestStartupFailures([
        run("cla", "2026-07-20T10:00:00Z", "success"),
        run("cla", "2026-07-26T10:00:00Z", "startup_failure"),
      ]),
    ).toEqual(["cla"]);
  });

  test("an ordinary test failure is NOT a startup failure", () => {
    expect(latestStartupFailures([run("ci", "2026-07-26T10:00:00Z", "failure")])).toEqual([]);
  });

  test("reports each broken workflow once, sorted", () => {
    expect(
      latestStartupFailures([
        run("zeta", "2026-07-26T10:00:00Z", "startup_failure"),
        run("alpha", "2026-07-26T10:00:00Z", "startup_failure"),
      ]),
    ).toEqual(["alpha", "zeta"]);
  });

  test("no runs => nothing broken", () => {
    expect(latestStartupFailures([])).toEqual([]);
  });
});

describe("parseWorkflows / isActiveWorkflow", () => {
  test("reads id, name and state", () => {
    const w = parseWorkflows('{"workflows":[{"id":7,"name":"cla","state":"active"}]}');
    expect(w).toEqual([{ id: 7, name: "cla", state: "active" }]);
  });

  test("a disabled workflow is not asked — it cannot run, so a stale failure is history", () => {
    expect(isActiveWorkflow({ id: 1, name: "x", state: "disabled_manually" })).toBe(false);
    expect(isActiveWorkflow({ id: 1, name: "x", state: "active" })).toBe(true);
  });

  test("null on malformed json; entries missing id or name are dropped", () => {
    expect(parseWorkflows("{nope")).toBeNull();
    expect(parseWorkflows('{"workflows":[{"name":"no-id"},{"id":2,"name":"ok"}]}')).toEqual([
      { id: 2, name: "ok", state: "active" },
    ]);
  });
});

describe("parseRuns", () => {
  test("reads name, conclusion and created_at", () => {
    const r = parseRuns(
      '{"workflow_runs":[{"name":"cla","conclusion":"startup_failure","status":"completed","created_at":"2026-07-24T10:00:00Z"}]}',
    );
    expect(r?.[0]?.workflow).toBe("cla");
    expect(r?.[0]?.conclusion).toBe("startup_failure");
  });
  test("null on malformed json, empty on a shape with no runs", () => {
    expect(parseRuns("{nope")).toBeNull();
    expect(parseRuns('{"workflow_runs":[]}')).toEqual([]);
  });
});

describe("parsePermissions / parseSelectedActions", () => {
  test("reads allowed_actions", () => {
    expect(parsePermissions('{"enabled":true,"allowed_actions":"selected"}')).toBe("selected");
  });
  test("null when Actions is disabled entirely", () => {
    expect(parsePermissions('{"enabled":false}')).toBeNull();
  });
  test("null on malformed json", () => {
    expect(parsePermissions("{nope")).toBeNull();
  });
  test("reads the three selected-actions fields", () => {
    const s = parseSelectedActions(
      '{"github_owned_allowed":true,"verified_allowed":false,"patterns_allowed":["a/*"]}',
    );
    expect(s).toEqual({
      githubOwnedAllowed: true,
      verifiedAllowed: false,
      patternsAllowed: ["a/*"],
    });
  });
  test("null on malformed json", () => {
    expect(parseSelectedActions("{nope")).toBeNull();
  });
});
