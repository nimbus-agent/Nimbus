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
 * Test-only: it confines nothing and must never be reachable from production code.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  SANDBOX_OBSERVATION_FILE_ENV,
  SANDBOX_OBSERVATION_LABEL_ENV,
} from "../../src/platform/sandbox/sandbox-policy.ts";
import type {
  SandboxRunner,
  SandboxSpawnOptions,
} from "../../src/platform/sandbox/sandbox-runner.ts";
import { runSandboxWrapper } from "../../src/platform/sandbox/sandbox-wrapper.ts";

const ready = process.argv[2];
const mode = process.argv[3];
const stay = mode === "stay";
/** With `argv[4]` `observed` the stand-in says the child runs behind a forwarder, as Linux would. */
const observed = process.argv[4] === "observed";
if (ready === undefined) throw new Error("usage: sandbox-wrapper-observed.ts <ready-file>");

const childScript = [
  'const fs = require("fs");',
  `const seen = [${JSON.stringify(SANDBOX_OBSERVATION_FILE_ENV)}, ${JSON.stringify(SANDBOX_OBSERVATION_LABEL_ENV)}].some((k) => k in process.env);`,
  `fs.writeFileSync(${JSON.stringify(ready)}, seen ? "present" : "absent");`,
  stay ? "setInterval(() => {}, 1000);" : "process.exit(0);",
].join("\n");

const standIn: SandboxRunner = {
  platform: "linux",
  spawn(cmd: string, args: string[], opts: SandboxSpawnOptions): ChildProcess {
    if (mode === "refuse") throw new Error("the policy was refused");
    const command = mode === "error" ? `${cmd}-does-not-exist` : cmd;
    const child = spawn(command, args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: "ignore",
      windowsHide: true,
    });
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

await runSandboxWrapper([process.execPath, "-e", childScript], {
  createRunner: () => Promise.resolve(standIn),
});
