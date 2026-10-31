/**
 * `nimbus doctor` runs its own copy of the gateway's per-host start, because the CLI may not import
 * the gateway. A copy drifts: a capability added to one and not the other makes doctor print
 * "declared hosts are enforced" on a machine where the gateway refuses. This file is the one place
 * that may import both, and it fails when the two disagree.
 */
import { describe, expect, test } from "bun:test";
import {
  HELPER_IN_SANDBOX as DOCTOR_HELPER_IN_SANDBOX,
  type DoctorBwrapHost,
  findHelper,
  nestedStartCommand,
} from "../packages/cli/src/commands/doctor-bwrap.ts";
import { buildForwarderInnerFlags } from "../packages/gateway/src/platform/sandbox/linux.ts";
import {
  buildForwarderArgv,
  HELPER_IN_SANDBOX,
  helperOverrideRefusal,
  resolveHelperPath,
} from "../packages/gateway/src/platform/sandbox/linux-forwarder.ts";
import { planForwardEntries } from "../packages/gateway/src/platform/sandbox/net-forward-host.ts";
import type { SandboxPolicy } from "../packages/gateway/src/platform/sandbox/sandbox-policy.ts";

const BWRAP = "/usr/bin/bwrap";
const HELPER = "/usr/lib/nimbus/bin/nimbus-sandbox-helper";
const FWD_CWD = "/home/owner/.local/share/nimbus/sandbox/x";
const SOCKET_DIR = "/tmp/nf-abc";

const policy: SandboxPolicy = {
  id: "doctor-parity",
  permissions: { network: ["api.example.com"], filesystem: { read: [], write: [] } },
};

function gatewayArgv(): { outer: string[]; inner: string[] } {
  const innerArgv = [
    BWRAP,
    ...buildForwarderInnerFlags(policy, FWD_CWD),
    "--seccomp",
    "3",
    "/usr/bin/true",
  ];
  const all = buildForwarderArgv(policy, {
    cwd: FWD_CWD,
    helperPath: HELPER,
    socketDir: SOCKET_DIR,
    hostsFile: `${SOCKET_DIR}/hosts`,
    resolvFile: `${SOCKET_DIR}/resolv.conf`,
    resolvConfTarget: "/etc/resolv.conf",
    entries: planForwardEntries(policy),
    innerArgv,
    pathContext: {
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      home: "/home/owner",
      uid: 1000,
      realpath: (p: string): string => p,
    },
  });
  const split = all.indexOf("--");
  return { outer: all.slice(0, split), inner: all.slice(split + 1) };
}

function doctorArgv(): { outer: string[]; inner: string[] } {
  const all = nestedStartCommand(BWRAP, HELPER, { uid: 1000, gid: 1000 }).slice(1);
  const split = all.indexOf("--");
  return { outer: all.slice(0, split), inner: all.slice(split + 2) };
}

/** Every value that follows `flag`, in order. */
const valuesOf = (argv: readonly string[], flag: string): string[] =>
  argv.flatMap((a, i) => (a === flag ? [argv[i + 1] ?? ""] : []));

/** The flags that decide what a start is allowed to do: namespaces, the id it maps to, capabilities. */
const POSTURE_FLAGS = [
  "--unshare-user",
  "--unshare-net",
  "--unshare-pid",
  "--unshare-uts",
  "--unshare-ipc",
  "--share-net",
  "--new-session",
  "--die-with-parent",
] as const;

function posture(argv: readonly string[]): {
  flags: string[];
  caps: string[];
  capDrops: string[];
} {
  return {
    flags: POSTURE_FLAGS.filter((f) => argv.includes(f)),
    caps: valuesOf(argv, "--cap-add"),
    capDrops: valuesOf(argv, "--cap-drop"),
  };
}

