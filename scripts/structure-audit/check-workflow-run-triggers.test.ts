import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  auditWorkflowRunTriggers,
  FORK_UNREACHABLE_TRIGGERS,
  parseWorkflow,
  triggerNames,
} from "./check-workflow-run-triggers.ts";
import { REPO_ROOT } from "./lib.ts";

/**
 * Minimal privileged consumer: `workflow_run` on a single named upstream.
 *
 * The real workflows also carry `ref: ${…workflow_run.head_sha}` on their
 * checkout; it is omitted here because the audit reads `on:` only, and a
 * literal `${{` in a fixture trips Biome's noTemplateCurlyInString.
 */
function consumer(upstream: string[]): string {
  return [
    "name: Publish",
    "on:",
    "  workflow_run:",
    `    workflows: [${upstream.map((w) => JSON.stringify(w)).join(", ")}]`,
    "    types: [completed]",
    "jobs:",
    "  publish:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - uses: actions/checkout@aaaa",
    "",
  ].join("\n");
}

describe("triggerNames", () => {
  test("reads the mapping form", () => {
    expect(triggerNames({ push: { tags: ["v*"] }, workflow_dispatch: null })).toEqual([
      "push",
      "workflow_dispatch",
    ]);
  });

  test("reads the sequence form", () => {
    expect(triggerNames(["push", "pull_request"])).toEqual(["push", "pull_request"]);
  });

  test("reads the scalar form", () => {
    expect(triggerNames("push")).toEqual(["push"]);
  });

  test("returns [] for a missing/!object `on:`", () => {
    expect(triggerNames(undefined)).toEqual([]);
    expect(triggerNames(null)).toEqual([]);
    expect(triggerNames(42)).toEqual([]);
  });
});

describe("parseWorkflow", () => {
  test("finds `on:` even when the YAML loader booleanises the key", () => {
    // YAML 1.1 loaders read a bare `on` key as boolean true. js-yaml >=4 does
    // not, but the gate must not silently see "no triggers" (which reads as
    // PASS) if the loader is ever swapped or downgraded.
    const wf = parseWorkflow("x.yml", "name: X\ntrue:\n  pull_request:\njobs: {}\n");
    expect(wf.triggers).toEqual(["pull_request"]);
  });

  test("falls back to the file path when the workflow has no `name:`", () => {
    const wf = parseWorkflow(".github/workflows/x.yml", "on: push\njobs: {}\n");
    expect(wf.name).toBe(".github/workflows/x.yml");
  });

  test("records a parse failure instead of reporting an empty trigger set", () => {
    const wf = parseWorkflow("x.yml", "name: [unclosed\n");
    expect(wf.parseError).toBeTruthy();
  });
});

describe("auditWorkflowRunTriggers", () => {
  test("passes when the only upstream is tag-push triggered", () => {
    const result = auditWorkflowRunTriggers([
      { path: "publish.yml", text: consumer(["Release"]) },
      { path: "release.yml", text: 'name: Release\non:\n  push:\n    tags: ["v*"]\njobs: {}\n' },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("FAILS when an upstream also runs on pull_request — the fork path this gate exists for", () => {
    const result = auditWorkflowRunTriggers([
      { path: "publish.yml", text: consumer(["Release"]) },
      {
        path: "release.yml",
        text: 'name: Release\non:\n  push:\n    tags: ["v*"]\n  pull_request:\njobs: {}\n',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("pull_request");
    expect(result.errors.join("\n")).toContain("release.yml");
    expect(result.errors.join("\n")).toContain("publish.yml");
  });

  test("FAILS on pull_request_target too", () => {
    const result = auditWorkflowRunTriggers([
      { path: "publish.yml", text: consumer(["Release"]) },
      { path: "release.yml", text: "name: Release\non:\n  pull_request_target:\njobs: {}\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("pull_request_target");
  });

  test("FAILS on any trigger outside the allowlist, not just the PR family", () => {
    // Deny-by-default: `issue_comment` is outside-contributor reachable, and a
    // gate that only knew the PR family would have waved it through.
    const result = auditWorkflowRunTriggers([
      { path: "publish.yml", text: consumer(["Release"]) },
      { path: "release.yml", text: "name: Release\non:\n  issue_comment:\njobs: {}\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("issue_comment");
  });

  test("FAILS when `workflows:` is absent — the trigger then fires for EVERY workflow", () => {
    const result = auditWorkflowRunTriggers([
      {
        path: "publish.yml",
        text: "name: Publish\non:\n  workflow_run:\n    types: [completed]\njobs: {}\n",
      },
      { path: "ci.yml", text: "name: CI\non:\n  pull_request:\njobs: {}\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("no `workflows:` filter");
  });

  test("FAILS when `workflows:` is an empty list", () => {
    const result = auditWorkflowRunTriggers([
      {
        path: "publish.yml",
        text: "name: Publish\non:\n  workflow_run:\n    workflows: []\njobs: {}\n",
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("no `workflows:` filter");
  });

  test("FAILS when a named upstream resolves to no workflow file (unprovable premise)", () => {
    const result = auditWorkflowRunTriggers([{ path: "publish.yml", text: consumer(["Relase"]) }]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("Relase");
    expect(result.errors.join("\n")).toContain("no workflow in this repo");
  });

  test("checks EVERY file sharing an upstream's name, not just the first", () => {
    const result = auditWorkflowRunTriggers([
      { path: "publish.yml", text: consumer(["Release"]) },
      { path: "release.yml", text: 'name: Release\non:\n  push:\n    tags: ["v*"]\njobs: {}\n' },
      { path: "release-2.yml", text: "name: Release\non:\n  pull_request:\njobs: {}\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("release-2.yml");
  });

  test("checks every entry of a multi-upstream `workflows:` list", () => {
    const result = auditWorkflowRunTriggers([
      { path: "publish.yml", text: consumer(["Release", "Build"]) },
      { path: "release.yml", text: 'name: Release\non:\n  push:\n    tags: ["v*"]\njobs: {}\n' },
      { path: "build.yml", text: "name: Build\non:\n  pull_request:\njobs: {}\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("Build");
  });

  test("FAILS closed when a workflow file does not parse", () => {
    const result = auditWorkflowRunTriggers([
      { path: "publish.yml", text: consumer(["Release"]) },
      { path: "release.yml", text: "name: Release\non:\n  push:\n   - [broken\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("could not be parsed");
  });

  test("is a no-op on a repo with no workflow_run consumer", () => {
    const result = auditWorkflowRunTriggers([
      { path: "ci.yml", text: "name: CI\non:\n  pull_request:\njobs: {}\n" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
  });

  test("allowlist stays minimal — widening it is a security decision, not a typo fix", () => {
    expect([...FORK_UNREACHABLE_TRIGGERS].sort()).toEqual([
      "push",
      "schedule",
      "workflow_dispatch",
    ]);
  });
});

describe("the real .github/workflows tree", () => {
  test("every workflow_run consumer has only fork-unreachable upstreams", () => {
    const dir = join(REPO_ROOT, ".github", "workflows");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => ({ path: f, text: readFileSync(join(dir, f), "utf8") }));
    const result = auditWorkflowRunTriggers(files);
    expect(result.errors).toEqual([]);
    // Guards the guard: if the two publish workflows ever stop using
    // `workflow_run`, a vacuous 0-consumer pass must not read as proof.
    expect(result.checked).toBeGreaterThan(0);
  });
});
