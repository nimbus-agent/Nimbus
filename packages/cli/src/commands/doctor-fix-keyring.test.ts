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
    listDir: () => [],
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

  // B-2: a user can have a default collection under a different name (e.g.
  // Default_keyring.keyring, referenced via a `default` alias file) and no
  // login.keyring at all. The refusal must catch that too, not just the
  // exact login.keyring path.
  test("refuses when the keyrings dir holds a non-login .keyring collection", () => {
    let mkdirCalls = 0;
    const result = fixKeyring(
      deps({
        statMode: (p) => (p.endsWith("keyrings") ? 0o700 : null), // dir exists, login.keyring does not
        listDir: (p) => (p.endsWith("keyrings") ? ["Default_keyring.keyring"] : []),
        mkdirMode: () => {
          mkdirCalls += 1;
        },
      }),
      { dryRun: false },
    );
    expect(result.exit).not.toBe(0);
    expect(result.lines.join("\n")).toMatch(/already exists/i);
    expect(result.lines.join("\n")).toContain("Default_keyring.keyring");
    expect(mkdirCalls).toBe(0);
  });

  test("refuses when the keyrings dir holds a `default` alias pointer", () => {
    const result = fixKeyring(
      deps({
        statMode: (p) => (p.endsWith("keyrings") ? 0o700 : null),
        listDir: (p) => (p.endsWith("keyrings") ? ["default"] : []),
      }),
      { dryRun: false },
    );
    expect(result.exit).not.toBe(0);
    expect(result.lines.join("\n")).toMatch(/already exists/i);
  });

  test("does not refuse over an unrelated file in an existing, otherwise-empty keyrings dir", () => {
    const result = fixKeyring(
      deps({
        statMode: (p) => (p.endsWith("keyrings") ? 0o700 : null),
        listDir: (p) => (p.endsWith("keyrings") ? ["some-unrelated-file.txt"] : []),
      }),
      { dryRun: false },
    );
    expect(result.lines.join("\n")).not.toMatch(/already exists/i);
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

  // B-1 (round 2): gnome-keyring enforces no permissions itself, so a
  // pre-existing, loosely-permissioned keyrings directory must be
  // RETIGHTENED to 0700, not left alone -- the plan text says this happens
  // "either way". The JS-side mkdirMode seam is one half of that promise
  // (mkdirMode's real implementation is mkdirSync(recursive) + chmodSync, so
  // this is what retightens an already-existing directory); buildFixScript()'s
  // own `chmod 700` (asserted in the script-content test below) is the other
  // half, where the retightening actually executes for real.
  test("always calls mkdirMode for the keyrings directory at 0700, even if it already exists", () => {
    const modes = new Map<string, number>();
    fixKeyring(
      deps({
        statMode: (p) => (p.endsWith("keyrings") ? 0o755 : null), // dir pre-exists, loosely permissioned
        listDir: () => [], // empty -- no collection inside, so no refusal
        mkdirMode: (p, m) => modes.set(p, m),
      }),
      { dryRun: false },
    );
    const dir = [...modes.entries()].find(([p]) => p.endsWith("keyrings"));
    expect(dir?.[1]).toBe(0o700);
  });

  // writeFileMode is never called by a correct run -- gnome-keyring writes
  // login.keyring/user.keystore itself. Asserted directly (not via a
  // zero-iteration loop over calls that never happen) so this claim can
  // actually fail if the implementation stops being true.
  test("never calls writeFileMode", () => {
    const calls: string[] = [];
    fixKeyring(
      deps({
        writeFileMode: (p) => {
          calls.push(p);
        },
      }),
      { dryRun: false },
    );
    expect(calls).toEqual([]);
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

  // B-5: gnome-keyring-daemon is the component that actually creates the
  // keyring, and it is exactly the thing missing on the headless boxes
  // #1168 is about. Its own stderr is suppressed inside the script, so this
  // precheck is the only place its absence can surface.
  test("fails with a helpful hint naming gnome-keyring when gnome-keyring-daemon is missing", () => {
    const result = fixKeyring(
      deps({
        exec: makeExec({ hasBinary: (name) => name !== "gnome-keyring-daemon" }),
      }),
      { dryRun: false },
    );
    expect(result.exit).not.toBe(0);
    expect(result.lines.join("\n")).toContain("gnome-keyring-daemon");
    expect(result.lines.join("\n")).toMatch(/\bgnome-keyring\b/);
  });

  test("fails with a helpful hint when dbus-run-session or secret-tool is missing", () => {
    const result = fixKeyring(
      deps({
        exec: makeExec({ hasBinary: () => false }),
      }),
      { dryRun: false },
    );
    expect(result.exit).not.toBe(0);
    expect(result.lines.join("\n")).toMatch(/dbus-x11/i);
    expect(result.lines.join("\n")).toMatch(/libsecret-tools/i);
    expect(result.lines.join("\n")).toMatch(/gnome-keyring\b/i);
  });

  // B-3: a box missing a required binary must be left untouched -- the
  // precheck has to run before any filesystem mutation, not after.
  test("checks required binaries before touching the filesystem", () => {
    let mkdirCalls = 0;
    let queryCalls = 0;
    const result = fixKeyring(
      deps({
        exec: makeExec({
          hasBinary: () => false,
          runQuery: () => {
            queryCalls += 1;
            return { code: 0, stdout: "", stderr: "" };
          },
        }),
        mkdirMode: () => {
          mkdirCalls += 1;
        },
      }),
      { dryRun: false },
    );
    expect(result.exit).not.toBe(0);
    expect(mkdirCalls).toBe(0);
    expect(queryCalls).toBe(0);
  });

  // B-4: buildFixScript() is a pure string builder reachable only through
  // the command passed to exec.runQuery. Assert on its actual content so
  // deleting the poll loop or either chmod 600 line fails a test -- not just
  // "some command starting with dbus-run-session ran".
  test("the generated fix script contains the poll loop, both chmod 600s, and the dir chmod 0700", () => {
    let script = "";
    fixKeyring(
      deps({
        exec: makeExec({
          runQuery: (cmd) => {
            script = String(cmd[cmd.length - 1]);
            return { code: 0, stdout: "nimbus-fix-keyring-check-ok\n", stderr: "" };
          },
        }),
      }),
      { dryRun: false },
    );
    expect(script).toContain("org.freedesktop.DBus.GetNameOwner");
    expect(script).toContain("string:org.freedesktop.secrets");
    // The poll loop itself, not just the D-Bus call name.
    expect(script).toMatch(/while\s+\[\s*\$j\s+-lt\s+100\s*\]/);
    expect(script).toContain("chmod 700");
    expect(script).toContain('"$HOME/.local/share/keyrings/login.keyring"');
    expect(script).toContain('"$HOME/.local/share/keyrings/user.keystore"');
    // Both files individually re-asserted at 0600 -- two distinct chmod 600 lines.
    const chmod600Count = (script.match(/chmod 600 /g) ?? []).length;
    expect(chmod600Count).toBe(2);
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
