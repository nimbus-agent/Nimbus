import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createForwarderDir,
  ForwarderSocketPathError,
  forwarderPathRefusal,
  openForwarderSession,
  resolveHelperPath,
  runForwarderStartProbe,
} from "./linux-forwarder.ts";
import { type ForwardEntry, planForwardEntries } from "./net-forward-host.ts";
import { declaresNetwork, type SandboxPolicy } from "./sandbox-policy.ts";

/**
 * The parts of the forwarder's spawn path that need no `bwrap`: the private directory, the session
 * and the start probe's reporting, against stand-in programs. The real thing is in
 * `linux-forwarder-network.test.ts`, which needs a built helper and so does not run in every job.
 * Linux only: these use unix sockets at POSIX paths and spawn real programs.
 */
const IS_LINUX = process.platform === "linux";

const policyWith = (over: Partial<SandboxPolicy["permissions"]> = {}): SandboxPolicy => ({
  id: "session-test",
  permissions: {
    network: ["api.example.com"],
    filesystem: { read: [], write: [] },
    ...over,
  },
});

describe.skipIf(!IS_LINUX)("the forwarder's spawn path, without bwrap", () => {
  let root = "";
  const savedEnv = {
    XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"],
    TMPDIR: process.env["TMPDIR"],
  };

  beforeAll(() => {
    root = mkdtempSync("/tmp/nf-unit-");
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const freshDir = (): string => mkdtempSync(join(root, "d-"));

  describe("createForwarderDir", () => {
    test("prefers the runtime directory, then TMPDIR, then /tmp, and makes it 0700", () => {
      const runtime = freshDir();
      const tmp = freshDir();
      const first = createForwarderDir([], { XDG_RUNTIME_DIR: runtime, TMPDIR: tmp });
      expect(first.startsWith(`${runtime}/nf-`)).toBe(true);
      expect(statSync(first).mode & 0o777).toBe(0o700);

      const second = createForwarderDir([], {
        XDG_RUNTIME_DIR: join(root, "missing"),
        TMPDIR: tmp,
      });
      expect(second.startsWith(`${tmp}/nf-`)).toBe(true);

      const third = createForwarderDir([], { TMPDIR: "relative/path" });
      expect(third.startsWith("/tmp/nf-")).toBe(true);
      rmSync(third, { recursive: true });
    });

    test("falls back when a candidate's path would not fit in 107 bytes", () => {
      const long = join(root, "x".repeat(90));
      mkdirSync(long);
      const dir = createForwarderDir([], { XDG_RUNTIME_DIR: long });
      expect(dir.startsWith("/tmp/nf-")).toBe(true);
      rmSync(dir, { recursive: true });
    });

    test("falls back when a candidate refuses a new directory", () => {
      const notADir = join(freshDir(), "file");
      writeFileSync(notADir, "");
      const dir = createForwarderDir([], { XDG_RUNTIME_DIR: notADir });
      expect(dir.startsWith("/tmp/nf-")).toBe(true);
      rmSync(dir, { recursive: true });
    });

    test("compares real paths: a symlinked candidate inside a bound path is skipped", () => {
      const runtime = freshDir();
      const realpath = (p: string): string => (p === "/link/run" ? runtime : p);
      const dir = createForwarderDir([runtime], { XDG_RUNTIME_DIR: "/link/run" }, realpath);
      expect(dir.startsWith("/link/run")).toBe(false);
      rmSync(dir, { recursive: true });
    });

    test("compares real paths: a candidate inside a symlinked bound path is skipped", () => {
      const runtime = freshDir();
      const realpath = (p: string): string => (p === "/link/bound" ? runtime : p);
      const dir = createForwarderDir(["/link/bound"], { XDG_RUNTIME_DIR: runtime }, realpath);
      expect(dir.startsWith(runtime)).toBe(false);
      rmSync(dir, { recursive: true });
    });

    test("names what it tried when nothing can hold it", () => {
      const runtime = freshDir();
      let message = "";
      try {
        createForwarderDir([runtime, "/tmp"], { XDG_RUNTIME_DIR: runtime });
      } catch (e) {
        expect(e).toBeInstanceOf(ForwarderSocketPathError);
        message = (e as Error).message;
      }
      expect(message).toContain(runtime);
      expect(message).toContain("107");
    });
  });

  describe("openForwarderSession", () => {
    const openIn = (runtime: string, policy: SandboxPolicy, entries?: readonly ForwardEntry[]) => {
      process.env["XDG_RUNTIME_DIR"] = runtime;
      const cwd = freshDir();
      return {
        cwd,
        session: openForwarderSession({
          policy,
          cwd,
          helperPath: "/opt/helper",
          entries: entries ?? planForwardEntries(policy),
          innerArgv: ["/usr/bin/bwrap", "--seccomp", "3", "/opt/app"],
          resolvConfTarget: "/etc/resolv.conf",
          log: () => undefined,
        }),
      };
    };

    test("writes the files, binds the socket, and builds the argv", () => {
      const runtime = freshDir();
      const { session } = openIn(runtime, policyWith());
      const dir = join(runtime, readdirSync(runtime)[0] ?? "");
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(readFileSync(join(dir, "hosts"), "utf8")).toBe(
        "127.0.0.1 localhost localhost.\n127.0.0.2 api.example.com api.example.com.\n",
      );
      expect(readFileSync(join(dir, "resolv.conf"), "utf8")).toBe("nameserver 127.0.0.53\n");
      expect(existsSync(join(dir, "s"))).toBe(true);
      expect(session.argv).toContain(join(dir, "s"));
      session.close();
      expect(readdirSync(runtime)).toEqual([]);
    });

    test("closing twice is harmless, and stops listening for the process's exit", () => {
      const runtime = freshDir();
      const before = process.listenerCount("exit");
      const { session } = openIn(runtime, policyWith());
      expect(process.listenerCount("exit")).toBe(before + 1);
      session.close();
      session.close();
      expect(process.listenerCount("exit")).toBe(before);
    });

    test("a policy that binds / says so, and not that no directory could hold the socket", () => {
      const runtime = freshDir();
      const root_ = policyWith({ filesystem: { read: ["/"], write: [] } });
      expect(() => openIn(runtime, root_)).toThrow(/runtime directory/);
    });

    test("a policy the view would refuse leaves no directory behind", () => {
      const runtime = freshDir();
      const wide = policyWith({ filesystem: { read: ["/run"], write: [] } });
      expect(() => openIn(runtime, wide)).toThrow(/runtime directory/);
      expect(readdirSync(runtime)).toEqual([]);
    });

    test("a name that cannot go in /etc/hosts leaves no directory behind", () => {
      const runtime = freshDir();
      const bad: ForwardEntry = {
        host: "evil\n1.2.3.4 api.github.com",
        port: 443,
        trust: "package",
        loopbackIp: "127.0.0.2",
      };
      expect(() => openIn(runtime, policyWith(), [bad])).toThrow(/hosts/);
      expect(readdirSync(runtime)).toEqual([]);
    });
  });

  describe("runForwarderStartProbe's report", () => {
    const seccomp = (): string => {
      const path = join(freshDir(), "seccomp.bpf");
      writeFileSync(path, "");
      return path;
    };

    function standIn(body: string): string {
      const path = join(freshDir(), "bwrap");
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    }

    const probeResult = (
      bwrapPath: string,
      seccompPath = seccomp(),
      timeoutMs = 5000,
      tempRoot?: string,
    ) =>
      runForwarderStartProbe({
        bwrapPath,
        helperPath: "/opt/helper",
        seccompPath,
        buildInnerFlags: () => ["--share-net"],
        timeoutMs,
        ...(tempRoot === undefined ? {} : { tempRoot }),
      });
    const probe = async (bwrapPath: string, seccompPath = seccomp(), timeoutMs = 5000) =>
      (await probeResult(bwrapPath, seccompPath, timeoutMs)).failure;

    test("a start that exits 0 is null", async () => {
      expect(await probe(standIn("exit 0"))).toBeNull();
    });

    test("a failed start reports its exit code and what it said", async () => {
      expect(await probe(standIn("echo broken >&2; exit 6"))).toBe("exit 6: broken");
    });

    test("a silent failure still reports its exit code", async () => {
      expect(await probe(standIn("exit 3"))).toBe("exit 3");
    });

    test("a start killed by a signal says so", async () => {
      expect(await probe(standIn("kill -9 $$"))).toBe("signal SIGKILL");
    });

    test("a start that hangs is killed and reported", async () => {
      expect(await probe(standIn("exec /usr/bin/sleep 60"), seccomp(), 100)).toContain(
        "did not finish within 100 ms",
      );
    });

    test("only a start that hangs is marked as one to ask again", async () => {
      expect((await probeResult(standIn("exec /usr/bin/sleep 60"), seccomp(), 100)).timedOut).toBe(
        true,
      );
      expect((await probeResult(standIn("exit 6"))).timedOut).toBe(false);
      expect((await probeResult(standIn("exit 0"))).timedOut).toBe(false);
    });

    test("no temp directory for the probe is a refusal, not a rejection that fails boot", async () => {
      const result = await probeResult(standIn("exit 0"), seccomp(), 5000, join(root, "missing"));
      expect(result.failure).not.toBeNull();
      expect(result.timedOut).toBe(false);
    });

    test("a bwrap that cannot run is a refusal, not a throw", async () => {
      expect(await probe(join(root, "no-such-bwrap"))).not.toBeNull();
    });

    test("a setup failure is a refusal, not a throw", async () => {
      const failure = await probe(standIn("exit 0"), join(root, "no-such-seccomp"));
      expect(failure).toContain("no-such-seccomp");
    });

    test("leaves nothing behind in the runtime directory", async () => {
      const runtime = freshDir();
      process.env["XDG_RUNTIME_DIR"] = runtime;
      await probe(standIn("exit 0"));
      expect(readdirSync(runtime)).toEqual([]);
    });
  });
});

describe("the forwarder's small rules", () => {
  test("an empty helper override is no override", () => {
    const env = { NIMBUS_SANDBOX_HELPER_PATH: "" };
    expect(resolveHelperPath("/opt/gw", env, (p) => p === "/opt/nimbus-sandbox-helper")).toBe(
      "/opt/nimbus-sandbox-helper",
    );
  });

  test("wildcards alone declare a network, and an empty policy does not", () => {
    expect(declaresNetwork(policyWith({ network: [] }))).toBe(false);
    expect(declaresNetwork(policyWith())).toBe(true);
    expect(
      declaresNetwork({
        ...policyWith({ network: [] }),
        firstPartyWildcardHosts: ["*.sharepoint.com"],
      }),
    ).toBe(true);
  });

  test("a path that cannot be resolved is judged as written", () => {
    const realpath = (): string => {
      throw new Error("ENOENT");
    };
    const context = { env: {}, home: "/home/o", uid: 1000, realpath };
    expect(
      forwarderPathRefusal(policyWith({ filesystem: { read: ["/opt/x"], write: [] } }), context),
    ).toBeNull();
    expect(
      forwarderPathRefusal(policyWith({ filesystem: { read: ["/run/"], write: [] } }), context),
    ).toContain("/run/");
  });

  test("with no runtime directory set, the usual one for this uid is still protected", () => {
    const context = { env: {}, home: "/home/o", uid: 1000, realpath: (p: string): string => p };
    expect(
      forwarderPathRefusal(
        policyWith({ filesystem: { read: ["/run/user/1000"], write: [] } }),
        context,
      ),
    ).not.toBeNull();
  });

  test("$HOME and the runtime directory are compared by where they really are", () => {
    const realpath = (p: string): string => {
      if (p === "/home/o") return "/data/home/o";
      if (p === "/xdg") return "/data/run";
      return p;
    };
    const context = { env: { XDG_RUNTIME_DIR: "/xdg" }, home: "/home/o", uid: 1000, realpath };
    expect(forwarderPathRefusal(policyWith(), { ...context, cwd: "/data/home/o" })).toContain(
      "$HOME",
    );
    expect(
      forwarderPathRefusal(policyWith({ filesystem: { read: ["/data/run"], write: [] } }), context),
    ).toContain("runtime directory");
  });

  test("a cwd below $HOME is fine, which is where a real one lives", () => {
    const context = { env: {}, home: "/home/o", uid: 1000, realpath: (p: string): string => p };
    expect(
      forwarderPathRefusal(policyWith(), { ...context, cwd: "/home/o/.local/share/x" }),
    ).toBeNull();
  });
});
