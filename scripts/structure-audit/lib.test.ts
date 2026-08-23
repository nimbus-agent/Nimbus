import { describe, expect, test } from "bun:test";
import { iterateSourceFiles, REPO_ROOT, stripComments } from "./lib.ts";

describe("iterateSourceFiles", () => {
  // Collected once: the walk reads every production source file in the monorepo, so doing it
  // per-test would multiply the slowest part of this file by the number of assertions.
  const visited: string[] = [];
  const collected = (async (): Promise<void> => {
    for await (const f of iterateSourceFiles()) visited.push(f.relPath);
  })();

  test("visits the production source tree at all", async () => {
    await collected;
    // The floor the exclusion test below needs to mean anything. `expect(testingPaths)
    // .toEqual([])` is satisfied just as well by visiting NOTHING, and this generator is the
    // single source of files for every D10-D22 rule in check-nimbus-invariants.ts — so a walk
    // that silently stopped matching would leave those rules scanning an empty set and
    // reporting clean. That is not hypothetical: pointing the package glob at a directory
    // that does not exist still yields ~179 files from the mcp-connectors glob, which is why
    // the auditor's own floor keys on specific files rather than a count.
    expect(visited.length).toBeGreaterThan(500);
    expect(visited).toContain("packages/gateway/src/engine/executor.ts");
  });

  test("excludes paths under */testing/*", async () => {
    await collected;
    const testingPaths = visited.filter((p) => p.includes("/testing/"));
    expect(testingPaths).toEqual([]);
  });

  test("the */testing/* exclusion is actually doing work", async () => {
    await collected;
    // Guard the guard from the other side: if no such directory existed, the exclusion test
    // above would pass without the exclusion being written at all. Five exist today
    // (gateway/src/testing, gateway/src/identity/testing, gateway/src/updater/testing,
    // cli/src/commands/testing, cli/src/tui/testing), and each holds test-only scaffolding
    // that no production module imports.
    const glob = new Bun.Glob("packages/*/src/**/testing/**/*.ts");
    const onDisk: string[] = [];
    // REPO_ROOT, not `new URL(...).pathname` — a pathname is percent-encoded and carries a
    // leading slash on Windows, so it names a directory that is not there and the scan throws
    // ENOENT. lib.ts derives REPO_ROOT from import.meta.dir for exactly this reason.
    for await (const p of glob.scan({ cwd: REPO_ROOT })) {
      onDisk.push(p);
    }
    expect(onDisk.length).toBeGreaterThan(0);
  });

  test("excludes test files, declarations and fixtures", async () => {
    await collected;
    expect(visited.filter((p) => p.endsWith(".test.ts"))).toEqual([]);
    expect(visited.filter((p) => p.endsWith(".d.ts"))).toEqual([]);
    expect(visited.filter((p) => p.includes("/__fixtures__/"))).toEqual([]);
  });
});

describe("stripComments — known regex-literal limitation", () => {
  // PINS the documented limitation rather than asserting it is desirable. If someone teaches
  // stripComments about regex literals, this test fails — that is the point: it is the tripwire
  // telling them to delete this block and the KNOWN LIMITATION note in lib.ts along with it.
  test("a quote inside a regex literal opens a phantom string, so later comments survive", () => {
    const src = 'const RE = /(["|]) /;\n/** marker */\nconst a = 1;\n';
    expect(stripComments(src)).toContain("marker");
  });

  test("without the regex, the same comment is stripped", () => {
    expect(stripComments("const RE = 1;\n/** marker */\nconst a = 1;\n")).not.toContain("marker");
  });
});
