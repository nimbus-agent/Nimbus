import { describe, expect, it } from "bun:test";
import { platform } from "node:os";

import { PlatformInitError } from "./errors.ts";
import {
  assertLinuxSecretToolAvailable,
  describeLinuxVaultState,
  isFatalLinuxVaultState,
  LINUX_VAULT_PROBE_ATTRS,
  type LinuxProbeCommandResult,
  type LinuxVaultProbeExec,
  type LinuxVaultState,
  probeLinuxVault,
} from "./linux.ts";

// ---------------------------------------------------------------------------
// Fixtures captured from a real `docker run --rm -i ubuntu:24.04` session on
// 2026-07-29. Every string below is verbatim command output, not invented:
// asserting against paraphrased text would let the probe pass on shapes libsecret
// never actually emits.
//
//   A  no session bus            : apt install libsecret-tools; secret-tool lookup ...
//   C2 bus, no provider          : dbus-run-session -- secret-tool lookup ...
//   C  provider, no collection   : + gnome-keyring installed, never unlocked
//   D  collection exists, locked : keyring seeded in an earlier session, not unlocked
//   B  working                   : + `echo "" | gnome-keyring-daemon --unlock --components=secrets`
// ---------------------------------------------------------------------------

/** State A. `secret-tool` exits 1 with this on stderr when there is no session bus. */
const STDERR_NO_SESSION_BUS = "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n";

/** State C2. A session bus exists but nothing owns `org.freedesktop.secrets`. */
const STDERR_NO_PROVIDER =
  "secret-tool: The name org.freedesktop.secrets was not provided by any .service files\n";

/** busctl `ReadAlias default` when the provider has no default collection (state C). */
const BUSCTL_ALIAS_NONE = 'o "/"\n';

/** busctl `ReadAlias default` when a default collection exists (states B and D). */
const BUSCTL_ALIAS_LOGIN = 'o "/org/freedesktop/secrets/collection/login"\n';

/** busctl `get-property ... Locked` — state D (locked) and state B (working). */
const BUSCTL_LOCKED_TRUE = "b true\n";
const BUSCTL_LOCKED_FALSE = "b false\n";

/** dbus-send equivalents, used when busctl is absent. */
const DBUS_SEND_ALIAS_LOGIN =
  "method return time=1785346008.372363 sender=:1.1 -> destination=:1.2 serial=7 reply_serial=2\n" +
  '   object path "/org/freedesktop/secrets/collection/login"\n';
const DBUS_SEND_ALIAS_NONE =
  "method return time=1785346008.372363 sender=:1.1 -> destination=:1.2 serial=7 reply_serial=2\n" +
  '   object path "/"\n';
const DBUS_SEND_LOCKED_FALSE =
  "method return time=1785345621.279684 sender=org.freedesktop.DBus -> destination=:1.3 serial=3 reply_serial=2\n" +
  "   variant       boolean false\n";
const DBUS_SEND_SERVICE_UNKNOWN =
  "Error org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files\n";

/** busctl exiting non-zero for a reason neither stderr pattern recognises. */
const BUSCTL_CALL_TIMED_OUT = "Call failed: Connection timed out\n";

/** busctl speaking JSON (`--json=short`): exit 0, but no `o "<path>"` token. */
const BUSCTL_JSON_ALIAS = '{"type":"o","data":["/org/freedesktop/secrets/collection/login"]}\n';
const BUSCTL_JSON_LOCKED = '{"type":"b","data":false}\n';

const SECRET_TOOL_PATH = "/usr/bin/secret-tool";

interface FakeExecOptions {
  readonly secretTool?: string | null;
  readonly probe?: { code: number | null; stderr: string };
  readonly tools?: readonly string[];
  readonly alias?: LinuxProbeCommandResult;
  readonly locked?: LinuxProbeCommandResult;
  readonly display?: boolean;
}

function ok(stdout: string): LinuxProbeCommandResult {
  return { code: 0, stdout, stderr: "" };
}

/**
 * Builds an exec double. `queries` records every argv the probe ran so tests can
 * assert the probe really shelled out rather than short-circuiting on PATH.
 */
