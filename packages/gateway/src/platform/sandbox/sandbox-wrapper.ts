import { constants as osConstants } from "node:os";
import {
  parseSandboxPolicy,
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
  type SandboxPolicy,
} from "./sandbox-policy.ts";
import { createSandboxRunner } from "./sandbox-runner.ts";

function fatal(msg: string): never {
  process.stderr.write(`nimbus-sandbox-wrapper: ${msg}\n`);
  process.exit(2);
}

/**
 * The `__nimbus-sandbox` role of the gateway executable: re-exec the requested command inside the
 * platform sandbox. `args` is everything after the sentinel — the original command followed by its
 * own arguments.
 */
export async function runSandboxWrapper(args: readonly string[]): Promise<never> {
  if (args.length < 1) {
    fatal("usage: <gateway> __nimbus-sandbox <cmd> [...args]");
  }
  const originalCmd = args[0];
  if (originalCmd === undefined) {
    fatal("missing original command");
  }
  const originalArgs = args.slice(1);

  const policyJson = process.env[SANDBOX_POLICY_ENV];
  if (policyJson === undefined || policyJson === "") {
    fatal(`${SANDBOX_POLICY_ENV} not set`);
  }
  const cwd = process.env[SANDBOX_CWD_ENV];
  if (cwd === undefined || cwd === "") {
    fatal(`${SANDBOX_CWD_ENV} not set`);
  }

  let policy: SandboxPolicy;
  try {
    policy = parseSandboxPolicy(policyJson);
  } catch (e) {
    fatal(`invalid ${SANDBOX_POLICY_ENV}: ${(e as Error).message}`);
  }

  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === SANDBOX_POLICY_ENV || k === SANDBOX_CWD_ENV) continue;
    if (v !== undefined) childEnv[k] = v;
  }

  const runner = await createSandboxRunner();
  const child = runner.spawn(originalCmd, originalArgs, {
    policy,
    env: childEnv,
    cwd,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal !== null) {
      const signals = osConstants.signals as Record<string, number | undefined>;
      const num = signals[signal] ?? 0;
      process.exit(128 + num);
    }
    process.exit(code ?? 1);
  });
  child.on("error", (err) => fatal(`child spawn failed: ${err.message}`));

  return new Promise<never>(() => {});
}
