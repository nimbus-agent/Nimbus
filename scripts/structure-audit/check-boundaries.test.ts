import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  assessCruise,
  auditBoundaries,
  type CruiseInvocation,
  CruiseOutputError,
  type CruiseResult,
  type CruiseRun,
  type CruiseViolation,
  cruiseArgv,
  decide,
  dependencyCruiserBin,
  type ForbiddenRule,
  formatViolation,
  PRELOAD_PATH,
  parseCruiseResult,
  REQUIRED_SOURCES_GLOB,
  repoInvocation,
  requiredSourceFiles,
  runCruise,
} from "./check-boundaries.ts";
import { REPO_ROOT } from "./lib.ts";

const TS6 = "typescript@6.0.3";
const NO_PATH = { path: null, pathNot: null } as const;

/** The version the root `typescript-compiler-api` alias installed: what the preload must serve. */
function aliasVersion(): string {
  const manifest: unknown = createRequire(join(REPO_ROOT, "package.json"))(
    "typescript-compiler-api/package.json",
  );
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
    throw new Error("typescript-compiler-api/package.json has no version");
  }
  return String(manifest.version);
}

/** Rules shaped like `.dependency-cruiser.cjs`'s own: one unscoped, two path-scoped. */
const RULES: readonly ForbiddenRule[] = [
  { name: "no-circular", comment: "No cycles.", from: NO_PATH, to: NO_PATH },
  {
    name: "cli-no-import-gateway",
    comment: "CLI talks IPC.",
    from: { path: "^packages/cli/src", pathNot: null },
    to: { path: "^packages/gateway/src", pathNot: null },
  },
  {
    name: "pal-isolation",
    comment: "PAL only through platform/index.ts.",
    from: { path: "^packages/gateway/src/", pathNot: "^packages/gateway/src/platform/index\\.ts$" },
    to: { path: "^packages/gateway/src/platform/(win32|darwin|linux)\\.ts$", pathNot: null },
  },
];

const REQUIRED = [
  "packages/cli/src/main.ts",
  "packages/gateway/src/engine.ts",
  "packages/gateway/src/platform/index.ts",
  "packages/gateway/src/platform/win32.ts",
];

/**
 * A cruise that read every REQUIRED file, each importing the next, so it sits exactly ON the
 * one-edge-per-module floor rather than comfortably above it.
 */
function healthy(overrides: Partial<CruiseResult> = {}): CruiseResult {
  return {
    modules: REQUIRED.map((source, i) => ({
      source,
      dependencies: [
        { resolved: REQUIRED[(i + 1) % REQUIRED.length] ?? source, couldNotResolve: false },
      ],
    })),
    violations: [],
    rules: RULES,
    environmentIssues: [],
    typescript: TS6,
    ...overrides,
  };
}

/** The line a pass over `healthy()` against REQUIRED prints. */
const HEALTHY_OK = `audit:boundaries: OK (4 modules, 4 dependencies cruised with ${TS6}; 4/4 required sources covered; 3 rules)`;

/**
 * The exact shape `bunx dependency-cruiser` printed on main whenever bun linked typescript@7: the
 * one .mjs file, no edges, its own environment warning, exit 0, "no violations found".
 */
const TS7_INERT: CruiseResult = {
  modules: [{ source: "packages/docs/astro.config.mjs", dependencies: [] }],
  violations: [],
  rules: RULES,
  environmentIssues: [
    {
      name: "missing-typescript-transpiler",
      description:
        "dependency-cruiser detected a TypeScript environment,\r\n    but not a compatible TypeScript compiler",
    },
  ],
  typescript: null,
};

const CLI_IMPORTS_GATEWAY: CruiseViolation = {
  ruleName: "cli-no-import-gateway",
  severity: "error",
  from: "packages/cli/src/main.ts",
  to: "packages/gateway/src/engine.ts",
  cycle: [],
};

const ADVISORY_WARNING: CruiseViolation = {
  ruleName: "advisory",
  severity: "warn",
  from: "packages/gateway/src/engine.ts",
  to: "packages/gateway/src/platform/index.ts",
  cycle: [],
};

/** How the audit prints those two: the error with its rule's comment, the warning without one. */
const CLI_IMPORTS_GATEWAY_LINE =
  "  error cli-no-import-gateway: packages/cli/src/main.ts → packages/gateway/src/engine.ts\n      CLI talks IPC.";