function makeExec(o: FakeExecOptions): {
  exec: LinuxVaultProbeExec;
  queries: string[][];
  probeArgs: string[][];
} {
  const queries: string[][] = [];
  const probeArgs: string[][] = [];
  const tools = o.tools ?? ["busctl"];
  const exec: LinuxVaultProbeExec = {
    resolveSecretTool: () => (o.secretTool === undefined ? SECRET_TOOL_PATH : o.secretTool),
    probeSecretTool: (exe, args) => {
      probeArgs.push([exe, ...args]);
      return o.probe ?? { code: 1, stderr: "" };
    },
    which: (name) => (tools.includes(name) ? `/usr/bin/${name}` : null),
    query: (cmd) => {
      queries.push([...cmd]);
      const isLocked = cmd.some((a) => a.includes("Locked"));
      if (isLocked) {
        return o.locked ?? ok(BUSCTL_LOCKED_FALSE);
      }
      return o.alias ?? ok(BUSCTL_ALIAS_LOGIN);
    },
    hasInteractiveDisplay: () => o.display ?? false,
  };
  return { exec, queries, probeArgs };
}

function stateOf(o: FakeExecOptions): LinuxVaultState {
  return probeLinuxVault(makeExec(o).exec).state;
}

// ---------------------------------------------------------------------------

describe("probeLinuxVault — the three required states", () => {
  it("reports not-installed when secret-tool cannot be resolved", () => {
    const { exec, probeArgs } = makeExec({ secretTool: null });
    expect(probeLinuxVault(exec).state).toBe("not-installed");
    expect(probeArgs).toHaveLength(0);
  });

  it("reports no-session-bus from the real headless stderr", () => {
    expect(stateOf({ probe: { code: 1, stderr: STDERR_NO_SESSION_BUS } })).toBe("no-session-bus");
  });

  it("reports no-secret-service when the bus has no org.freedesktop.secrets owner", () => {
    expect(stateOf({ probe: { code: 1, stderr: STDERR_NO_PROVIDER } })).toBe("no-secret-service");
  });

  it("reports ok only when a default collection exists and is unlocked", () => {
    expect(stateOf({ alias: ok(BUSCTL_ALIAS_LOGIN), locked: ok(BUSCTL_LOCKED_FALSE) })).toBe("ok");
  });
});

describe("probeLinuxVault — states a lookup-only probe cannot see", () => {
  // Measured: in BOTH of the states below `secret-tool lookup <absent>` exits 1
  // with empty stderr and `secret-tool search --all <absent>` exits 0 — exactly
  // as in the working state. Only the Secret Service collection reveals them.
  it("reports no-collection when ReadAlias(default) returns the null object path", () => {
    expect(stateOf({ alias: ok(BUSCTL_ALIAS_NONE) })).toBe("no-collection");
  });

  it("reports locked when the default collection exists but Locked is true", () => {
    expect(stateOf({ alias: ok(BUSCTL_ALIAS_LOGIN), locked: ok(BUSCTL_LOCKED_TRUE) })).toBe(
      "locked",
    );
  });
});

