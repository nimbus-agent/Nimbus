import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  BWRAP_APPARMOR_PROFILE_PATH,
  bwrapApparmorInstallShell,
  bwrapApparmorRemoveShell,
  type DoctorBwrapDeps,
  doctorPrintLinuxSandbox,
} from "./doctor-bwrap.ts";

function deps(over: Partial<DoctorBwrapDeps>): DoctorBwrapDeps {
  return {
    platform: "linux",
    findBwrap: () => "/usr/bin/bwrap",
    run: () => ({ code: 0, stderr: "" }),
    apparmorFixApplies: () => false,
    ...over,
  };
}

describe("doctorPrintLinuxSandbox", () => {
  let lines: string[];
  let log: ReturnType<typeof spyOn>;

  beforeEach(() => {
    lines = [];
    log = spyOn(console, "log").mockImplementation((s: unknown) => {
      lines.push(String(s));
    });
  });
  afterEach(() => log.mockRestore());

  test("off Linux it runs nothing and prints nothing", () => {
    let ran = false;
    const code = doctorPrintLinuxSandbox(
      deps({
        platform: "darwin",
        run: () => {
          ran = true;
          return { code: 1, stderr: "" };
        },
      }),
    );
    expect(code).toBe(0);
    expect(ran).toBe(false);
    expect(lines).toEqual([]);
  });

  test("a bwrap that starts its child passes", () => {
    let argv: readonly string[] = [];
    const code = doctorPrintLinuxSandbox(
      deps({
        run: (cmd) => {
          argv = cmd;
          return { code: 0, stderr: "" };
        },
      }),
    );
    expect(code).toBe(0);
    expect(lines[0]).toStartWith("[ok] Sandbox");
    // The whole point: `--version` passes on the machines this check exists for.
    expect(argv).not.toContain("--version");
    expect(argv).toContain("--unshare-user");
    expect(argv).toContain("--unshare-net");
  });

  test("a missing bwrap fails", () => {
    const code = doctorPrintLinuxSandbox(deps({ findBwrap: () => null }));
    expect(code).toBe(2);
    expect(lines[0]).toContain("not installed");
  });

  test("the AppArmor denial fails, quotes bwrap, and prints commands that write the profile", () => {
    const code = doctorPrintLinuxSandbox(
      deps({
        run: () => ({ code: 1, stderr: "bwrap: setting up uid map: Permission denied\n" }),
        apparmorFixApplies: () => true,
      }),
    );
    expect(code).toBe(2);
    expect(lines[0]).toContain("setting up uid map: Permission denied");
    const out = lines.join("\n");
    expect(out).toContain(`sudo tee ${BWRAP_APPARMOR_PROFILE_PATH}`);
    expect(out).toContain(`sudo apparmor_parser -r ${BWRAP_APPARMOR_PROFILE_PATH}`);
  });

  test("another failure does not offer the AppArmor commands", () => {
    const code = doctorPrintLinuxSandbox(deps({ run: () => ({ code: 1, stderr: "" }) }));
    expect(code).toBe(2);
    expect(lines[0]).toContain("exit 1");
    expect(lines.join("\n")).not.toContain("apparmor_parser");
  });
});

describe("the AppArmor shell blocks", () => {
  test("the profile allows user namespaces for /usr/bin/bwrap and names nothing else", () => {
    const block = bwrapApparmorInstallShell(false);
    expect(block).toContain("'profile nimbus-bwrap /usr/bin/bwrap flags=(unconfined) {'");
    expect(block).toContain("'  userns,'");
    expect(block.match(/'profile /g)?.length).toBe(1);
  });

  test("install is skipped where the rule cannot parse or a bwrap profile already exists", () => {
    const block = bwrapApparmorInstallShell(false);
    expect(block).toContain("[ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]");
    expect(block).toContain("[ -e /etc/apparmor.d/abi/4.0 ]");
    expect(block).toContain("[ ! -e /etc/apparmor.d/bwrap ]");
  });

  test("a failed load removes the file, so it cannot fail at every boot", () => {
    expect(bwrapApparmorInstallShell(false)).toContain(`rm -f ${BWRAP_APPARMOR_PROFILE_PATH}`);
  });

  test("sudo appears only in the form that asks for it", () => {
    expect(bwrapApparmorInstallShell(false)).not.toContain("sudo");
    expect(bwrapApparmorRemoveShell(false)).not.toContain("sudo");
    expect(bwrapApparmorInstallShell(true)).toContain(`sudo apparmor_parser -r`);
    expect(bwrapApparmorRemoveShell(true)).toContain(`sudo apparmor_parser -R`);
  });
});
