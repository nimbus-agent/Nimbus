import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  BWRAP_APPARMOR_PROFILE_PATH,
  bwrapApparmorInstallShell,
  bwrapApparmorRemoveShell,
  createDoctorBwrapDeps,
  type DoctorBwrapDeps,
  type DoctorBwrapHost,
  doctorPrintLinuxSandbox,
  gatewaySandboxPosture,
} from "./doctor-bwrap.ts";

const HELPER_BESIDE = "/home/owner/.local/bin/nimbus-sandbox-helper";
const INSTALLED_HELPER = "/usr/lib/nimbus/bin/nimbus-sandbox-helper";

function deps(over: Partial<DoctorBwrapDeps>): DoctorBwrapDeps {
  return {
    platform: "linux",
    findBwrap: () => "/usr/bin/bwrap",
    run: () => ({ code: 0, stderr: "" }),
    apparmorFixApplies: () => false,
    findHelper: () => ({ kind: "found", path: HELPER_BESIDE }),
    ids: () => ({ uid: 1000, gid: 1000 }),
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

  describe("the declared-hosts check", () => {
    const ENFORCED = "[ok] Sandbox: declared hosts are enforced.";
    const CAN_START =
      "[ok] Sandbox: the network forwarder can start here. Start the gateway to confirm enforcement.";
    const MISSING =
      "[warn] Sandbox: nimbus-sandbox-helper is missing, so a connector that declares a network reaches the whole internet.";
    const isCheck = (cmd: readonly string[]): boolean => cmd[1] === "--check";
    const isNested = (cmd: readonly string[]): boolean => cmd.includes("--socket");

    test("only a gateway reporting per_host earns the claim that hosts are enforced", () => {
      const code = doctorPrintLinuxSandbox(deps({ run: () => ({ code: 0, stderr: "" }) }), {
        network: "per_host",
        reason: null,
      });
      expect(code).toBe(0);
      expect(lines).toContain(ENFORCED);
      expect(lines.at(-1)).toContain("net-forward:");
    });

    test("a helper beside the gateway that starts, with no gateway: it can start, exit 0", () => {
      const seen: (readonly string[])[] = [];
      const code = doctorPrintLinuxSandbox(
        deps({
          run: (cmd) => {
            seen.push(cmd);
            return { code: 0, stderr: "" };
          },
        }),
      );
      expect(code).toBe(0);
      expect(lines).toEqual(["[ok] Sandbox: bubblewrap can start sandboxed children.", CAN_START]);
      expect(lines).not.toContain(ENFORCED);
      expect(seen.some((c) => c[0] === HELPER_BESIDE && isCheck(c))).toBe(true);
      expect(seen.some(isNested)).toBe(true);
    });

    test("the nested start is the real shape: the launcher's three capabilities, then a second bwrap", () => {
      let nested: readonly string[] = [];
      doctorPrintLinuxSandbox(
        deps({
          run: (cmd) => {
            if (isNested(cmd)) nested = cmd;
            return { code: 0, stderr: "" };
          },
        }),
      );
      for (const cap of ["CAP_NET_BIND_SERVICE", "CAP_SETPCAP", "CAP_SETFCAP"]) {
        expect(nested).toContain(cap);
      }
      // The helper's own binary is bound at the fixed path, and its directory is not.
      expect(nested).toContain(HELPER_BESIDE);
      expect(nested).not.toContain("/home/owner/.local/bin");
      const split = nested.indexOf("--");
      expect(nested[split + 1]).toBe("/usr/bin/bwrap");
      expect(nested.slice(split)).toContain("1000");
      expect(nested.at(-1)).toBe("/usr/bin/true");
    });

    test("a bwrap outside /usr is bound into the outer view, so the inner one can run", () => {
      let nested: readonly string[] = [];
      doctorPrintLinuxSandbox(
        deps({
          findBwrap: () => "/opt/bwrap",
          run: (cmd) => {
            if (isNested(cmd)) nested = cmd;
            return { code: 0, stderr: "" };
          },
        }),
      );
      expect(nested.join(" ")).toContain("--ro-bind /opt/bwrap /opt/bwrap");
    });

    test("no helper warns with exit severity 1, and runs nothing more", () => {
      let runs = 0;
      const code = doctorPrintLinuxSandbox(
        deps({
          findHelper: () => ({ kind: "missing" }),
          run: () => {
            runs += 1;
            return { code: 0, stderr: "" };
          },
        }),
      );
      expect(code).toBe(1);
      expect(lines.at(-1)).toBe(MISSING);
      expect(runs).toBe(1);
    });

    test("an override naming nothing fails: the gateway refuses, it does not fall back", () => {
      const code = doctorPrintLinuxSandbox(
        deps({ findHelper: () => ({ kind: "override-missing", path: "/no/such/helper" }) }),
      );
      expect(code).toBe(2);
      expect(lines.at(-1)).toStartWith(
        "[fail] Sandbox: NIMBUS_SANDBOX_HELPER_PATH names /no/such/helper",
      );
      expect(lines.join("\n")).not.toContain("whole internet");
    });

    test("a helper that cannot run fails, and quotes why", () => {
      const code = doctorPrintLinuxSandbox(
        deps({
          run: (cmd) =>
            isCheck(cmd) ? { code: 126, stderr: "cannot execute\n" } : { code: 0, stderr: "" },
        }),
      );
      expect(code).toBe(2);
      expect(lines.at(-1)).toContain("cannot execute");
      expect(lines.join("\n")).not.toContain(ENFORCED);
    });

    test("a nested start that fails is not reported as enforced", () => {
      const code = doctorPrintLinuxSandbox(
        deps({
          run: (cmd) =>
            isNested(cmd)
              ? { code: 1, stderr: "bwrap: setting up uid map: Operation not permitted\n" }
              : { code: 0, stderr: "" },
        }),
      );
      expect(code).toBe(2);
      expect(lines.at(-1)).toContain("the network forwarder cannot start here");
      expect(lines.at(-1)).toContain("setting up uid map");
      expect(lines.join("\n")).not.toContain(ENFORCED);
    });

    test("a bwrap that cannot start reports only that, and tests no helper", () => {
      const code = doctorPrintLinuxSandbox(deps({ run: () => ({ code: 1, stderr: "" }) }));
      expect(code).toBe(2);
      expect(lines).toHaveLength(1);
    });

    describe("a probe that ran out of time", () => {
      const timedOut = { code: null, stderr: "", timedOut: true } as const;

      test("the nested start warns to re-run, and is not a refusal", () => {
        const code = doctorPrintLinuxSandbox(
          deps({ run: (cmd) => (isNested(cmd) ? timedOut : { code: 0, stderr: "" }) }),
        );
        expect(code).toBe(1);
        const last = lines.at(-1) ?? "";
        expect(last).toStartWith("[warn] Sandbox:");
        expect(last).toContain("Re-run nimbus doctor");
        expect(last).not.toContain("refused");
        expect(lines.join("\n")).not.toContain("[fail]");
        expect(lines.join("\n")).not.toContain(ENFORCED);
      });

      test("the helper's --check warns the same way", () => {
        const code = doctorPrintLinuxSandbox(
          deps({ run: (cmd) => (isCheck(cmd) ? timedOut : { code: 0, stderr: "" }) }),
        );
        expect(code).toBe(1);
        expect(lines.at(-1)).toContain("Re-run nimbus doctor");
      });

      test("bubblewrap's own start warns, and prints no AppArmor commands", () => {
        const code = doctorPrintLinuxSandbox(
          deps({ run: () => timedOut, apparmorFixApplies: () => true }),
        );
        expect(code).toBe(1);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toStartWith("[warn] Sandbox:");
      });

      test("a null exit that did not time out is still a failure", () => {
        const code = doctorPrintLinuxSandbox(
          deps({
            run: (cmd) =>
              isNested(cmd) ? { code: null, stderr: "", timedOut: false } : { code: 0, stderr: "" },
          }),
        );
        expect(code).toBe(2);
        expect(lines.at(-1)).toStartWith("[fail] Sandbox:");
      });
    });

    describe("what the running gateway says", () => {
      test("a gateway that refuses is a [fail], whatever the local probe found", () => {
        const code = doctorPrintLinuxSandbox(deps({}), {
          network: "refusing",
          reason: "the forwarder did not start",
        });
        expect(code).toBe(2);
        expect(lines.at(-1)).toStartWith("[fail] Sandbox: the running gateway refuses");
        expect(lines.at(-1)).toContain("the forwarder did not start");
        expect(lines.join("\n")).not.toContain(ENFORCED);
      });

      test("a gateway that cannot filter by host is a warning, not [ok]", () => {
        const code = doctorPrintLinuxSandbox(deps({}), { network: "all_or_nothing", reason: null });
        expect(code).toBe(1);
        expect(lines.at(-1)).toStartWith("[warn] Sandbox: the running gateway cannot filter");
        expect(lines.join("\n")).not.toContain(ENFORCED);
      });

      test("a gateway that enforces per host leaves the local result alone", () => {
        const code = doctorPrintLinuxSandbox(deps({}), { network: "per_host", reason: null });
        expect(code).toBe(0);
        expect(lines).toContain(ENFORCED);
      });

      test("no gateway: the local probe decides", () => {
        expect(doctorPrintLinuxSandbox(deps({}), undefined)).toBe(0);
      });
    });
  });
});

