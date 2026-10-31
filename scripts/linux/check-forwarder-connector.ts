// Real first-party connectors through the real per-host path: a compiled gateway, its sandbox role,
// its bundled connectors and real requests. The credentials are made up, so a service can only answer
// that they are bad, and that answer is the proof: the request left the sandbox, through the
// forwarder, over real TLS, to a declared host. A policy with no way out would fail differently.
//
// - `github` is a plain HTTP connector.
// - `aws` starts the real `aws` CLI, so it also proves a subprocess, a wildcard host and a clean exit.
// - `gcloud --version` and `az --version` run under their connector's policy where the tool exists,
//   because each is a shell script over a runtime, the shape the seccomp filter and a missing `/bin`
//   used to kill.
//
// No retries, on purpose: a retry would hide a flaky path, and this path has to work the first time.
// A service the host itself cannot reach, outside the sandbox, is a skip with a loud line.
//
// Usage: bun scripts/linux/check-forwarder-connector.ts <path to the compiled nimbus-gateway>
// Needs NIMBUS_SANDBOX_HELPER_PATH, and the internet.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { manifestForFirstParty } from "../../packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts";
import {
  policyFromManifest,
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
  type SandboxPolicy,
} from "../../packages/gateway/src/platform/sandbox/sandbox-policy.ts";

const RUN_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 120_000;
const HOST_REACH_TIMEOUT_MS = 15_000;
const STDERR_TAIL_CHARS = 1000;
const TEXT_TAIL_CHARS = 300;
const SECCOMP_KILLED_EXIT = 159;
const INITIALIZE_ID = 1;
const LIST_ID = 2;
const CALL_ID = 3;
const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

type ToolResult = { content?: { text?: string }[]; isError?: boolean };
type RpcMessage = { id?: number; result?: { tools?: unknown[] } & ToolResult };

function fail(message: string): never {
  console.error(`check-forwarder-connector: ${message}`);
  process.exit(1);
}

const gatewayArg = process.argv[2];
if (gatewayArg === undefined) fail("usage: check-forwarder-connector.ts <nimbus-gateway>");
if (process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined) {
  fail("NIMBUS_SANDBOX_HELPER_PATH is not set, so this would not test the forwarder");
}
const gateway = realpathSync(resolve(gatewayArg));

function policyFor(connector: string): SandboxPolicy {
  const policy = policyFromManifest(manifestForFirstParty(connector));
  return {
    ...policy,
    permissions: {
      ...policy.permissions,
      // A compiled gateway outside /usr has to be readable to run as the connector, as a real install
      // under /usr/lib/nimbus needs no grant for it.
      filesystem: {
        ...policy.permissions.filesystem,
        read: [...policy.permissions.filesystem.read, dirname(gateway)],
      },
    },
  };
}

function wrapperEnv(policy: SandboxPolicy, extra: Record<string, string>): Record<string, string> {
  return {
    PATH: CHILD_PATH,
    HOME: process.env["HOME"] ?? "/tmp",
    NIMBUS_SANDBOX_HELPER_PATH: process.env["NIMBUS_SANDBOX_HELPER_PATH"] ?? "",
    [SANDBOX_POLICY_ENV]: JSON.stringify(policy),
    [SANDBOX_CWD_ENV]: join(mkdtempSync(join(tmpdir(), "nimbus-forwarder-proof-")), "cwd"),
    ...extra,
  };
}

type ConnectorProof = {
  connector: string;
  env: Record<string, string>;
  tool: string;
  /** What only the real service says, for a request it received with bad credentials. */
  answer: RegExp;
  secret: string;
  /** Asked from outside the sandbox first. Any HTTP answer means the host can reach it. */
  hostUrl: string;
};

