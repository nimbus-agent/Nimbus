import { describe, expect, test } from "bun:test";

import { findUnhiddenSpawns } from "./check-windows-console-hide.ts";

const F = "packages/gateway/src/x.ts";

describe("findUnhiddenSpawns", () => {
  test("flags a Bun.spawn call whose options omit windowsHide", () => {
    const src = `const p = Bun.spawn(["git", "log"], { stdout: "pipe" });`;
    const issues = findUnhiddenSpawns(src, F);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.line).toBe(1);
    expect(issues[0]?.callee).toBe("Bun.spawn");
  });

  test("accepts a Bun.spawn call that passes windowsHide", () => {
    const src = `const p = Bun.spawn(["git", "log"], { stdout: "pipe", windowsHide: true });`;
    expect(findUnhiddenSpawns(src, F)).toEqual([]);
  });

  test("flags a bare spawn() in a file importing node:child_process", () => {
    const src = [
      `import { spawn } from "node:child_process";`,
      `const c = spawn(cmd, args, { stdio: "ignore" });`,
    ].join("\n");
    const issues = findUnhiddenSpawns(src, F);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.line).toBe(2);
  });

  test("flags a bare spawn() reached through an injected `typeof Bun.spawn`", () => {
    const src = [
      `type SpawnFn = typeof Bun.spawn;`,
      `function run(spawn: SpawnFn) {`,
      `  return spawn(["git"], { stdout: "pipe" });`,
      `}`,
    ].join("\n");
    const issues = findUnhiddenSpawns(src, F);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.line).toBe(3);
  });

  test("ignores a bare spawn() in a file with no process-spawn import or injection type", () => {
    // `teamvault/connector-session.ts` calls a local `spawn(req)` that starts an MCP client,
    // not a process. Name alone must never be enough to flag.
    const src = [
      `const spawn = spawnOverride ?? realSpawn;`,
      `const client = await spawn(req);`,
    ].join("\n");
    expect(findUnhiddenSpawns(src, F)).toEqual([]);
  });

  test("ignores a member call that is not Bun.spawn", () => {
    // `runner.spawn(...)` is indirection through SandboxRunner; the real spawn is in the
    // runner implementation, which this guard checks there.
    const src = [
      `import { spawn } from "node:child_process";`,
      `const c = runner.spawn(cmd, args, opts);`,
    ].join("\n");
    expect(findUnhiddenSpawns(src, F)).toEqual([]);
  });

  test("ignores a method DECLARATION named spawn", () => {
    const src = [
      `import { spawn } from "node:child_process";`,
      `export interface SandboxRunner {`,
      `  spawn(cmd: string, args: string[], opts: SandboxSpawnOptions): ChildProcess;`,
      `}`,
    ].join("\n");
    expect(findUnhiddenSpawns(src, F)).toEqual([]);
  });

  test("ignores a spawn mentioned only inside a comment", () => {
    const src = [
      `import { spawn } from "node:child_process";`,
      `// What Bun.spawn({stderr:"pipe"}) actually gives is a byte stream.`,
      `const c = spawn(cmd, args, { windowsHide: true });`,
    ].join("\n");
    expect(findUnhiddenSpawns(src, F)).toEqual([]);
  });

  test("ignores a spawn mentioned only inside a string literal", () => {
    const src = `const help = "run Bun.spawn(x) yourself";`;
    expect(findUnhiddenSpawns(src, F)).toEqual([]);
  });

  test("matches windowsHide across a multi-line options object", () => {
    const src = [
      `const p = Bun.spawn(args, {`,
      `  stdout: "pipe",`,
      `  windowsHide: true,`,
      `});`,
    ].join("\n");
    expect(findUnhiddenSpawns(src, F)).toEqual([]);
  });

  test("reports the line of the call, not of the closing paren", () => {
    const src = [`const p = Bun.spawn(args, {`, `  stdout: "pipe",`, `});`].join("\n");
    const issues = findUnhiddenSpawns(src, F);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.line).toBe(1);
  });

  test("a windowsHide belonging to a LATER call does not excuse an earlier one", () => {
    // Paren-matching per occurrence is what makes this fail; a file-level `includes` would pass it.
    const src = [
      `const a = Bun.spawn(x, { stdout: "pipe" });`,
      `const b = Bun.spawn(y, { windowsHide: true });`,
    ].join("\n");
    const issues = findUnhiddenSpawns(src, F);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.line).toBe(1);
  });

  test("a nested inner call's windowsHide does not excuse the outer call", () => {
    // The flag must sit in THIS call's own argument list. Counted at relative paren depth 0,
    // so a `windowsHide` buried in an argument's own call does not satisfy the outer one.
    const src = `const a = Bun.spawn(pick({ windowsHide: true }));`;
    expect(findUnhiddenSpawns(src, F)).toHaveLength(1);
  });

  test("suppresses with a same-line `// windows-console-ok` marker", () => {
    const src = `const p = Bun.spawn(a, { stdout: "pipe" }); // windows-console-ok: no console child`;
    expect(findUnhiddenSpawns(src, F)).toEqual([]);
  });

  test("suppresses with a `// windows-console-ok` marker on the preceding line", () => {
    const src = [
      `// windows-console-ok: launches a GUI app`,
      `const p = Bun.spawn(a, { stdout: "pipe" });`,
    ].join("\n");
    expect(findUnhiddenSpawns(src, F)).toEqual([]);
  });

  test("an unterminated call is reported rather than silently skipped", () => {
    // Fail-closed: a paren-match that runs off the end must not read as 'no issue found'.
    const src = `const p = Bun.spawn(args, { stdout: "pipe"`;
    expect(findUnhiddenSpawns(src, F)).toHaveLength(1);
  });
});