const ADVISORY_WARNING_LINE =
  "  warn advisory: packages/gateway/src/engine.ts → packages/gateway/src/platform/index.ts";

describe("assessCruise", () => {
  test("passes a cruise that read every required file and resolved its imports", () => {
    // RULES includes `no-circular`, whose sides carry no path: it is not a liveness subject, and
    // judging it one would fail this.
    const verdict = assessCruise(healthy(), REQUIRED);
    expect(verdict).toEqual({
      violations: [],
      warnings: [],
      inert: [],
      summary: `4 modules, 4 dependencies cruised with ${TS6}; 4/4 required sources covered; 3 rules`,
    });
  });

  test("fails the inert cruise TypeScript 7 produced, for every reason it was inert", () => {
    const verdict = assessCruise(TS7_INERT, REQUIRED);
    expect(verdict.violations).toEqual([]);
    expect(verdict.inert).toHaveLength(4);
    const [issue, compiler, coverage, edges] = verdict.inert;
    expect(issue).toBe(
      "dependency-cruiser reported 'missing-typescript-transpiler': dependency-cruiser detected a TypeScript environment, but not a compatible TypeScript compiler",
    );
    expect(compiler).toContain("found no usable TypeScript compiler");
    expect(coverage).toContain("4 of 4 required source files");
    expect(edges).toContain("only 0 resolved dependencies across 1 modules");
    // Every path-scoped rule LOOKS dead on an empty cruise. Reporting that would advise deleting
    // healthy rules, so liveness waits for a cruise that is otherwise complete.
    expect(verdict.inert.join("\n")).not.toContain("can never fire");
    expect(verdict.summary).toContain("with NO TypeScript compiler; 0/4 required sources covered");
  });

  test("an environment issue alone fails a cruise that otherwise looks complete", () => {
    const verdict = assessCruise(
      healthy({ environmentIssues: [{ name: "missing-swc-transpiler", description: "" }] }),
      REQUIRED,
    );
    expect(verdict.inert).toEqual(["dependency-cruiser reported 'missing-swc-transpiler': "]);
  });

  test("one required file the cruise never read fails, and is named", () => {
    const cruise = healthy();
    const verdict = assessCruise(
      { ...cruise, modules: cruise.modules.filter((m) => m.source !== REQUIRED[1]) },
      REQUIRED,
    );
    expect(verdict.inert).toHaveLength(1);
    expect(verdict.inert[0]).toContain("1 of 4 required source files");
    expect(verdict.inert[0]).toContain(
      `were never cruised, so no rule could fire on them: ${REQUIRED[1]}`,
    );
  });

  test("an empty required set fails instead of passing vacuously", () => {
    const verdict = assessCruise(healthy(), []);
    expect(verdict.inert).toHaveLength(1);
    expect(verdict.inert[0]).toContain("found no source files matching");
  });

  test("fewer resolved dependencies than modules fails, and unresolved ones do not count", () => {
    const cruise = healthy();
    const [first, ...rest] = cruise.modules;
    if (first === undefined) throw new Error("fixture has no modules");
    const unresolved = {
      ...first,
      dependencies: [{ resolved: "./gone.ts", couldNotResolve: true }],
    };
    const verdict = assessCruise({ ...cruise, modules: [unresolved, ...rest] }, REQUIRED);
    expect(verdict.inert).toHaveLength(1);
    expect(verdict.inert[0]).toContain("only 3 resolved dependencies across 4 modules");
  });

  test("a rule whose from-side matches no module can never fire", () => {
    const dead: ForbiddenRule = {
      name: "mcp-connectors-only-import-sdk",
      comment: null,
      from: { path: "^packages/mcp-connectors/[^/]+/src", pathNot: null },
      to: { path: "^packages/(gateway|cli|ui)/", pathNot: null },
    };
    const verdict = assessCruise(healthy({ rules: [...RULES, dead] }), REQUIRED);
    expect(verdict.inert).toEqual([
      "rule 'mcp-connectors-only-import-sdk' can never fire: no cruised module matches its from.path /^packages/mcp-connectors/[^/]+/src/. Fix the path, or delete a rule whose subject no longer exists.",
    ]);
  });

  test("a rule whose to-side matches no module can never fire", () => {
    const dead: ForbiddenRule = {
      name: "renamed-target",
      comment: null,
      from: { path: "^packages/gateway/src/", pathNot: null },
      to: { path: "^packages/gateway/src/platform/win32/index\\.ts$", pathNot: null },
    };
    const verdict = assessCruise(healthy({ rules: [...RULES, dead] }), REQUIRED);
    expect(verdict.inert).toHaveLength(1);
    expect(verdict.inert[0]).toContain("rule 'renamed-target' can never fire");
    expect(verdict.inert[0]).toContain("its to.path");
  });

  test("pathNot is honoured: a side whose only matches it excludes is dead", () => {
    const dead: ForbiddenRule = {
      name: "self-excluding",
      comment: null,
      from: {
        path: "^packages/gateway/src/platform/index\\.ts$",
        pathNot: "/platform/index\\.ts$",
      },
      to: NO_PATH,
    };
    const verdict = assessCruise(healthy({ rules: [...RULES, dead] }), REQUIRED);
    expect(verdict.inert).toHaveLength(1);
    expect(verdict.inert[0]).toContain("rule 'self-excluding' can never fire");
    expect(verdict.inert[0]).toContain("(minus pathNot //platform/index\\.ts$/)");
  });

  test("a cruise that loaded no rules fails, since nothing could have fired", () => {
    const verdict = assessCruise(healthy({ rules: [] }), REQUIRED);
    expect(verdict.inert).toHaveLength(1);
    expect(verdict.inert[0]).toContain("loaded no forbidden rules");
  });

  test("error-severity violations fail with the rule comment; other severities only warn", () => {
    const verdict = assessCruise(
      healthy({ violations: [CLI_IMPORTS_GATEWAY, ADVISORY_WARNING] }),
      REQUIRED,
    );
    expect(verdict.violations).toEqual([CLI_IMPORTS_GATEWAY_LINE]);
    expect(verdict.warnings).toEqual([ADVISORY_WARNING_LINE]);
    expect(verdict.inert).toEqual([]);
  });
});