/** Runs one connector to its one tool call. Resolves on success; any failure ends the process. */
function proveConnector(proof: ConnectorProof): Promise<void> {
  const { connector, tool } = proof;
  // windows-console-ok: this script runs only on Linux, where the flag is ignored.
  const child = spawn(gateway, ["__nimbus-sandbox", gateway, "__nimbus-connector", connector], {
    env: wrapperEnv(policyFor(connector), proof.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const failWithStderr = (message: string): never =>
    fail(`${connector}: ${message}\nstderr: ${stderr.slice(-STDERR_TAIL_CHARS)}`);
  const send = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return new Promise((done) => {
    const timer = setTimeout(() => failWithStderr("timed out"), RUN_TIMEOUT_MS);
    child.on("exit", (code) => failWithStderr(`exited early, code ${String(code)}`));

    const handle = (message: RpcMessage): void => {
      if (message.id === INITIALIZE_ID) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: LIST_ID, method: "tools/list" });
      } else if (message.id === LIST_ID) {
        const count = message.result?.tools?.length ?? 0;
        console.log(`  ${connector}: tools/list: ${String(count)} tools`);
        if (count === 0) failWithStderr("listed no tools");
        send({
          jsonrpc: "2.0",
          id: CALL_ID,
          method: "tools/call",
          params: { name: tool, arguments: {} },
        });
      } else if (message.id === CALL_ID) {
        const text = message.result?.content?.[0]?.text ?? JSON.stringify(message);
        console.log(`  ${connector}: ${tool}: ${text.slice(0, TEXT_TAIL_CHARS)}`);
        clearTimeout(timer);
        child.removeAllListeners("exit");
        child.kill();
        if (!proof.answer.test(text)) {
          failWithStderr(
            `the service's own answer did not come back, wanted ${String(proof.answer)}`,
          );
        }
        if (stderr.includes(proof.secret)) fail(`${connector}: a credential reached a log line`);
        done();
      }
    };

    let buffered = "";
    child.stdout.on("data", (d: Buffer) => {
      buffered += d.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          handle(JSON.parse(line) as RpcMessage);
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: INITIALIZE_ID,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "check-forwarder-connector", version: "1" },
      },
    });
  });
}

async function hostReaches(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(HOST_REACH_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

async function proveIfReachable(proof: ConnectorProof): Promise<void> {
  if (await hostReaches(proof.hostUrl)) {
    await proveConnector(proof);
    return;
  }
  console.error(
    `SKIPPED, NOT PROVED: ${proof.connector}: this machine cannot reach ${proof.hostUrl} even outside the sandbox`,
  );
}

function toolOnPath(tool: string): boolean {
  // windows-console-ok: this script runs only on Linux, where the flag is ignored.
  return spawnSync("sh", ["-c", `command -v ${tool}`], { env: { PATH: CHILD_PATH } }).status === 0;
}

/** A shell-script CLI under its connector's policy. A kill or a missing interpreter is the failure. */
function proveVersion(tool: string, connector: string): void {
  if (!toolOnPath(tool)) {
    console.log(`  ${tool}: not on this machine, skipped`);
    return;
  }
  // windows-console-ok: this script runs only on Linux, where the flag is ignored.
  const run = spawnSync(gateway, ["__nimbus-sandbox", tool, "--version"], {
    env: wrapperEnv(policyFor(connector), {}),
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
  });
  const said = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
  const firstLine = said.split("\n")[0] ?? "";
  console.log(`  ${tool} --version: exit ${String(run.status)}: ${firstLine}`);
  if (run.status === SECCOMP_KILLED_EXIT) fail(`${tool}: killed by the seccomp filter`);
  if (run.status !== 0)
    fail(`${tool}: exit ${String(run.status)}: ${said.slice(-STDERR_TAIL_CHARS)}`);
}

await proveIfReachable({
  connector: "github",
  env: { GITHUB_PAT: "not-a-real-token" },
  tool: "github_repo_list",
  // Any status GitHub itself sent, since a shared runner's address can get 403 rather than 401.
  answer: /GitHub \d{3}/,
  secret: "not-a-real-token",
  hostUrl: "https://api.github.com/",
});

if (!toolOnPath("aws")) fail("aws is not on this machine, and the GitHub runner image ships it");
await proveIfReachable({
  connector: "aws",
  env: {
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7NOTREAL",
    AWS_SECRET_ACCESS_KEY: "not-a-real-secret-key",
    AWS_DEFAULT_REGION: "us-east-1",
  },
  tool: "aws_lambda_list",
  answer:
    /UnrecognizedClientException|InvalidClientTokenId|InvalidSignatureException|security token/,
  secret: "not-a-real-secret-key",
  hostUrl: "https://lambda.us-east-1.amazonaws.com/",
});

proveVersion("gcloud", "gcp");
proveVersion("az", "azure");
process.exit(0);
