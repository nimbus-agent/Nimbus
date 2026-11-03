/**
 * The real `runSandboxWrapper`, with a stand-in runner that spawns its child unconfined, for
 * `network-observation-writer.test.ts`'s signal case. The stand-in reports one used connection
 * through the spawn's observer, as the Linux forwarder would, and its child writes `argv[2]`
 * ("absent" when the observation variables did not reach it) once it is running. With `argv[3]`
 * `stay` the child keeps running until the wrapper is stopped; otherwise it exits at once.
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
const stay = process.argv[3] === "stay";
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
    const child = spawn(cmd, args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: "ignore",
      windowsHide: true,
    });
    process.once("exit", () => child.kill("SIGKILL"));
    opts.observer?.used("api.github.com", 443);
    return child;
  },
  isFullyActive: () => true,
  degradedReason: () => null,
  canConfine: () => null,
};

await runSandboxWrapper([process.execPath, "-e", childScript], {
  createRunner: () => Promise.resolve(standIn),
});
