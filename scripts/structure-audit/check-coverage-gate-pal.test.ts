import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  auditCoverageGatePal,
  detectPlatformBranchingFiles,
  jobLevelKey,
  parseCoverageGateMatrix,
  splitJobBlocks,
  testSuiteLinuxRunners,
} from "./check-coverage-gate-pal.ts";
import { REPO_ROOT } from "./lib.ts";
import type { PlatformFileEntry } from "./platform-branching-allowlist.ts";

const MATRIX = `
  coverage-gates:
    name: Coverage — \${{ matrix.gate.name }}
    needs: unit-coverage
    strategy:
      fail-fast: false
      matrix:
        gate:
          - name: Engine
            script: "test:coverage:engine"
            pal: false
          - name: Vault
            script: "test:coverage:vault"
            pal: true
    steps:
      - name: Checkout
`;

/** The same 2 gates, split across two jobs exactly as _test-suite.yml does. */
const SPLIT_MATRIX = `
jobs:
  coverage-gates-pal:
    name: Coverage — \${{ matrix.gate.name }}
    if: inputs.run-tests
    needs: unit-coverage
    strategy:
      fail-fast: false
      matrix:
        gate:
          - name: Vault
            script: "test:coverage:vault"
            pal: true
    steps:
      - name: Checkout

  coverage-gates-linux:
    name: Coverage — \${{ matrix.gate.name }}
    if: inputs.run-tests && inputs.runner == 'ubuntu-24.04'
    needs: unit-coverage
    strategy:
      fail-fast: false
      matrix:
        gate:
          - name: Engine
            script: "test:coverage:engine"
            pal: false
    steps:
      - name: Checkout
`;

describe("parseCoverageGateMatrix", () => {
  test("reads each gate name and its explicit pal flag", () => {
    expect(parseCoverageGateMatrix(MATRIX)).toEqual([
      { name: "Engine", pal: false },
      { name: "Vault", pal: true },
    ]);
  });

  test("a gate with no pal field parses as null, not as false", () => {
    // A missing flag must be distinguishable from an explicit `false`, so the
    // audit can demand classification rather than silently defaulting.
    const yaml = MATRIX.replace("            pal: false\n", "");
    expect(parseCoverageGateMatrix(yaml)[0]).toEqual({ name: "Engine", pal: null });
  });

  test("stops at the end of the matrix block", () => {
    // `steps:` dedents out of the matrix; nothing after it is a gate.
    expect(parseCoverageGateMatrix(MATRIX).map((g) => g.name)).not.toContain("Checkout");
  });

  test("a reformat to a different indent width still parses", () => {
    // Indentation is read relative to the `gate:` key, so a cosmetic reformat
    // must not red the gate. Here every line is re-indented by 2 extra spaces.
    const reindented = MATRIX.split("\n")
      .map((l) => (l.trim() === "" ? l : `  ${l}`))
      .join("\n");
    expect(parseCoverageGateMatrix(reindented)).toEqual([
      { name: "Engine", pal: false },
      { name: "Vault", pal: true },
    ]);
  });

  test("a trailing YAML comment on the pal line still parses", () => {
    // `pal: true  # note` is valid YAML. A regex requiring end-of-line
    // immediately after the flag would misread this as unset and wrongly
    // trip rule 4 once a later task starts writing these fields.
    const withComment = MATRIX.replace(
      "            pal: false\n",
      "            pal: false  # note\n",
    );
    expect(parseCoverageGateMatrix(withComment)).toEqual([
      { name: "Engine", pal: false },
      { name: "Vault", pal: true },
    ]);
  });

  test("reads BOTH matrix blocks and returns their union", () => {
    // The matrix is split across coverage-gates-pal and coverage-gates-linux.
    // An earlier revision took only the FIRST `gate:` block, which validated
    // half the entries and reported OK on the rest.
    expect(parseCoverageGateMatrix(SPLIT_MATRIX)).toEqual([
      { name: "Vault", pal: true },
      { name: "Engine", pal: false },
    ]);
  });

  test("a first-block-only parse of a split matrix is detectably short", () => {
    // Red-proof for the union: parsing each job's block in isolation must yield
    // strictly fewer entries than parsing the whole file, so a regression that
    // stops after block 1 cannot look identical to the correct result.
    const blocks = splitJobBlocks(SPLIT_MATRIX);
    const firstOnly = parseCoverageGateMatrix((blocks.get("coverage-gates-pal") ?? []).join("\n"));
    expect(firstOnly).toEqual([{ name: "Vault", pal: true }]);
    expect(firstOnly.length).toBeLessThan(parseCoverageGateMatrix(SPLIT_MATRIX).length);
  });
});

