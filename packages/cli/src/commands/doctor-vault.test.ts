import { describe, expect, it } from "bun:test";

import {
  DOCTOR_VAULT_PROBE_ATTRS,
  type DoctorVaultExec,
  type DoctorVaultRun,
  type DoctorVaultStatus,
  doctorVaultLine,
  doctorVaultStatus,
} from "./doctor-core.ts";

// Fixtures captured verbatim from `docker run --rm -i ubuntu:24.04` on 2026-07-29;
// see packages/gateway/src/platform/linux-vault-probe.test.ts for the full matrix.
const STDERR_NO_SESSION_BUS = "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n";
const STDERR_NO_PROVIDER =
  "secret-tool: The name org.freedesktop.secrets was not provided by any .service files\n";
const ALIAS_NONE = 'o "/"\n';
const ALIAS_LOGIN = 'o "/org/freedesktop/secrets/collection/login"\n';
const LOCKED_TRUE = "b true\n";
const LOCKED_FALSE = "b false\n";
const DBUS_SEND_ALIAS_LOGIN =
  "method return time=1785346008.372363 sender=:1.1 -> destination=:1.2 serial=7 reply_serial=2\n" +
  '   object path "/org/freedesktop/secrets/collection/login"\n';
const DBUS_SEND_LOCKED_FALSE =
  "method return time=1785345621.279684 sender=org.freedesktop.DBus -> destination=:1.3 serial=3 reply_serial=2\n" +
  "   variant       boolean false\n";

const SECRET_TOOL = "/usr/bin/secret-tool";

interface Scenario {
  readonly secretTool?: string | null;
  readonly stderr?: string;
  readonly tools?: readonly string[];
  readonly alias?: DoctorVaultRun;
  readonly locked?: DoctorVaultRun;
}

const seen: { commands: string[][] } = { commands: [] };

function makeExec(s: Scenario): DoctorVaultExec {
  seen.commands = [];
  const tools = s.tools ?? ["busctl"];
  return {
    findSecretTool: () => (s.secretTool === undefined ? SECRET_TOOL : s.secretTool),
    lookupStderr: () => s.stderr ?? "",
    hasBinary: (n) => tools.includes(n),
    runQuery: (cmd) => {
      seen.commands.push([...cmd]);
      if (cmd.some((a) => a.includes("Locked"))) {
        return s.locked ?? { code: 0, stdout: LOCKED_FALSE, stderr: "" };
      }
      return s.alias ?? { code: 0, stdout: ALIAS_LOGIN, stderr: "" };
    },
  };
}

function statusOf(s: Scenario): DoctorVaultStatus {
  return doctorVaultStatus("linux", makeExec(s));
}

function lineOf(s: Scenario): string {
  return doctorVaultLine("linux", makeExec(s));
}

describe("doctorVaultStatus — three distinguishable states on Linux", () => {
  it("distinguishes not installed from installed-but-no-Secret-Service from working", () => {
    expect(statusOf({ secretTool: null }).state).toBe("not-installed");
    expect(statusOf({ stderr: STDERR_NO_PROVIDER }).state).toBe("no-secret-service");
    expect(statusOf({}).state).toBe("ok");
  });

  it("reports no-session-bus for the headless stderr", () => {
    expect(statusOf({ stderr: STDERR_NO_SESSION_BUS }).state).toBe("no-session-bus");
  });

  it("reports no-collection when the provider has no default collection", () => {
    expect(statusOf({ alias: { code: 0, stdout: ALIAS_NONE, stderr: "" } }).state).toBe(
      "no-collection",
    );
  });

  it("reports locked when the default collection is locked", () => {
    expect(statusOf({ locked: { code: 0, stdout: LOCKED_TRUE, stderr: "" } }).state).toBe("locked");
  });

  it("falls back to dbus-send when busctl is absent", () => {
    const st = statusOf({
      tools: ["dbus-send"],
      alias: { code: 0, stdout: DBUS_SEND_ALIAS_LOGIN, stderr: "" },
      locked: { code: 0, stdout: DBUS_SEND_LOCKED_FALSE, stderr: "" },
    });
    expect(st.state).toBe("ok");
    expect(seen.commands.every((c) => c[0] === "dbus-send")).toBe(true);
  });

  it("reports unverified when neither busctl nor dbus-send exists", () => {
    expect(statusOf({ tools: [] }).state).toBe("unverified");
  });

  it("never probes at all on non-Linux platforms", () => {
    expect(doctorVaultStatus("darwin", makeExec({ secretTool: null })).state).toBe(
      "not-applicable",
    );
    expect(doctorVaultStatus("win32", makeExec({ secretTool: null })).state).toBe("not-applicable");
  });
});