const RESTRICT = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/** A stock Ubuntu 24.04 unless a test says otherwise. */
function host(over: Partial<DoctorBwrapHost> = {}, files?: readonly string[]): DoctorBwrapHost {
  const present = new Set(files ?? ["/usr/bin/bwrap", "/etc/apparmor.d/abi/4.0"]);
  return {
    exists: (p) => present.has(p),
    read: () => "1\n",
    which: () => "/usr/sbin/apparmor_parser",
    env: () => undefined,
    execPath: "/home/owner/.local/bin/nimbus",
    ...over,
  };
}

describe("createDoctorBwrapDeps", () => {
  test("the default host answers without throwing, whatever this machine is", () => {
    const real = createDoctorBwrapDeps("linux");
    expect(typeof real.apparmorFixApplies("/usr/bin/bwrap")).toBe("boolean");
    const found = real.findBwrap();
    expect(found === null || typeof found === "string").toBe(true);
  });

  test("finds the first candidate, and no candidate means null", () => {
    expect(createDoctorBwrapDeps("linux", host()).findBwrap()).toBe("/usr/bin/bwrap");
    expect(createDoctorBwrapDeps("linux", host({}, [])).findBwrap()).toBeNull();
  });

  test("NIMBUS_BWRAP_PATH wins, and a missing override does not fall back to a candidate", () => {
    const env = () => "/opt/bwrap";
    expect(createDoctorBwrapDeps("linux", host({ env }, ["/opt/bwrap"])).findBwrap()).toBe(
      "/opt/bwrap",
    );
    expect(createDoctorBwrapDeps("linux", host({ env })).findBwrap()).toBeNull();
  });

  test("an empty override is no override", () => {
    const env = () => "";
    expect(createDoctorBwrapDeps("linux", host({ env })).findBwrap()).toBe("/usr/bin/bwrap");
  });

  describe("findHelper, in the gateway's order", () => {
    const find = (h: DoctorBwrapHost) => createDoctorBwrapDeps("linux", h).findHelper();
    const OVERRIDE = "/opt/helper";
    const overriding = () => OVERRIDE;

    test("a set override wins over a helper beside the program", () => {
      expect(find(host({ env: overriding }, [OVERRIDE, HELPER_BESIDE]))).toEqual({
        kind: "found",
        path: OVERRIDE,
      });
    });

    test("an override naming nothing does not fall through to a real helper", () => {
      expect(find(host({ env: overriding }, [HELPER_BESIDE]))).toEqual({
        kind: "override-missing",
        path: OVERRIDE,
      });
    });

    test("then beside the program, as a tarball and an AppImage install it", () => {
      expect(find(host({}, [HELPER_BESIDE, INSTALLED_HELPER]))).toEqual({
        kind: "found",
        path: HELPER_BESIDE,
      });
    });

    test("then the package's directory", () => {
      expect(find(host({}, [INSTALLED_HELPER]))).toEqual({ kind: "found", path: INSTALLED_HELPER });
    });

    test("nowhere is missing", () => {
      expect(find(host({}, []))).toEqual({ kind: "missing" });
    });

    test("an empty override is no override", () => {
      expect(find(host({ env: () => "" }, [HELPER_BESIDE]))).toEqual({
        kind: "found",
        path: HELPER_BESIDE,
      });
    });
  });

  test("the default ids are this process's", () => {
    const { ids } = createDoctorBwrapDeps("linux", host());
    expect(ids().uid).toBe(process.getuid?.() ?? 0);
    expect(ids().gid).toBe(process.getgid?.() ?? 0);
  });

  test("run reports the real exit code and stderr", () => {
    const { run } = createDoctorBwrapDeps("linux", host());
    const r = run([process.execPath, "-e", "console.error('nope'); process.exit(3)"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("nope");
  });

  test("run reports a binary that cannot start rather than throwing", () => {
    const { run } = createDoctorBwrapDeps("linux", host());
    const r = run(["/no/such/nimbus-binary"]);
    expect(r.code === null || r.code !== 0).toBe(true);
  });

  describe("apparmorFixApplies matches what the install block would do", () => {
    const applies = (h: DoctorBwrapHost): boolean =>
      createDoctorBwrapDeps("linux", h).apparmorFixApplies("/usr/bin/bwrap");

    test("stock Ubuntu 24.04: yes", () => {
      expect(applies(host())).toBe(true);
    });

    test("restriction off: no", () => {
      expect(applies(host({ read: () => "0\n" }))).toBe(false);
    });

    test("no such sysctl: no", () => {
      const read = (p: string): string => {
        expect(p).toBe(RESTRICT);
        throw new Error("ENOENT");
      };
      expect(applies(host({ read }))).toBe(false);
    });

    test("an AppArmor too old for the rule: no", () => {
      expect(applies(host({}, ["/usr/bin/bwrap"]))).toBe(false);
    });

    test("a bwrap other than the profile's path: no, even when /usr/bin/bwrap also exists", () => {
      const deps = createDoctorBwrapDeps("linux", host());
      expect(deps.apparmorFixApplies("/opt/bwrap")).toBe(false);
    });

    test("a bwrap profile already installed: no", () => {
      for (const existing of ["/etc/apparmor.d/bwrap", "/etc/apparmor.d/bwrap-userns-restrict"]) {
        const files = ["/usr/bin/bwrap", "/etc/apparmor.d/abi/4.0", existing];
        expect(applies(host({}, files))).toBe(false);
      }
    });

    test("no apparmor_parser: no", () => {
      expect(applies(host({ which: () => null }))).toBe(false);
    });
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

describe("gatewaySandboxPosture", () => {
  const snap = (caps: unknown): unknown => ({ sandbox: { platform_capabilities: caps } });

  test("reads the network posture and reason diag.snapshot carries", () => {
    expect(gatewaySandboxPosture(snap({ network: "refusing", reason: "why" }))).toEqual({
      network: "refusing",
      reason: "why",
    });
    expect(gatewaySandboxPosture(snap({ network: "per_host", reason: null }))).toEqual({
      network: "per_host",
      reason: null,
    });
  });

  test("anything else is undefined, so an older gateway leaves doctor to its own probe", () => {
    for (const bad of [
      undefined,
      null,
      "x",
      {},
      { sandbox: null },
      snap({ network: "open" }),
      snap(null),
    ]) {
      expect(gatewaySandboxPosture(bad)).toBeUndefined();
    }
  });
});