describe("probeLinuxVault — transport fallbacks", () => {
  it("falls back to dbus-send when busctl is absent", () => {
    const { exec, queries } = makeExec({
      tools: ["dbus-send"],
      alias: ok(DBUS_SEND_ALIAS_LOGIN),
      locked: ok(DBUS_SEND_LOCKED_FALSE),
    });
    expect(probeLinuxVault(exec).state).toBe("ok");
    expect(queries.every((q) => q[0] === "dbus-send")).toBe(true);
  });

  it("parses the dbus-send null object path as no-collection", () => {
    expect(stateOf({ tools: ["dbus-send"], alias: ok(DBUS_SEND_ALIAS_NONE) })).toBe(
      "no-collection",
    );
  });

  it("maps a ServiceUnknown D-Bus error to no-secret-service", () => {
    expect(stateOf({ alias: { code: 1, stdout: "", stderr: DBUS_SEND_SERVICE_UNKNOWN } })).toBe(
      "no-secret-service",
    );
  });

  it("reports unverified — never ok — when no D-Bus query tool is installed", () => {
    expect(stateOf({ tools: [] })).toBe("unverified");
  });

  it("reports unverified when the Locked property cannot be read", () => {
    expect(stateOf({ locked: { code: 1, stdout: "", stderr: "boom" } })).toBe("unverified");
  });

  it("reports unverified — not ok — when ReadAlias fails for an unrecognised reason", () => {
    // stderr matches neither the no-session-bus nor the no-provider pattern, so
    // the state is genuinely unknown; the raw diagnostic must still be surfaced.
    const probe = probeLinuxVault(
      makeExec({ alias: { code: 1, stdout: "", stderr: BUSCTL_CALL_TIMED_OUT } }).exec,
    );
    expect(probe.state).toBe("unverified");
    expect(probe.detail).toBe(BUSCTL_CALL_TIMED_OUT.trim());
  });

  it("reports unverified — not ok — when the ReadAlias reply cannot be parsed", () => {
    // A busctl that emits JSON (e.g. `--json=short` wired in via an alias) exits 0
    // but carries no `o "<path>"` token; guessing `ok` here would be a false green.
    const probe = probeLinuxVault(makeExec({ alias: ok(BUSCTL_JSON_ALIAS) }).exec);
    expect(probe.state).toBe("unverified");
    expect(probe.detail).toContain("unparseable ReadAlias reply");
    expect(probe.detail).toContain(BUSCTL_JSON_ALIAS.trim());
  });

  it("reports unverified — not ok — when the Locked reply cannot be parsed", () => {
    const probe = probeLinuxVault(
      makeExec({ alias: ok(BUSCTL_ALIAS_LOGIN), locked: ok(BUSCTL_JSON_LOCKED) }).exec,
    );
    expect(probe.state).toBe("unverified");
    expect(probe.detail).toContain("unparseable Locked reply");
    expect(probe.detail).toContain(BUSCTL_JSON_LOCKED.trim());
  });
});

describe("probeLinuxVault — read-only guarantee", () => {
  it("only ever runs `lookup`, never store/clear/lock", () => {
    const { exec, probeArgs, queries } = makeExec({});
    probeLinuxVault(exec);
    expect(probeArgs[0]?.[1]).toBe("lookup");
    const everyArg = [...probeArgs.flat(), ...queries.flat()].join(" ");
    for (const mutating of ["store", "clear", "lock", "unlock", "Delete", "CreateItem"]) {
      expect(everyArg).not.toContain(mutating);
    }
  });

  it("uses probe attributes that can never collide with a stored Nimbus secret", () => {
    // Nimbus writes `application=nimbus`; the probe must use a different
    // application so the lookup is structurally guaranteed to miss.
    const appIdx = LINUX_VAULT_PROBE_ATTRS.indexOf("application");
    expect(appIdx).toBeGreaterThanOrEqual(0);
    expect(LINUX_VAULT_PROBE_ATTRS[appIdx + 1]).not.toBe("nimbus");
  });
});

describe("isFatalLinuxVaultState", () => {
  const alwaysFatal: LinuxVaultState[] = [
    "not-installed",
    "no-session-bus",
    "no-secret-service",
    "no-collection",
  ];
  it.each(alwaysFatal)("treats %s as fatal regardless of display", (state) => {
    expect(isFatalLinuxVaultState(state, true)).toBe(true);
    expect(isFatalLinuxVaultState(state, false)).toBe(true);
  });

  it("treats a locked collection as fatal only when headless", () => {
    // With a display libsecret can raise an unlock prompt; headless it cannot,
    // and `secret-tool store` fails with "Cannot create an item in a locked collection".
    expect(isFatalLinuxVaultState("locked", false)).toBe(true);
    expect(isFatalLinuxVaultState("locked", true)).toBe(false);
  });

  it("never treats ok or unverified as fatal", () => {
    expect(isFatalLinuxVaultState("ok", false)).toBe(false);
    expect(isFatalLinuxVaultState("unverified", false)).toBe(false);
  });
});