describe("splitJobBlocks / jobLevelKey", () => {
  test("splits jobs and reads a JOB-level if, not a step-level one", () => {
    const jobs = splitJobBlocks(SPLIT_MATRIX);
    expect([...jobs.keys()]).toEqual(["coverage-gates-pal", "coverage-gates-linux"]);
    expect(jobLevelKey(jobs.get("coverage-gates-pal") ?? [], "if")).toBe("inputs.run-tests");
    expect(jobLevelKey(jobs.get("coverage-gates-linux") ?? [], "if")).toBe(
      "inputs.run-tests && inputs.runner == 'ubuntu-24.04'",
    );
  });

  test("a step-level if is NOT mistaken for the job's condition", () => {
    // This is exactly the distinction the shipped bug turned on: `matrix` is
    // available at step level and not at job level.
    const yaml = `
jobs:
  a-job:
    runs-on: ubuntu-24.04
    steps:
      - name: Only on linux
        if: runner.os == 'Linux'
        run: echo hi
`;
    expect(jobLevelKey(splitJobBlocks(yaml).get("a-job") ?? [], "if")).toBeNull();
  });

  test("a comment between jobs does not invent a job", () => {
    const yaml = `
jobs:
  first:
    runs-on: ubuntu-24.04

  # ── a divider ──
  second:
    runs-on: ubuntu-24.04
`;
    expect([...splitJobBlocks(yaml).keys()]).toEqual(["first", "second"]);
  });
});

describe("testSuiteLinuxRunners", () => {
  const CI = `
jobs:
  pr-quality-ts:
    uses: ./.github/workflows/_test-suite.yml
    with:
      runner: ubuntu-24.04
  ci-ts:
    strategy:
      matrix:
        os: [ubuntu-24.04, macos-15, windows-2025]
    uses: ./.github/workflows/_test-suite.yml
    with:
      runner: \${{ matrix.os }}
  e2e-desktop:
    strategy:
      matrix:
        os: [ubuntu-22.04, macos-15]
    runs-on: \${{ matrix.os }}
`;

  test("reads the literal runner input and resolves the matrix one", () => {
    expect(testSuiteLinuxRunners(CI)).toEqual(["ubuntu-24.04"]);
  });

  test("ignores an os: matrix on a job that does not call _test-suite.yml", () => {
    // e2e-desktop above runs on ubuntu-22.04; its label has no bearing on
    // whether coverage-gates-linux fires, so it must not pollute the result.
    expect(testSuiteLinuxRunners(CI)).not.toContain("ubuntu-22.04");
  });

  test("the real ci.yml calls the suite with exactly one Linux label", () => {
    const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(testSuiteLinuxRunners(ci)).toEqual(["ubuntu-24.04"]);
  });
});

