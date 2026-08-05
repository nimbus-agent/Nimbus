#!/usr/bin/env bun
import { BUNDLED_CONNECTORS } from "../packages/gateway/src/connectors/bundled-connector-registry.ts";

/**
 * Boot every bundled connector out of a compiled gateway binary and demand it does something
 * observable. A connector may legitimately refuse to start without credentials — that is a non-zero
 * exit with a message. What it may NOT do is exit 0 in silence or hang, which is what a connector
 * whose startup is unreachable from the registry looks like.
 */
const BINARY = process.argv[2];
// Reached only by a genuine hang: a healthy connector answers in ~110 ms and a credential-less one
// exits immediately, so this bounds failures, not the run. Deliberately not env-configurable —
// there is no load under which a 15 s budget for one process start is tight, and a knob here would
// invite raising it instead of diagnosing the hang.
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;

if (BINARY === undefined) {
  console.error("usage: bun scripts/connector-boot-smoke.ts <path-to-nimbus-gateway>");
  process.exit(2);
}

const INITIALIZE = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "boot-smoke", version: "0" },
  },
})}\n`;

type Outcome =
  | { id: string; ok: true; how: "answered" | "refused" }
  | { id: string; ok: false; why: string };

async function boot(id: string): Promise<Outcome> {
  const proc = Bun.spawn([BINARY as string, "__nimbus-connector", id], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(INITIALIZE);
  await proc.stdin.flush();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);

  // Read stdout INCREMENTALLY and stop at the first answer. Draining to EOF instead
  // (`new Response(proc.stdout).text()`) would wait for stdout to close — which a healthy MCP
  // server never does — so every SUCCESSFUL connector would burn the full timeout. Measured:
  // 5023 ms draining versus 107 ms streaming, per connector.
  const decoder = new TextDecoder();
  let stdout = "";
  let answered = false;
  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    stdout += decoder.decode(chunk, { stream: true });
    if (stdout.includes('"serverInfo"')) {
      answered = true;
      break;
    }
  }
  clearTimeout(timer);

  if (answered) {
    proc.kill();
    return { id, ok: true, how: "answered" };
  }

  // stdout ended without an answer: the process is dying or already dead.
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (timedOut) return { id, ok: false, why: `hung for ${String(TIMEOUT_MS)}ms without answering` };
  if (code !== 0 && stderr.trim() !== "") {
    return { id, ok: true, how: "refused" };
  }
  return {
    id,
    ok: false,
    why: `exited ${String(code)} with no serverInfo and no error — its startup is unreachable from the registry`,
  };
}

const ids = Object.keys(BUNDLED_CONNECTORS).sort((a, b) => a.localeCompare(b));
const results: Outcome[] = [];
for (let i = 0; i < ids.length; i += CONCURRENCY) {
  results.push(...(await Promise.all(ids.slice(i, i + CONCURRENCY).map(boot))));
}

const failures = results.filter((r): r is Extract<Outcome, { ok: false }> => !r.ok);
const answered = results.filter((r) => r.ok && r.how === "answered").length;
const refused = results.filter((r) => r.ok && r.how === "refused").length;

console.log(
  `connector boot smoke: ${String(results.length)} connectors — ${String(answered)} answered, ${String(refused)} refused without credentials, ${String(failures.length)} failed`,
);
for (const f of failures) {
  console.error(`::error::connector ${f.id}: ${f.why}`);
}
process.exit(failures.length > 0 ? 1 : 0);
