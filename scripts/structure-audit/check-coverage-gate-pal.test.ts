import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditCoverageGatePal,
  detectPlatformBranchingFiles,
  parseCoverageGateMatrix,
} from "./check-coverage-gate-pal.ts";
import { REPO_ROOT } from "./lib.ts";

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
});

describe("auditCoverageGatePal", () => {
  test("the real repository passes", () => {
    const result = auditCoverageGatePal(REPO_ROOT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
