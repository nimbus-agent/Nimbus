/**
 * The real `runSandboxWrapper`, with a stand-in runner that spawns its child unconfined, for
 * `network-observation-writer.test.ts`'s signal case. The stand-in reports one used connection
 * through the spawn's observer at process exit, as the Linux forwarder's session close does, and
 * its child writes `argv[2]`
 * ("absent" when the observation variables did not reach it) once it is running. With `argv[3]`
 * `stay` the child keeps running until the wrapper is stopped; with `refuse` the stand-in throws
 * from `spawn`, as a refused policy does; with `error` it spawns a command that does not exist, so
 * the child emits `error` and never `spawn`; otherwise the child exits at once.
 *
 * With `poll` the stand-in is a Windows runner and the wrapper gets a fake connection source and a
 * fake resolver through its test-only deps: the source reports its connections only once the child
 * has exited, so they reach the final file only if the wrapper stops the poller (its last poll)
 * before `process.exit` closes the writer. The resolver appends each name it is asked for to
 * `<ready>.resolved`. With `poll-fail` the source fails to open; with `poll-load-fail` loading
 * the platform's opener throws, as a failed dynamic import would.
 *
 * Test-only: it confines nothing and must never be reachable from production code.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { ConnectionSource } from "../../src/platform/sandbox/observe/types.ts";
import {
  SANDBOX_OBSERVATION_FILE_ENV,
  SANDBOX_OBSERVATION_LABEL_ENV,
} from "../../src/platform/sandbox/sandbox-policy.ts";
import type {
  SandboxRunner,
  SandboxSpawnOptions,
} from "../../src/platform/sandbox/sandbox-runner.ts";
import {
  runSandboxWrapper,
  type SandboxWrapperDeps,
} from "../../src/platform/sandbox/sandbox-wrapper.ts";

const ready = process.argv[2];
const mode = process.argv[3];
const stay = mode === "stay";
/** With `argv[4]` `observed` the stand-in says the child runs behind a forwarder, as Linux would. */
const observed = process.argv[4] === "observed";
const polled = mode === "poll" || mode === "poll-fail" || mode === "poll-load-fail";
if (ready === undefined) throw new Error("usage: sandbox-wrapper-observed.ts <ready-file>");

const childScript = [
  'const fs = require("fs");',
  `const seen = [${JSON.stringify(SANDBOX_OBSERVATION_FILE_ENV)}, ${JSON.stringify(SANDBOX_OBSERVATION_LABEL_ENV)}].some((k) => k in process.env);`,
  `fs.writeFileSync(${JSON.stringify(ready)}, seen ? "present" : "absent");`,
  stay ? "setInterval(() => {}, 1000);" : "process.exit(0);",
].join("\n");

/** Set by the stand-in's own exit listener, which runs before the wrapper's. */
let childExited = false;
let childPid = 0;

const standIn: SandboxRunner = {
  platform: polled ? "win32" : "linux",
  spawn(cmd: string, args: string[], opts: SandboxSpawnOptions): ChildProcess {
    if (mode === "refuse") throw new Error("the policy was refused");
    const command = mode === "error" ? `${cmd}-does-not-exist` : cmd;
    const child = spawn(command, args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("exit", () => {
      childExited = true;
    });
    childPid = child.pid ?? 0;
    if (polled) return child;
    // Reported from an exit listener registered here, inside `spawn`, exactly as the forwarder
    // session reports a relay still open when it closes: the wrapper's writer must close after it.
    process.once("exit", () => {
      opts.observer?.used("api.github.com", 443);
      child.kill("SIGKILL");
    });
    if (observed) opts.observer?.markObserved();
    return child;
  },
  isFullyActive: () => true,
  degradedReason: () => null,
  canConfine: () => null,
};

/** Nothing until the child has exited; then a declared host, an undeclared address and loopback. */
const fakeSource: ConnectionSource = {
  poll: () =>
    childExited
      ? [
          { pid: childPid, localPort: 50_001, remoteIp: "140.82.112.5", remotePort: 443 },
          { pid: childPid, localPort: 50_002, remoteIp: "203.0.113.7", remotePort: 443 },
          { pid: childPid, localPort: 50_003, remoteIp: "127.0.0.1", remotePort: 9000 },
        ]
      : [],
  close: () => undefined,
};

const pollDeps: SandboxWrapperDeps = {
  openConnectionSource: () =>
    mode === "poll-fail" ? { error: "the connection table cannot be read" } : fakeSource,
  resolveHost: (host) => {
    appendFileSync(`${ready}.resolved`, `${host}\n`);
    return Promise.resolve(host === "api.github.com" ? ["140.82.112.5"] : []);
  },
  pollPeriodMs: 20,
};

/** No injected opener: the wrapper must load one, and the load throws. */
const loadFailDeps: SandboxWrapperDeps = {
  loadConnectionSourceOpener: () => Promise.reject(new Error("the source module did not load")),
};

await runSandboxWrapper([process.execPath, "-e", childScript], {
  createRunner: () => Promise.resolve(standIn),
  ...(mode === "poll-load-fail" ? loadFailDeps : polled ? pollDeps : {}),
});
