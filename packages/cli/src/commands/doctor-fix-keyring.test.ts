import { describe, expect, test } from "bun:test";

import type { DoctorVaultExec } from "./doctor-core.ts";
import { type FixKeyringDeps, fixKeyring, runFixKeyringCommand } from "./doctor-fix-keyring.ts";

function makeExec(overrides: Partial<DoctorVaultExec> = {}): DoctorVaultExec {
  return {
    findSecretTool: () => "/usr/bin/secret-tool",
    lookupStderr: () => "",
    hasBinary: () => true,
    runQuery: () => ({ code: 0, stdout: "", stderr: "" }),
    ...overrides,
  };
}

function deps(overrides: Partial<FixKeyringDeps> = {}): FixKeyringDeps {
  return {
    exec: makeExec(),
    homeDir: () => "/home/tester",
    statMode: () => null, // nothing exists yet
    mkdirMode: () => {},
    writeFileMode: () => {},
    ...overrides,
  };
}

describe("fixKeyring", () => {
  test("refuses to touch an existing keyring", () => {
    const created: string[] = [];
    const result = fixKeyring(
      deps({
        statMode: (p) => (p.endsWith("login.keyring") ? 0o600 : 0o700),
        writeFileMode: (p) => {
          created.push(p);
        },
      }),
      { dryRun: false },
    );
    expect(result.exit).not.toBe(0);
    expect(result.lines.join("\n")).toMatch(/already exists/i);
    // The whole point: destroying this file would lose every stored credential.
    expect(created).toEqual([]);
  });

  test("refuses without calling mkdirMode or the exec seam", () => {
    let mkdirCalls = 0;
    let queryCalls = 0;
    fixKeyring(
      deps({
        statMode: (p) => (p.endsWith("login.keyring") ? 0o600 : null),
        mkdirMode: () => {
          mkdirCalls += 1;
        },
        exec: makeExec({
          runQuery: () => {
            queryCalls += 1;
            return { code: 0, stdout: "", stderr: "" };
          },
        }),
      }),
      { dryRun: false },
    );
    expect(mkdirCalls).toBe(0);
    expect(queryCalls).toBe(0);
  });

  test("dry run writes nothing but reports the plan", () => {
    const writes: string[] = [];
    const result = fixKeyring(
      deps({
        mkdirMode: (p) => {
          writes.push(p);
        },
        writeFileMode: (p) => {
          writes.push(p);
        },
      }),
      { dryRun: true },
    );
    expect(writes).toEqual([]);
    expect(result.lines.join("\n")).toMatch(/0700/);
    expect(result.exit).toBe(0);
  });

  test("creates the directory at 0700 and files at 0600", () => {
    const modes = new Map<string, number>();
    fixKeyring(
      deps({
        mkdirMode: (p, m) => modes.set(p, m),
        writeFileMode: (p, _d, m) => modes.set(p, m),
      }),
      { dryRun: false },
    );
    const dir = [...modes.entries()].find(([p]) => p.endsWith("keyrings"));
    expect(dir?.[1]).toBe(0o700);
    for (const [p, m] of modes) if (!p.endsWith("keyrings")) expect(m).toBe(0o600);
  });

  test("succeeds when the store+lookup round-trip verifies", () => {
    const result = fixKeyring(
      deps({
        exec: makeExec({
          runQuery: (cmd) => {
            expect(cmd[0]).toBe("dbus-run-session");
            return { code: 0, stdout: "nimbus-fix-keyring-check-ok\n", stderr: "" };
          },
        }),
      }),
      { dryRun: false },
    );
    expect(result.exit).toBe(0);
    expect(result.lines.join("\n")).toMatch(/verified/i);
  });

  test("fails when the round-trip does not return the expected marker", () => {
    const result = fixKeyring(
      deps({
        exec: makeExec({
          runQuery: () => ({ code: 0, stdout: "", stderr: "" }),
        }),
      }),
      { dryRun: false },
    );
    expect(result.exit).not.toBe(0);
    expect(result.lines.join("\n")).toMatch(/did not verify/i);
  });

  test("fails when the underlying command exits non-zero", () => {
    const result = fixKeyring(
      deps({
        exec: makeExec({
          runQuery: () => ({ code: 1, stdout: "", stderr: "gcr-prompter: cannot open display" }),
        }),
      }),
      { dryRun: false },
    );
    expect(result.exit).not.toBe(0);
    expect(result.lines.join("\n")).toContain("cannot open display");
  });

  test("fails with a helpful hint when dbus-run-session or secret-tool is missing", () => {
    const result = fixKeyring(
      deps({
        exec: makeExec({ hasBinary: () => false }),
      }),
      { dryRun: false },
    );
    expect(result.exit).not.toBe(0);
    expect(result.lines.join("\n")).toMatch(/dbus-x11|libsecret-tools/i);
  });
});

describe("runFixKeyringCommand", () => {
  test("reports not-applicable on macOS without touching any deps", () => {
    let touched = false;
    const result = runFixKeyringCommand(
      "darwin",
      deps({
        statMode: () => {
          touched = true;
          return null;
        },
      }),
      { dryRun: false },
    );
    expect(result.exit).toBe(0);
    expect(result.lines.join("\n")).toMatch(/not applicable/i);
    expect(touched).toBe(false);
  });

  test("reports not-applicable on Windows without touching any deps", () => {
    let touched = false;
    const result = runFixKeyringCommand(
      "win32",
      deps({
        statMode: () => {
          touched = true;
          return null;
        },
      }),
      { dryRun: false },
    );
    expect(result.exit).toBe(0);
    expect(result.lines.join("\n")).toMatch(/not applicable/i);
    expect(touched).toBe(false);
  });

  test("runs the real fixer on linux", () => {
    const result = runFixKeyringCommand("linux", deps(), { dryRun: true });
    expect(result.lines.join("\n")).toMatch(/0700/);
  });
});