describe("describeLinuxVaultState", () => {
  it("keeps the distinct not-installed message", () => {
    const msg = describeLinuxVaultState("not-installed", "");
    expect(msg).toContain("secret-tool not found");
    expect(msg).toContain("libsecret-tools");
    // The install hint must NOT be reused for the runtime failures.
    expect(msg).not.toContain("dbus-run-session");
  });

  const runtimeFailures: LinuxVaultState[] = [
    "no-session-bus",
    "no-secret-service",
    "no-collection",
  ];
  it.each(runtimeFailures)("names the real cause and an actionable remedy for %s", (state) => {
    const msg = describeLinuxVaultState(state, "");
    expect(msg).toContain("D-Bus");
    expect(msg).toContain("dbus-run-session");
    expect(msg).toContain("gnome-keyring-daemon --unlock");
    // "just install libsecret" was the misleading old message.
    expect(msg).not.toContain("secret-tool not found");
  });

  it("includes the underlying diagnostic when one is available", () => {
    const msg = describeLinuxVaultState("no-session-bus", STDERR_NO_SESSION_BUS.trim());
    expect(msg).toContain("Cannot autolaunch D-Bus");
  });
});

describe("assertLinuxSecretToolAvailable", () => {
  it("throws PlatformInitError for every fatal state", () => {
    const fatal: FakeExecOptions[] = [
      { secretTool: null },
      { probe: { code: 1, stderr: STDERR_NO_SESSION_BUS } },
      { probe: { code: 1, stderr: STDERR_NO_PROVIDER } },
      { alias: ok(BUSCTL_ALIAS_NONE) },
      { alias: ok(BUSCTL_ALIAS_LOGIN), locked: ok(BUSCTL_LOCKED_TRUE) },
    ];
    for (const o of fatal) {
      expect(() => {
        assertLinuxSecretToolAvailable(makeExec(o).exec);
      }).toThrow(PlatformInitError);
    }
  });

  it("does not throw for a working keyring", () => {
    expect(() => {
      assertLinuxSecretToolAvailable(makeExec({}).exec);
    }).not.toThrow();
  });

  it("does not throw when the collection is locked but a display can prompt", () => {
    expect(() => {
      assertLinuxSecretToolAvailable(
        makeExec({ alias: ok(BUSCTL_ALIAS_LOGIN), locked: ok(BUSCTL_LOCKED_TRUE), display: true })
          .exec,
      );
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Regression guard for the defect this file exists to close.
// ---------------------------------------------------------------------------

describe("the probe must not degenerate back into a PATH check", () => {
  // Every case below has secret-tool resolvable — i.e. `Bun.which("secret-tool")
  // !== null`, the old check — and a Secret Service that provably cannot serve a
  // single Vault write. If someone reintroduces the PATH check these all go green
  // on `ok`, so each assertion is a live tripwire.
  const brokenButOnPath: Array<[string, FakeExecOptions]> = [
    ["no session bus", { probe: { code: 1, stderr: STDERR_NO_SESSION_BUS } }],
    ["no Secret Service provider", { probe: { code: 1, stderr: STDERR_NO_PROVIDER } }],
    ["no default collection", { alias: ok(BUSCTL_ALIAS_NONE) }],
    ["locked collection", { alias: ok(BUSCTL_ALIAS_LOGIN), locked: ok(BUSCTL_LOCKED_TRUE) }],
  ];

  it.each(brokenButOnPath)("%s: secret-tool is on PATH yet the probe refuses ok", (_name, o) => {
    const { exec } = makeExec(o);
    expect(exec.resolveSecretTool()).toBe(SECRET_TOOL_PATH);
    expect(probeLinuxVault(exec).state).not.toBe("ok");
    expect(() => {
      assertLinuxSecretToolAvailable(exec);
    }).toThrow(PlatformInitError);
  });

  it("actually executes the probe instead of trusting resolution", () => {
    const { exec, probeArgs, queries } = makeExec({});
    probeLinuxVault(exec);
    expect(probeArgs.length).toBeGreaterThan(0);
    expect(queries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Real-machine check: proves the probe leaves nothing behind.
// ---------------------------------------------------------------------------

describe("probeLinuxVault on the host", () => {
  it.skipIf(platform() !== "linux")(
    "runs and stores nothing",
    () => {
      const secretTool = Bun.which("secret-tool");
      if (secretTool === null) {
        return;
      }
      const result = probeLinuxVault();
      expect(typeof result.state).toBe("string");

      // Nothing may exist under the probe's own attributes afterwards.
      const search = Bun.spawnSync({
        cmd: [secretTool, "search", "--all", "application", "nimbus-vault-probe"],
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      expect(search.stdout.toString().trim()).toBe("");
    },
    30_000,
  );
});
