/**
 * Linux Vault preflight arms `linux-vault-probe.test.ts` does not reach:
 *  - the default collection RESOLVES but no D-Bus tool is left to read its `Locked` property
 *    (the second phase finds neither busctl nor dbus-send): unverified, with an empty diagnostic;
 *  - the PRODUCTION probe exec in strict-PATH mode on a host where `secret-tool` is not on PATH.
 *
 * The strict-PATH case is the only one here that uses the real default exec, and it is hermetic
 * by construction: with no `secret-tool` resolvable the probe returns before spawning anything.
 * Where `secret-tool` IS resolvable it would run a real (read-only) lookup instead — that case is
 * the host test's job in `linux-vault-probe.test.ts`, so this one is skipped there.
 */
import { describe, expect, test } from "bun:test";

import { PlatformInitError } from "./errors.ts";
import {
  assertLinuxSecretToolAvailable,
  describeLinuxVaultState,
  type LinuxProbeCommandResult,
  type LinuxVaultProbeExec,
  probeLinuxVault,
} from "./linux.ts";

const INSTALL_HINT =
  "secret-tool not found. Install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch) to use Nimbus on Linux.";

/** busctl's verbatim `ReadAlias default` reply when a default collection exists. */
const ALIAS_LOGIN: LinuxProbeCommandResult = {
  code: 0,
  stdout: 'o "/org/freedesktop/secrets/collection/login"\n',
  stderr: "",
};

describe("probeLinuxVault — the Locked read has no tool left to run it", () => {
  test("reports unverified with an EMPTY diagnostic, never ok and never a throw", () => {
    const whichCalls: string[] = [];
    const queries: string[][] = [];
    const exec: LinuxVaultProbeExec = {
      resolveSecretTool: () => "/usr/bin/secret-tool",
      probeSecretTool: () => ({ code: 1, stderr: "" }),
      // busctl answers the FIRST lookup (ReadAlias) and has vanished by the second (Locked);
      // dbus-send was never there.
      which: (name) => {
        whichCalls.push(name);
        return name === "busctl" && whichCalls.length === 1 ? "/usr/bin/busctl" : null;
      },
      query: (cmd) => {
        queries.push([...cmd]);
        return ALIAS_LOGIN;
      },
      hasInteractiveDisplay: () => false,
    };

    expect(probeLinuxVault(exec)).toEqual({ state: "unverified", detail: "" });
    // ONE query ran (ReadAlias); the Locked read found no tool and ran nothing.
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("ReadAlias");
    expect(whichCalls).toEqual(["busctl", "busctl", "dbus-send"]);
    // An empty detail adds no "Diagnostic:" line to what the user is shown.
    expect(describeLinuxVaultState("unverified", "")).not.toContain("Diagnostic:");
  });
});

describe("the production probe exec, strict-PATH mode", () => {
  test.skipIf(Bun.which("secret-tool") !== null)(
    "with no secret-tool on PATH the preflight fails CLOSED with the install hint, before spawning anything",
    () => {
      const key = "NIMBUS_LINUX_VAULT_PROBE_STRICT_PATH";
      const saved = process.env[key];
      process.env[key] = "1";
      try {
        expect(probeLinuxVault()).toEqual({ state: "not-installed", detail: "" });
        let thrown: unknown;
        try {
          assertLinuxSecretToolAvailable();
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(PlatformInitError);
        // Exactly the hint: not-installed carries neither the headless remedy nor a diagnostic.
        expect((thrown as Error).message).toBe(INSTALL_HINT);
      } finally {
        if (saved === undefined) delete process.env[key];
        else process.env[key] = saved;
      }
    },
  );
});