describe("doctorVaultLine — marks and messages", () => {
  it("prints [ok] only for a genuinely working keyring", () => {
    expect(lineOf({})).toStartWith("[ok] Vault:");
  });

  it("prints an [ok] non-check line on darwin and win32", () => {
    expect(doctorVaultLine("darwin", makeExec({}))).toStartWith("[ok] Vault:");
    expect(doctorVaultLine("win32", makeExec({}))).toStartWith("[ok] Vault:");
  });

  it("keeps the distinct not-installed message", () => {
    const line = lineOf({ secretTool: null });
    expect(line).toStartWith("[fail] Vault:");
    expect(line).toContain("secret-tool not found");
    expect(line).toContain("libsecret");
  });

  it("names D-Bus and the unlock remedy for every runtime failure", () => {
    const failures: Scenario[] = [
      { stderr: STDERR_NO_SESSION_BUS },
      { stderr: STDERR_NO_PROVIDER },
      { alias: { code: 0, stdout: ALIAS_NONE, stderr: "" } },
      { locked: { code: 0, stdout: LOCKED_TRUE, stderr: "" } },
    ];
    for (const s of failures) {
      const line = lineOf(s);
      expect(line).toStartWith("[fail] Vault:");
      expect(line).toContain("D-Bus");
      expect(line).toContain("dbus-run-session");
      expect(line).toContain("gnome-keyring-daemon --unlock");
      // The old message blamed the wrong thing.
      expect(line).not.toContain("secret-tool is on PATH");
    }
  });

  it("warns — never fails, never oks — when the keyring state is unverifiable", () => {
    expect(lineOf({ tools: [] })).toStartWith("[warn] Vault:");
  });
});

describe("doctor must not report a PATH check as a health check", () => {
  // This is the exact defect from issue #925: `Bun.which("secret-tool") !== null`
  // printed "[ok] Vault: secret-tool is on PATH." on a machine where every Vault
  // operation fails. Each row has secret-tool resolvable and a provably dead
  // Secret Service; if the PATH check returns, these all go green on [ok].
  const brokenButOnPath: Array<[string, Scenario]> = [
    ["no session bus", { stderr: STDERR_NO_SESSION_BUS }],
    ["no Secret Service provider", { stderr: STDERR_NO_PROVIDER }],
    ["no default collection", { alias: { code: 0, stdout: ALIAS_NONE, stderr: "" } }],
    ["locked collection", { locked: { code: 0, stdout: LOCKED_TRUE, stderr: "" } }],
  ];

  it.each(brokenButOnPath)("%s: reports a failure, not [ok]", (_name, s) => {
    const exec = makeExec(s);
    expect(exec.findSecretTool()).toBe(SECRET_TOOL);
    const line = doctorVaultLine("linux", makeExec(s));
    expect(line).not.toStartWith("[ok]");
    expect(line).toStartWith("[fail]");
    expect(doctorVaultStatus("linux", makeExec(s)).exit).toBe(2);
  });

  it("never prints the old PATH-check wording", () => {
    for (const [, s] of brokenButOnPath) {
      expect(lineOf(s)).not.toContain("secret-tool is on PATH");
    }
  });

  it("actually shells out rather than trusting resolution", () => {
    const exec = makeExec({});
    doctorVaultStatus("linux", exec);
    expect(seen.commands.length).toBeGreaterThan(0);
  });
});

describe("doctor probe is read-only", () => {
  it("uses probe attributes that cannot collide with a stored Nimbus secret", () => {
    const i = DOCTOR_VAULT_PROBE_ATTRS.indexOf("application");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(DOCTOR_VAULT_PROBE_ATTRS[i + 1]).not.toBe("nimbus");
  });

  it("issues no mutating command", () => {
    doctorVaultStatus("linux", makeExec({}));
    const flat = seen.commands.flat().join(" ");
    for (const mutating of ["store", "clear", "Delete", "CreateItem", "Lock ", "Unlock"]) {
      expect(flat).not.toContain(mutating);
    }
  });
});