describe("decide: the exit code CI reads", () => {
  const ran = (result: CruiseResult, stderr = ""): CruiseRun => ({ ok: true, result, stderr });

  test("a healthy cruise exits 0 with one OK line and nothing on stderr", () => {
    expect(decide(ran(healthy()), REQUIRED)).toEqual({
      exitCode: 0,
      stdout: [HEALTHY_OK],
      stderr: [],
    });
  });

  test("an inert cruise exits 1, prints no OK, and gives every reason", () => {
    // The regression this gate exists to stop is exactly this: every reason printed, exit 0.
    const reasons = assessCruise(TS7_INERT, REQUIRED).inert;
    expect(reasons).toHaveLength(4);
    expect(decide(ran(TS7_INERT), REQUIRED)).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: [
        "audit:boundaries: the cruise did not check the code it guards, so it cannot pass:",
        ...reasons.map((reason) => `  - ${reason}`),
        "audit:boundaries: 1 modules, 0 dependencies cruised with NO TypeScript compiler; 0/4 required sources covered; 3 rules",
      ],
    });
  });

  test("an error-severity violation exits 1 and names it", () => {
    expect(decide(ran(healthy({ violations: [CLI_IMPORTS_GATEWAY] })), REQUIRED)).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: [
        "audit:boundaries: 1 boundary violation(s):",
        CLI_IMPORTS_GATEWAY_LINE,
        `audit:boundaries: 4 modules, 4 dependencies cruised with ${TS6}; 4/4 required sources covered; 3 rules`,
      ],
    });
  });

  test("warnings alone exit 0, printed after dependency-cruiser's own stderr", () => {
    const run = ran(
      healthy({ violations: [ADVISORY_WARNING] }),
      "a notice from dependency-cruiser",
    );
    expect(decide(run, REQUIRED)).toEqual({
      exitCode: 0,
      stdout: [HEALTHY_OK],
      stderr: ["a notice from dependency-cruiser", ADVISORY_WARNING_LINE],
    });
  });

  test("a run that produced no result exits 1 with its error", () => {
    expect(decide({ ok: false, error: "dependency-cruiser exited 2: boom" }, REQUIRED)).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: ["audit:boundaries: dependency-cruiser exited 2: boom"],
    });
  });
});