describe("detectPlatformBranchingFiles", () => {
  test("finds files that branch via a destructured node:os import", () => {
    // The dominant idiom in this repo. An earlier revision matched only
    // `process.platform` and missed doctor-core.ts, which caused its gate to be
    // classified Linux-only by mistake.
    const hits = detectPlatformBranchingFiles(REPO_ROOT);
    expect(hits).toContain("packages/cli/src/commands/doctor-core.ts");
    expect(hits).toContain("packages/gateway/src/vault/factory.ts");
  });

  test("reaches a NESTED src directory, not just packages/{pkg}/src", () => {
    // packages/mcp-connectors/src does not exist; each of the 94 connectors has
    // its own packages/mcp-connectors/{name}/src. A one-level scan skipped all
    // of them silently. No connector branches on platform today, so this uses a
    // fixture tree — asserting against the real repo would pass for the wrong
    // reason (nothing to find) and would not catch the regression.
    const root = mkdtempSync(join(tmpdir(), "pal-detect-"));
    try {
      const shallow = join(root, "packages", "gateway", "src");
      const nested = join(root, "packages", "mcp-connectors", "airflow", "src");
      mkdirSync(shallow, { recursive: true });
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(shallow, "a.ts"), "if (process.platform === 'win32') {}\n");
      writeFileSync(join(nested, "b.ts"), "if (process.platform === 'darwin') {}\n");

      expect(detectPlatformBranchingFiles(root)).toEqual([
        "packages/gateway/src/a.ts",
        "packages/mcp-connectors/airflow/src/b.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes test files, which may branch on platform legitimately", () => {
    expect(detectPlatformBranchingFiles(REPO_ROOT).some((f) => f.includes(".test."))).toBe(false);
  });

  test("does not flag a file that only MENTIONS process.platform in a comment", () => {
    // A file documenting that it deliberately does not branch must not be
    // reported as a finding — that would be a false positive with zero real
    // branching to classify.
    const root = mkdtempSync(join(tmpdir(), "pal-detect-comment-"));
    try {
      const src = join(root, "packages", "gateway", "src");
      mkdirSync(src, { recursive: true });
      writeFileSync(
        join(src, "a.ts"),
        "// This function deliberately does NOT branch on process.platform.\nexport function f() {}\n",
      );

      expect(detectPlatformBranchingFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still flags a file that genuinely branches even alongside a comment mentioning the idiom", () => {
    // Comment-stripping must not weaken real detection: code branching on
    // process.platform stays a finding even when a comment also references
    // the idiom by name.
    const root = mkdtempSync(join(tmpdir(), "pal-detect-real-"));
    try {
      const src = join(root, "packages", "gateway", "src");
      mkdirSync(src, { recursive: true });
      writeFileSync(
        join(src, "a.ts"),
        "// process.platform is how you'd normally branch on OS.\nif (process.platform === 'win32') {}\n",
      );

      expect(detectPlatformBranchingFiles(root)).toEqual(["packages/gateway/src/a.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Fixture repo, so each audit rule gets its own red-proof ─────────────────
//
// `auditCoverageGatePal` used to have exactly one test: "the real repository
// passes". A regression inside any single rule left every test green. Each
// fixture below breaks ONE thing and asserts the matching finding.

interface FixtureOptions {
  /** Overrides the `if:` on coverage-gates-pal. */
  palIf?: string;
  /** Overrides the `if:` on coverage-gates-linux. */
  linuxIf?: string;
  /** Replaces the pal job's matrix entries (already indented). */
  palGates?: string;
  /** Replaces the linux job's matrix entries (already indented). */
  linuxGates?: string;
  /** Drops the coverage-gates-pal job entirely. */
  omitPalJob?: boolean;
  /** Runner label the fixture ci.yml calls _test-suite.yml with. */
  ciRunner?: string;
  /** Extra `os:` labels on the ci-ts caller matrix. */
  ciMatrixOs?: string;
  /** Extra repo-relative source files, on top of the default vault/factory.ts. */
  sources?: Record<string, string>;
}

const FIXTURE_ALLOWLIST: readonly PlatformFileEntry[] = [
  {
    file: "packages/gateway/src/vault/factory.ts",
    gate: "Vault",
    why: "selects the per-OS vault backend",
  },
];

const DEFAULT_PAL_GATES =
  '          - name: Vault\n            script: "test:coverage:vault"\n            pal: true\n';
const DEFAULT_LINUX_GATES =
  '          - name: Engine\n            script: "test:coverage:engine"\n            pal: false\n';

/**
 * A literal GitHub Actions expression, assembled through a template literal
 * with an escaped `$` so Biome does not read `${{ … }}` inside a plain string
 * as a botched template literal (`noTemplateCurlyInString`). Here it is exactly
 * the text the fixture workflow must contain.
 */
function gha(expr: string): string {
  return `\${{ ${expr} }}`;
}

function job(name: string, cond: string, gates: string): string {
  return (
    `  ${name}:\n` +
    `    name: Coverage — ${gha("matrix.gate.name")} (${gha("inputs.runner")})\n` +
    `    if: ${cond}\n` +
    "    needs: unit-coverage\n" +
    `    runs-on: ${gha("inputs.runner")}\n` +
    "    strategy:\n" +
    "      fail-fast: false\n" +
    "      matrix:\n" +
    "        gate:\n" +
    gates +
    "    steps:\n" +
    "      - name: Checkout\n"
  );
}

function writeFixture(o: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-pal-fixture-"));
  const workflows = join(root, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });

  const palJob = o.omitPalJob
    ? ""
    : job("coverage-gates-pal", o.palIf ?? "inputs.run-tests", o.palGates ?? DEFAULT_PAL_GATES);
  const linuxJob = job(
    "coverage-gates-linux",
    o.linuxIf ?? "inputs.run-tests && inputs.runner == 'ubuntu-24.04'",
    o.linuxGates ?? DEFAULT_LINUX_GATES,
  );
  writeFileSync(
    join(workflows, "_test-suite.yml"),
    `name: Test Suite\njobs:\n${palJob}\n${linuxJob}`,
  );

  const runner = o.ciRunner ?? "ubuntu-24.04";
  const matrixOs = o.ciMatrixOs ?? `${runner}, macos-15, windows-2025`;
  writeFileSync(
    join(workflows, "ci.yml"),
    "name: CI\njobs:\n" +
      "  pr-quality-ts:\n" +
      "    uses: ./.github/workflows/_test-suite.yml\n" +
      "    with:\n" +
      `      runner: ${runner}\n` +
      "  ci-ts:\n" +
      "    strategy:\n" +
      "      matrix:\n" +
      `        os: [${matrixOs}]\n` +
      "    uses: ./.github/workflows/_test-suite.yml\n" +
      "    with:\n" +
      `      runner: ${gha("matrix.os")}\n`,
  );

  const sources: Record<string, string> = {
    "packages/gateway/src/vault/factory.ts": "export const isWin = process.platform === 'win32';\n",
    ...(o.sources ?? {}),
  };
  for (const [rel, body] of Object.entries(sources)) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

function auditFixture(o: FixtureOptions = {}, allowlist = FIXTURE_ALLOWLIST): string[] {
  const root = writeFixture(o);
  try {
    return auditCoverageGatePal(root, { allowlist }).errors;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("auditCoverageGatePal", () => {
  test("the real repository passes", () => {
    const result = auditCoverageGatePal(REPO_ROOT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("the real workflow carries all 24 gates, 9 PAL and 15 Linux-only", () => {
    const gates = parseCoverageGateMatrix(
      readFileSync(join(REPO_ROOT, ".github/workflows/_test-suite.yml"), "utf8"),
    );
    expect(gates).toHaveLength(24);
    expect(gates.filter((g) => g.pal === true)).toHaveLength(9);
    expect(gates.filter((g) => g.pal === false)).toHaveLength(15);
  });

  test("the untouched fixture passes — so every red below is caused by its own edit", () => {
    expect(auditFixture()).toEqual([]);
  });

  test("rule 1 — a platform-branching file missing from the allowlist is a finding", () => {
    const errors = auditFixture({
      sources: {
        "packages/gateway/src/updater/factory.ts": "import { platform } from 'node:os';\n",
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("packages/gateway/src/updater/factory.ts");
    expect(errors[0]).toContain("not in PLATFORM_BRANCHING_ALLOWLIST");
  });

  test("rule 2 — an allowlist entry for a file that no longer branches is a finding", () => {
    const errors = auditFixture({}, [
      ...FIXTURE_ALLOWLIST,
      { file: "packages/gateway/src/gone.ts", gate: "Vault", why: "deleted long ago" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("packages/gateway/src/gone.ts");
    expect(errors[0]).toContain("no longer branches on platform");
  });

  test("rule 3 — an allowlisted file whose gate is not pal: true is a finding", () => {
    const errors = auditFixture({}, [
      {
        file: "packages/gateway/src/vault/factory.ts",
        gate: "Engine", // Engine is pal: false in the fixture
        why: "misclassified on purpose",
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('gate "Engine"');
    expect(errors[0]).toContain("not `pal: true`");
  });

  test("rule 3 — an allowlisted file naming a gate that does not exist is a finding", () => {
    const errors = auditFixture({}, [
      { file: "packages/gateway/src/vault/factory.ts", gate: "Ghost", why: "renamed gate" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('coverage gate "Ghost"');
  });

  test("rule 4 — a matrix entry with no explicit pal field is a finding", () => {
    const errors = auditFixture({
      linuxGates: '          - name: Engine\n            script: "test:coverage:engine"\n',
    });
    expect(errors.some((e) => e.includes('"Engine" has no explicit `pal:` field'))).toBe(true);
  });

  test("rule 5 — a missing coverage-gates-pal job is a finding", () => {
    // Merging the two jobs back into one is the regression this catches: the
    // merged spelling needs `matrix` in a job-level `if:`, which does not exist.
    const errors = auditFixture({ omitPalJob: true });
    expect(errors.some((e) => e.includes('job "coverage-gates-pal" not found'))).toBe(true);
  });

  test("rule 5 — an altered if: on the PAL job is a finding", () => {
    // This is literally the shipped bug: the `|| matrix.gate.pal` disjunct reads
    // a context a job-level `if:` does not have, and would skip all 9 PAL gates
    // on Windows and macOS.
    const errors = auditFixture({
      palIf: "inputs.run-tests && (inputs.runner == 'ubuntu-24.04' || matrix.gate.pal)",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('job "coverage-gates-pal" must carry `if: inputs.run-tests`');
  });

  test("rule 5 — a removed if: on the Linux job is a finding", () => {
    const errors = auditFixture({ linuxIf: "inputs.run-tests" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('job "coverage-gates-linux" must carry');
  });

  test("rule 5 — a pal: true gate parked in the Linux-only job is a finding", () => {
    const errors = auditFixture({
      linuxGates:
        DEFAULT_LINUX_GATES +
        '          - name: Sandbox\n            script: "test:coverage:sandbox"\n            pal: true\n',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"Sandbox" is `pal: true` but sits in "coverage-gates-linux"');
  });

  test("rule 6 — a runner label that ci.yml does not call the suite with is a finding", () => {
    // Bumping the runner in ci.yml alone would otherwise skip all 15 Linux-only
    // gates on every caller, with nothing turning red.
    const errors = auditFixture({ ciRunner: "ubuntu-26.04" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('gates on runner "ubuntu-24.04"');
    expect(errors[0]).toContain("ubuntu-26.04");
  });

  test("rule 6 — two different Linux labels across callers is a finding", () => {
    const errors = auditFixture({ ciMatrixOs: "ubuntu-26.04, macos-15, windows-2025" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("more than one Linux runner label");
  });

  test("a missing ci.yml is reported rather than silently passing rule 6", () => {
    const root = writeFixture();
    try {
      rmSync(join(root, ".github", "workflows", "ci.yml"));
      const errors = auditCoverageGatePal(root, { allowlist: FIXTURE_ALLOWLIST }).errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("ci.yml not found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
