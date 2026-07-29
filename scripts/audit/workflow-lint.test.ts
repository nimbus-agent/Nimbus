import { describe, expect, it } from "bun:test";

import {
  bashRunBodies,
  findColumnZeroEscapes,
  lintWorkflow,
  TOP_LEVEL_KEYS,
} from "./workflow-lint.ts";

const CLEAN = `name: demo
on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - name: Say hi
        shell: bash
        run: |
          set -euo pipefail
          echo "hi"
`;

describe("findColumnZeroEscapes", () => {
  it("accepts a well-formed workflow", () => {
    expect(findColumnZeroEscapes(CLEAN)).toEqual([]);
  });

  it("flags a heredoc body that starts at column 0 inside a run block", () => {
    // The exact shape that silently invalidated install-smoke.yml: GitHub
    // recorded a run with ZERO jobs and a failure conclusion, and js-yaml
    // parsed it without complaint.
    const broken = `name: demo
on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - shell: bash
        run: |
          cat > f <<'EOF'
[keyring]
display-name=login
EOF
          echo done
`;
    const found = findColumnZeroEscapes(broken);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.content).toBe("[keyring]");
  });

  it("allows every documented top-level key at column 0", () => {
    const text = TOP_LEVEL_KEYS.map((k) => `${k}: x`).join("\n");
    expect(findColumnZeroEscapes(text)).toEqual([]);
  });

  it("ignores blank lines", () => {
    expect(findColumnZeroEscapes("name: a\n\n\non: b\n")).toEqual([]);
  });

  it("ignores column-0 comments", () => {
    // 13 of this repo's workflows open with a column-0 comment block — 156
    // such lines in total. Treating them as escapes would fail the gate
    // instantly on a completely valid tree.
    const text = `# SPDX-License-Identifier: AGPL-3.0
# A leading rationale comment.
name: demo
on: push
`;
    expect(findColumnZeroEscapes(text)).toEqual([]);
  });

  it("ignores YAML document markers", () => {
    expect(findColumnZeroEscapes("---\nname: a\non: push\n...\n")).toEqual([]);
  });

  it("still flags a real escape that follows a comment block", () => {
    const text = `# leading comment
name: demo
on: push
jobs:
  b:
    steps:
      - run: |
          cat <<'EOF'
[oops]
EOF
`;
    const found = findColumnZeroEscapes(text);
    expect(found.map((f) => f.content)).toContain("[oops]");
  });
});

describe("bashRunBodies", () => {
  it("returns bodies for explicit bash steps", () => {
    const bodies = bashRunBodies(CLEAN);
    expect(bodies.length).toBe(1);
    expect(bodies[0]?.script).toContain('echo "hi"');
    expect(bodies[0]?.step).toBe("Say hi");
  });

  it("skips pwsh steps", () => {
    const text = `name: d
on: push
jobs:
  b:
    runs-on: windows-2022
    steps:
      - shell: pwsh
        run: Write-Host "x"
`;
    expect(bashRunBodies(text)).toEqual([]);
  });

  it("honours a job-level defaults.run.shell of pwsh", () => {
    const text = `name: d
on: push
jobs:
  b:
    runs-on: windows-2022
    defaults:
      run:
        shell: pwsh
    steps:
      - run: Write-Host "x"
`;
    expect(bashRunBodies(text)).toEqual([]);
  });

  it("treats a step with no shell as bash", () => {
    const text = `name: d
on: push
jobs:
  b:
    runs-on: ubuntu-24.04
    steps:
      - run: echo hi
`;
    expect(bashRunBodies(text).length).toBe(1);
  });
});

describe("lintWorkflow", () => {
  it("reports nothing for a clean file", () => {
    expect(lintWorkflow("a.yml", CLEAN, () => null)).toEqual([]);
  });

  it("reports unparsable YAML", () => {
    const findings = lintWorkflow("a.yml", "name: [unclosed\n", () => null);
    expect(findings.length).toBe(1);
    expect(findings[0]).toContain("could not be parsed");
  });

  it("reports a bash body that fails the syntax checker", () => {
    const findings = lintWorkflow("a.yml", CLEAN, () => "line 2: syntax error");
    expect(findings.length).toBe(1);
    expect(findings[0]).toContain("syntax error");
    expect(findings[0]).toContain("Say hi");
  });

  it("passes each bash body to the checker exactly once", () => {
    const seen: string[] = [];
    lintWorkflow("a.yml", CLEAN, (s) => {
      seen.push(s);
      return null;
    });
    expect(seen.length).toBe(1);
  });

  it("skips the shell check when no checker is supplied", () => {
    expect(lintWorkflow("a.yml", CLEAN)).toEqual([]);
  });
});