describe("auditBoundaries: one checkout, start to finish", () => {
  let root: string;

  beforeEach(() => {
    // A checkout whose sources are exactly REQUIRED, so `healthy()` is a cruise of all of it.
    root = mkdtempSync(join(tmpdir(), "boundaries-audit-"));
    for (const rel of REQUIRED) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, "export {};\n");
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("cruises the checkout it is given and passes a cruise that read all of it", () => {
    const calls: Array<readonly [string, CruiseInvocation]> = [];
    const outcome = auditBoundaries(root, (repoRoot, invocation) => {
      calls.push([repoRoot, invocation]);
      return { ok: true, result: healthy(), stderr: "" };
    });
    expect(calls).toEqual([[root, repoInvocation(root)]]);
    expect(outcome).toEqual({ exitCode: 0, stdout: [HEALTHY_OK], stderr: [] });
  });

  test("judges coverage against every source in that checkout, so a skipped one fails", () => {
    // The LAST source in sorted order: judging only a prefix of the set cannot fail this.
    const skipped = REQUIRED.at(-1);
    const cruise = healthy();
    const outcome = auditBoundaries(root, () => ({
      ok: true,
      result: { ...cruise, modules: cruise.modules.filter((m) => m.source !== skipped) },
      stderr: "",
    }));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toEqual([]);
    expect(outcome.stderr).toContain(
      `  - 1 of 4 required source files (${REQUIRED_SOURCES_GLOB}, non-test) were never cruised, so no rule could fire on them: ${skipped}`,
    );
  });
});

describe("the check-boundaries.ts script itself, with a canned cruise", () => {
  // Its `import.meta.main` block only prints and exits, and these run that REAL block to both exit
  // codes over the real checkout's sources. A preload replaces Bun.spawnSync in the script's own
  // process, never this one, so its cruise returns cruise.json instead of running dependency-cruiser.
  // The stand-in also returns a marker as the cruise's stderr, which the script forwards: a run that
  // did not go through it fails these on the marker, rather than passing for some other reason.
  const SCRIPT = join(import.meta.dir, "check-boundaries.ts");
  const MARKER = "canned cruise: served by the test preload; dependency-cruiser did not run";
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "boundaries-script-"));
    writeFileSync(
      join(dir, "canned-cruise.mjs"),
      `import { readFileSync } from "node:fs";
const stdout = readFileSync(new URL("./cruise.json", import.meta.url));
Bun.spawnSync = () => ({ exitCode: 0, stdout, stderr: Buffer.from(${JSON.stringify(MARKER)}) });
`,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** dependency-cruiser's raw JSON, as `runCruise` parses it, under two live rules. */
  function rawCruise(modules: readonly unknown[], environment: Record<string, unknown>): unknown {
    return {
      modules,
      summary: {
        violations: [],
        ruleSetUsed: {
          forbidden: [
            { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
            {
              name: "cli-no-import-gateway",
              severity: "error",
              from: { path: "^packages/cli/src" },
              to: { path: "^packages/gateway/src" },
            },
          ],
        },
        environment,
      },
    };
  }

  function runScript(cruise: unknown): { exitCode: number | null; stdout: string; stderr: string } {
    writeFileSync(join(dir, "cruise.json"), JSON.stringify(cruise));
    const preload = join(dir, "canned-cruise.mjs");
    const proc = Bun.spawnSync([process.execPath, "--preload", preload, SCRIPT], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  }

  test("an inert cruise exits 1 and prints no OK", () => {
    const n = requiredSourceFiles(REPO_ROOT).length;
    const run = runScript(
      rawCruise([{ source: "packages/docs/astro.config.mjs", dependencies: [] }], {
        transpilersFound: [{ name: "typescript", available: false, currentVersion: "-" }],
        issues: [{ severity: "warn", name: "missing-typescript-transpiler", description: "none" }],
      }),
    );
    expect(run.stderr).toContain(MARKER);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("the cruise did not check the code it guards, so it cannot pass:");
    expect(run.stderr).toContain(`${n} of ${n} required source files`);
  }, 60_000);

  test("a cruise that read every real source exits 0 with the OK line", () => {
    const required = requiredSourceFiles(REPO_ROOT);
    const n = required.length;
    const modules = required.map((source, i) => ({
      source,
      dependencies: [{ resolved: required[(i + 1) % n] ?? source, couldNotResolve: false }],
    }));
    const run = runScript(
      rawCruise(modules, {
        transpilersFound: [{ name: "typescript", available: true, currentVersion: TS6 }],
      }),
    );
    expect(run.stderr).toContain(MARKER);
    expect(run.stdout).toBe(
      `audit:boundaries: OK (${n} modules, ${n} dependencies cruised with ${TS6}; ${n}/${n} required sources covered; 2 rules)\n`,
    );
    expect(run.exitCode).toBe(0);
  }, 60_000);
});

describe("formatViolation", () => {
  test("a cycle prints the whole loop back to where it started", () => {
    expect(
      formatViolation(
        {
          ruleName: "no-circular",
          severity: "error",
          from: "a.ts",
          to: "b.ts",
          cycle: ["b.ts", "c.ts", "a.ts"],
        },
        null,
      ),
    ).toBe("  error no-circular: a.ts → b.ts → c.ts → a.ts");
  });
});

describe("parseCruiseResult", () => {
  /** The fields dependency-cruiser 18's `--output-type json` actually emits, trimmed. */
  function rawResult(environment: Record<string, unknown>): Record<string, unknown> {
    return {
      modules: [
        {
          source: "packages/gateway/src/a.ts",
          dependencies: [
            { module: "./b.ts", resolved: "packages/gateway/src/b.ts", couldNotResolve: false },
            { module: "./gone", resolved: "./gone", couldNotResolve: true },
          ],
        },
        { source: "packages/gateway/src/b.ts", dependencies: [] },
      ],
      summary: {
        violations: [
          {
            type: "cycle",
            from: "packages/gateway/src/a.ts",
            to: "packages/gateway/src/b.ts",
            rule: { severity: "error", name: "no-circular" },
            cycle: [
              { name: "packages/gateway/src/b.ts", dependencyTypes: ["local"] },
              { name: "packages/gateway/src/a.ts", dependencyTypes: ["local"] },
            ],
          },
        ],
        totalCruised: 2,
        ruleSetUsed: {
          forbidden: [
            { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
            {
              name: "pal-isolation",
              severity: "error",
              comment: "PAL.",
              from: { path: "^packages/gateway/src/", pathNot: "index\\.ts$|/test/" },
              to: { path: "win32\\.ts$" },
            },
          ],
        },
        environment,
      },
    };
  }

  test("reads exactly the fields the audit judges", () => {
    const result = parseCruiseResult(
      rawResult({
        transpilersFound: [
          { name: "javascript", available: true, currentVersion: "acorn@8.18.0" },
          { name: "typescript", available: true, currentVersion: "typescript@6.0.3" },
        ],
      }),
    );
    expect(result).toEqual({
      modules: [
        {
          source: "packages/gateway/src/a.ts",
          dependencies: [
            { resolved: "packages/gateway/src/b.ts", couldNotResolve: false },
            { resolved: "./gone", couldNotResolve: true },
          ],
        },
        { source: "packages/gateway/src/b.ts", dependencies: [] },
      ],
      violations: [
        {
          ruleName: "no-circular",
          severity: "error",
          from: "packages/gateway/src/a.ts",
          to: "packages/gateway/src/b.ts",
          cycle: ["packages/gateway/src/b.ts", "packages/gateway/src/a.ts"],
        },
      ],
      rules: [
        { name: "no-circular", comment: null, from: NO_PATH, to: NO_PATH },
        {
          name: "pal-isolation",
          comment: "PAL.",
          from: { path: "^packages/gateway/src/", pathNot: "index\\.ts$|/test/" },
          to: { path: "win32\\.ts$", pathNot: null },
        },
      ],
      environmentIssues: [],
      typescript: TS6,
    });
  });

  test("an unavailable TypeScript transpiler, and its issue, are carried through", () => {
    const result = parseCruiseResult(
      rawResult({
        transpilersFound: [{ name: "typescript", available: false, currentVersion: "-" }],
        issues: [{ severity: "warn", name: "missing-typescript-transpiler", description: "d" }],
      }),
    );
    expect(result.typescript).toBeNull();
    expect(result.environmentIssues).toEqual([
      { name: "missing-typescript-transpiler", description: "d" },
    ]);
  });

  test("output it cannot read is rejected, never guessed at", () => {
    expect(() => parseCruiseResult([])).toThrow(CruiseOutputError);
    expect(() => parseCruiseResult({ modules: [] })).toThrow("result.summary is not an object");
    // dependency-cruiser reports the transpilers it found; a result without that list cannot say
    // whether TypeScript was parsed at all.
    expect(() => parseCruiseResult(rawResult({}))).toThrow(
      "summary.environment.transpilersFound is not an array",
    );
    const noSource = rawResult({ transpilersFound: [] });
    noSource["modules"] = [{ dependencies: [] }];
    expect(() => parseCruiseResult(noSource)).toThrow("modules[0].source is not a string");
  });
});

describe("requiredSourceFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "boundaries-required-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function touch(rel: string): void {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "export {};\n");
  }

  test("is the non-test TypeScript under gateway, cli and ui src, and nothing else", () => {
    for (const rel of [
      "packages/gateway/src/a.ts",
      "packages/gateway/src/deep/b.tsx",
      "packages/gateway/src/types.d.ts",
      "packages/gateway/src/a.test.ts",
      "packages/gateway/src/c.test.tsx",
      "packages/gateway/src/__fixtures__/sample.ts",
      "packages/gateway/src/notes.md",
      "packages/gateway/test/helper.ts",
      "packages/cli/src/main.ts",
      "packages/ui/src/App.tsx",
      "packages/docs/src/site.ts",
      "packages/admin-console/src/console.ts",
    ]) {
      touch(rel);
    }
    expect(requiredSourceFiles(root)).toEqual([
      "packages/cli/src/main.ts",
      "packages/gateway/src/a.ts",
      "packages/gateway/src/deep/b.tsx",
      "packages/gateway/src/types.d.ts",
      "packages/ui/src/App.tsx",
    ]);
  });
});

describe("cruiseArgv", () => {
  test("runs the dependency-cruiser CLI under the TypeScript 6 preload, in JSON mode", () => {
    const argv = cruiseArgv(REPO_ROOT, repoInvocation(REPO_ROOT));
    expect(argv.slice(0, 4)).toEqual([
      process.execPath,
      "--preload",
      PRELOAD_PATH,
      dependencyCruiserBin(REPO_ROOT),
    ]);
    expect(argv.slice(4)).toEqual([
      "--config",
      ".dependency-cruiser.cjs",
      "--no-progress",
      "--output-type",
      "json",
      "packages",
    ]);
  });

  test("refuses when dependency-cruiser is not installed", () => {
    const empty = mkdtempSync(join(tmpdir(), "boundaries-no-depcruise-"));
    try {
      expect(() => cruiseArgv(empty, repoInvocation(empty))).toThrow("is not installed");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

test("`audit:boundaries` runs this wrapper, never a bare dependency-cruiser", () => {
  // A bare `bunx dependency-cruiser` is exactly the invocation that went inert, and nothing
  // downstream can tell: it exits 0 either way.
  const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const scripts =
    typeof pkg === "object" && pkg !== null && "scripts" in pkg ? pkg.scripts : undefined;
  const script =
    typeof scripts === "object" && scripts !== null && "audit:boundaries" in scripts
      ? scripts["audit:boundaries"]
      : undefined;
  expect(script).toBe("bun scripts/structure-audit/check-boundaries.ts");
});

describe("dependency-cruiser-ts6-preload", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "boundaries-preload-"));
    // A typescript@7 exactly where node resolution from `dir` finds it. That is the situation
    // bun's isolated linker sometimes creates for dependency-cruiser, made deterministic here.
    const fakeTs7 = join(dir, "node_modules", "typescript");
    mkdirSync(fakeTs7, { recursive: true });
    writeFileSync(
      join(fakeTs7, "package.json"),
      JSON.stringify({ name: "typescript", version: "7.0.2", main: "index.js" }),
    );
    writeFileSync(join(fakeTs7, "index.js"), 'module.exports = { version: "7.0.2" };\n');
    // The three lookups dependency-cruiser makes: the manifest for its version gate,
    // `require.resolve` for whether it scans .ts/.tsx files at all (any truthy answer will do, so
    // the probe asks only whether it is the planted 7), and the module itself, i.e. the compiler.
    writeFileSync(
      join(dir, "probe.mjs"),
      `import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const manifest = require("typescript/package.json");
const planted = realpathSync(fileURLToPath(new URL("./node_modules/typescript/index.js", import.meta.url)));
let resolve;
try {
  const found = require.resolve("typescript");
  resolve = existsSync(found) && realpathSync(found) === planted ? "the planted typescript@7" : "not the planted typescript@7";
} catch {
  resolve = "threw";
}
const loaded = await import("typescript");
const ts = loaded.default ?? loaded;
console.log(JSON.stringify({ manifest: manifest.version, resolve, module: ts.version, transpileModule: typeof ts.transpileModule }));
`,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function probe(preload: readonly string[]): unknown {
    const proc = Bun.spawnSync([process.execPath, ...preload, join(dir, "probe.mjs")], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    if (proc.exitCode !== 0) throw new Error(`probe exited ${proc.exitCode}: ${proc.stderr}`);
    return JSON.parse(proc.stdout.toString());
  }

  test("answers all three typescript lookups with the alias, even where typescript@7 is installed", () => {
    // Negative control: without the preload the installed 7 wins all three lookups. That is the
    // inert case, and it shows the probe can tell the two apart.
    expect(probe([])).toEqual({
      manifest: "7.0.2",
      resolve: "the planted typescript@7",
      module: "7.0.2",
      transpileModule: "undefined",
    });
    expect(probe(["--preload", PRELOAD_PATH])).toEqual({
      manifest: aliasVersion(),
      resolve: "not the planted typescript@7",
      module: aliasVersion(),
      transpileModule: "function",
    });
  }, 60_000);
});

describe("runCruise: the real dependency-cruiser, under the preload", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "boundaries-cruise-"));
    const files: Record<string, string> = {
      ".dependency-cruiser.cjs": `module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", comment: "No cycles.", from: {}, to: { circular: true } },
    {
      name: "cli-no-import-gateway",
      severity: "error",
      comment: "CLI talks IPC.",
      from: { path: "^src/cli" },
      to: { path: "^src/gateway" },
    },
  ],
  options: { doNotFollow: { path: "node_modules" }, includeOnly: "^src/" },
};
`,
      // A value cycle, a forbidden cross-"package" import, and one edge per module.
      "src/a.ts": 'import { b } from "./b.ts";\nexport const a = (): number => b + 1;\n',
      "src/b.ts":
        'import { a } from "./a.ts";\nexport const b = 1;\nexport const viaA = (): number => a();\n',
      "src/cli/x.ts": 'import { y } from "../gateway/y.ts";\nexport const x: number = y;\n',
      "src/gateway/y.ts": 'import { b } from "../b.ts";\nexport const y: number = b;\n',
    };
    for (const [rel, body] of Object.entries(files)) {
      const full = join(fixture, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  test("parses TypeScript with the alias's compiler and reports the cycle and the forbidden import", () => {
    const run = runCruise(REPO_ROOT, {
      cwd: fixture,
      config: ".dependency-cruiser.cjs",
      targets: ["src"],
    });
    if (!run.ok) throw new Error(run.error);

    // dependency-cruiser must report the alias's compiler. On a checkout where bun happened to
    // link typescript@6 for it, this would also hold WITHOUT the preload. The preload test above
    // is the one that cannot pass by luck.
    expect(run.result.typescript).toBe(`typescript@${aliasVersion()}`);
    expect(run.result.environmentIssues).toEqual([]);

    const required = ["src/a.ts", "src/b.ts", "src/cli/x.ts", "src/gateway/y.ts"];
    expect(run.result.modules.map((m) => m.source).sort()).toEqual(required);

    const verdict = assessCruise(run.result, required);
    expect(verdict.inert).toEqual([]);
    expect([...verdict.violations].sort()).toEqual([
      "  error cli-no-import-gateway: src/cli/x.ts → src/gateway/y.ts\n      CLI talks IPC.",
      "  error no-circular: src/a.ts → src/b.ts → src/a.ts\n      No cycles.",
    ]);
  }, 60_000);
});
