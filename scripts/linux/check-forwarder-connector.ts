// A real first-party connector through the real per-host path: a compiled gateway, its sandbox role,
// its bundled `github` connector and a real request to GitHub. The token is made up, so GitHub can
// only answer that it is bad, and that answer is the proof: the request left the sandbox, through the
// forwarder, over real TLS, to a declared host. A policy with no way out would fail differently.
//
// Usage: bun scripts/linux/check-forwarder-connector.ts <path to the compiled nimbus-gateway>
// Needs NIMBUS_SANDBOX_HELPER_PATH, and the internet.
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { manifestForFirstParty } from "../../packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts";
import {
  policyFromManifest,
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
} from "../../packages/gateway/src/platform/sandbox/sandbox-policy.ts";

const RUN_TIMEOUT_MS = 90_000;
const STDERR_TAIL_CHARS = 1000;
const INITIALIZE_ID = 1;
const LIST_ID = 2;
const CALL_ID = 3;
const FAKE_TOKEN = "not-a-real-token";

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

const policy = policyFromManifest(manifestForFirstParty("github"));
const withBinary = {
  ...policy,
  permissions: {
    ...policy.permissions,
    // A compiled gateway outside /usr has to be readable to run as the connector, as a real install
    // under /usr/lib/nimbus needs no grant for it.
    filesystem: { read: [dirname(gateway)], write: [] },
  },
};

// windows-console-ok: this script runs only on Linux, where the flag is ignored.
const child = spawn(gateway, ["__nimbus-sandbox", gateway, "__nimbus-connector", "github"], {
  env: {
    PATH: "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/tmp",
    NIMBUS_SANDBOX_HELPER_PATH: process.env["NIMBUS_SANDBOX_HELPER_PATH"],
    [SANDBOX_POLICY_ENV]: JSON.stringify(withBinary),
    [SANDBOX_CWD_ENV]: join(mkdtempSync(join(tmpdir(), "nimbus-forwarder-proof-")), "cwd"),
    GITHUB_PAT: FAKE_TOKEN,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (d: Buffer) => {
  stderr += d.toString();
});

function failWithStderr(message: string): never {
  fail(`${message}\nstderr: ${stderr.slice(-STDERR_TAIL_CHARS)}`);
}

const send = (message: unknown): void => {
  child.stdin.write(`${JSON.stringify(message)}\n`);
};

const timer = setTimeout(() => failWithStderr("timed out"), RUN_TIMEOUT_MS);
child.on("exit", (code) => failWithStderr(`the connector exited early, code ${String(code)}`));

function handle(message: RpcMessage): void {
  if (message.id === INITIALIZE_ID) {
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: LIST_ID, method: "tools/list" });
    return;
  }
  if (message.id === LIST_ID) {
    const count = message.result?.tools?.length ?? 0;
    console.log(`  tools/list: ${String(count)} tools`);
    if (count === 0) failWithStderr("the connector listed no tools");
    send({
      jsonrpc: "2.0",
      id: CALL_ID,
      method: "tools/call",
      params: { name: "github_repo_list", arguments: {} },
    });
    return;
  }
  if (message.id === CALL_ID) {
    const text = message.result?.content?.[0]?.text ?? JSON.stringify(message);
    console.log(`  github_repo_list: ${text.slice(0, 200)}`);
    clearTimeout(timer);
    child.removeAllListeners("exit");
    child.kill();
    if (!text.includes("401") && !/bad credentials/i.test(text)) {
      failWithStderr("GitHub's 401 did not come back, so the request did not reach it");
    }
    if (stderr.includes(FAKE_TOKEN)) fail("the token reached a log line");
    process.exit(0);
  }
}

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