describe("doctor's nested start against buildForwarderArgv", () => {
  const gateway = gatewayArgv();
  const doctor = doctorArgv();

  test("the outer bwrap makes the same namespaces and keeps the same capabilities", () => {
    expect(posture(doctor.outer)).toEqual(posture(gateway.outer));
    // Guards the comparison itself: an empty posture on both sides would agree about nothing.
    expect(posture(gateway.outer).caps.length).toBeGreaterThanOrEqual(3);
    expect(posture(gateway.outer).flags).toContain("--unshare-net");
  });

  test("the outer bwrap is uid 0 and gid 0", () => {
    expect(valuesOf(doctor.outer, "--uid")).toEqual(valuesOf(gateway.outer, "--uid"));
    expect(valuesOf(doctor.outer, "--gid")).toEqual(valuesOf(gateway.outer, "--gid"));
    expect(valuesOf(gateway.outer, "--uid")).toEqual(["0"]);
  });

  test("the inner bwrap makes the same namespaces and drops the same capabilities", () => {
    expect(posture(doctor.inner)).toEqual(posture(gateway.inner));
    expect(posture(gateway.inner).flags).toContain("--share-net");
    expect(posture(gateway.inner).capDrops).toEqual(["ALL"]);
  });

  test("the inner bwrap maps the owner's real uid and gid", () => {
    expect(valuesOf(doctor.inner, "--uid")).toEqual(["1000"]);
    expect(valuesOf(gateway.inner, "--uid")).toHaveLength(1);
    expect(valuesOf(doctor.inner, "--gid")).toHaveLength(valuesOf(gateway.inner, "--gid").length);
  });

  test("the helper is bound at the same fixed path and run from it", () => {
    expect(DOCTOR_HELPER_IN_SANDBOX).toBe(HELPER_IN_SANDBOX);
    for (const outer of [doctor.outer, gateway.outer]) {
      const at = outer.findIndex(
        (a, i) =>
          a === "--ro-bind" && outer[i + 1] === HELPER && outer[i + 2] === HELPER_IN_SANDBOX,
      );
      expect(at).toBeGreaterThanOrEqual(0);
      expect(outer).toContain(HELPER_IN_SANDBOX);
    }
  });

  test("the helper is given a socket, a listener in the gateway's form, and a resolver", () => {
    for (const outer of [doctor.outer, gateway.outer]) {
      expect(valuesOf(outer, "--socket")).toHaveLength(1);
      expect(valuesOf(outer, "--dns")).toHaveLength(1);
      for (const listen of valuesOf(outer, "--listen")) {
        expect(listen).toMatch(/^\d+\.\d+\.\d+\.\d+:\d+:\d+$/);
      }
    }
    expect(valuesOf(doctor.outer, "--dns")).toEqual(valuesOf(gateway.outer, "--dns"));
  });
});

type HelperCase = {
  name: string;
  execPath: string;
  env: Record<string, string>;
  present: string[];
  /** What the gateway resolves, or null for none. */
  path: string | null;
  /** What doctor says. */
  kind: "found" | "override-missing" | "missing";
};

const EXEC = "/home/owner/.local/bin/nimbus-gateway";
const CLI_EXEC = "/home/owner/.local/bin/nimbus";
const BESIDE = "/home/owner/.local/bin/nimbus-sandbox-helper";
const INSTALLED = "/usr/lib/nimbus/bin/nimbus-sandbox-helper";
const OVERRIDE = "/opt/custom/helper";

const HELPER_CASES: readonly HelperCase[] = [
  {
    name: "an override that exists wins over everything",
    execPath: EXEC,
    env: { NIMBUS_SANDBOX_HELPER_PATH: OVERRIDE },
    present: [OVERRIDE, BESIDE, INSTALLED],
    path: OVERRIDE,
    kind: "found",
  },
  {
    name: "an override naming nothing is a refusal, not a fall through to another binary",
    execPath: EXEC,
    env: { NIMBUS_SANDBOX_HELPER_PATH: OVERRIDE },
    present: [BESIDE, INSTALLED],
    path: null,
    kind: "override-missing",
  },
  {
    name: "an empty override is no override",
    execPath: EXEC,
    env: { NIMBUS_SANDBOX_HELPER_PATH: "" },
    present: [BESIDE],
    path: BESIDE,
    kind: "found",
  },
  {
    name: "next, a helper beside the executable",
    execPath: EXEC,
    env: {},
    present: [BESIDE, INSTALLED],
    path: BESIDE,
    kind: "found",
  },
  {
    name: "the CLI and the gateway share a directory, so both look in the same place",
    execPath: CLI_EXEC,
    env: {},
    present: [BESIDE],
    path: BESIDE,
    kind: "found",
  },
  {
    name: "next, the installed path",
    execPath: EXEC,
    env: {},
    present: [INSTALLED],
    path: INSTALLED,
    kind: "found",
  },
  {
    name: "else none",
    execPath: EXEC,
    env: {},
    present: [],
    path: null,
    kind: "missing",
  },
];

describe("doctor's helper lookup against the gateway's", () => {
  for (const c of HELPER_CASES) {
    test(c.name, () => {
      const present = new Set(c.present);
      const exists = (p: string): boolean => present.has(p);
      const host: DoctorBwrapHost = {
        exists,
        read: () => "",
        which: () => null,
        env: (name) => c.env[name],
        execPath: c.execPath,
      };
      const gateway = resolveHelperPath(c.execPath, c.env, exists);
      const doctor = findHelper(host);

      expect(gateway).toBe(c.path);
      expect(doctor.kind).toBe(c.kind);
      // The same answer, not just the same shape.
      expect(doctor.kind === "found" ? doctor.path : null).toBe(gateway);
      // The override refusal is the gateway's own reading of "names nothing".
      expect(helperOverrideRefusal(c.env, exists) !== null).toBe(c.kind === "override-missing");
    });
  }
});
