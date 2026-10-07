#!/usr/bin/env bun
/**
 * Proves ONE bundled connector, run out of an INSTALLED gateway binary, actually answers an MCP
 * client: `initialize` → `notifications/initialized` → `tools/list`, and the tool list is a
 * non-empty array of named tools. Called by both legs of `install-smoke.yml`.
 *
 * This is stricter than `scripts/connector-boot-smoke.ts` on purpose. That script boots EVERY
 * connector and accepts a `<VAR> is not set` credential refusal as a pass, because most connectors
 * cannot start without a credential the CI runner does not have. Here the connector is chosen
 * because a dummy credential is enough for it to list its tools, so a refusal means the dummy env
 * never reached it — or the env var it reads was renamed — and that is a FAILURE, not a variant.
 *
 * Usage: bun scripts/release/connector-handshake-smoke.ts <path-to-nimbus-gateway> [connector-id]
 * Exit 0 when the connector listed at least one tool, 1 on any failure, 2 on a usage error.
 */

/**
 * Dummy credentials per connector. The value is never sent anywhere: `tools/list` makes no
 * outbound request, and a connector reads its token lazily, per tool CALL.
 *
 * `GITHUB_PAT` is the name `@nimbus-dev/connectors`' own `connectors/github/src/tools.ts` reads
 * (`requireProcessEnv("GITHUB_PAT")`), not merely the name the gateway's spawn table injects.
 */
export const DUMMY_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  github: { GITHUB_PAT: "install-smoke-dummy-token" },
};

/** A healthy connector answers in ~110 ms; this bounds a hang, not the run. */
const TIMEOUT_MS = 20_000;

const PROTOCOL_VERSION = "2024-11-05";

/** Same shape `connector-boot-smoke.ts` treats as a credential refusal — here, a failure. */
const CREDENTIAL_REFUSAL_RE = /\b[A-Z][A-Z0-9_]* is not set\b/;

export type JsonRpcMessage = Readonly<Record<string, unknown>>;

/**
 * Split newline-delimited JSON-RPC (the MCP stdio framing) into complete messages plus the
 * unterminated remainder. A line that is not a JSON object is DROPPED rather than fatal: a
 * connector may log a non-protocol line, and the judgement is made on the responses we wait for.
 */
export function splitJsonRpcLines(buffer: string): {
  readonly messages: readonly JsonRpcMessage[];
  readonly rest: string;
} {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const messages: JsonRpcMessage[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        messages.push(parsed as JsonRpcMessage);
      }
    } catch {
      // Not protocol output — ignored, see above.
    }
  }
  return { messages, rest };
}

/** Find the response to request `id`, if one has arrived. */
export function findResponse(
  messages: readonly JsonRpcMessage[],
  id: number,
): JsonRpcMessage | undefined {
  return messages.find((m) => m["id"] === id && ("result" in m || "error" in m));
}

export type Verdict =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly why: string };

function errorText(msg: JsonRpcMessage): string {
  const err = msg["error"];
  if (err !== null && typeof err === "object") {
    const m = (err as Record<string, unknown>)["message"];
    if (typeof m === "string") return m;
  }
  return JSON.stringify(err);
}

/** Judge the `initialize` response: a result carrying `serverInfo`, never an error. */
export function judgeInitialize(msg: JsonRpcMessage): Verdict {
  if ("error" in msg) return { ok: false, why: `initialize returned an error: ${errorText(msg)}` };
  const result = msg["result"];
  if (result === null || typeof result !== "object") {
    return { ok: false, why: "initialize returned no result object" };
  }
  const info = (result as Record<string, unknown>)["serverInfo"];
  if (info === null || typeof info !== "object") {
    return { ok: false, why: "initialize result carries no serverInfo" };
  }
  const name = (info as Record<string, unknown>)["name"];
  return { ok: true, detail: typeof name === "string" ? name : "(unnamed server)" };
}

/**
 * Judge the `tools/list` response: `result.tools` must be a NON-EMPTY array whose every entry has a
 * non-empty string `name`. An empty array fails — a connector that registers nothing is the state
 * this check exists to catch, and it is not distinguishable from a working one by exit code.
 */
export function judgeToolsList(msg: JsonRpcMessage): Verdict {
  if ("error" in msg) return { ok: false, why: `tools/list returned an error: ${errorText(msg)}` };
  const result = msg["result"];
  if (result === null || typeof result !== "object") {
    return { ok: false, why: "tools/list returned no result object" };
  }
  const tools = (result as Record<string, unknown>)["tools"];
  if (!Array.isArray(tools)) return { ok: false, why: "tools/list result.tools is not an array" };
  if (tools.length === 0) return { ok: false, why: "tools/list returned an EMPTY tools array" };
  const names: string[] = [];
  for (const t of tools as unknown[]) {
    const name =
      t !== null && typeof t === "object" ? (t as Record<string, unknown>)["name"] : null;
    if (typeof name !== "string" || name === "") {
      return { ok: false, why: "tools/list returned a tool with no name" };
    }
    names.push(name);
  }
  return { ok: true, detail: `${String(names.length)} tools (${names.slice(0, 3).join(", ")}…)` };
}

/**
 * Explain a connector that exited, or went quiet, before answering. A credential refusal is named
 * as such and is STILL a failure — the dummy credential should have satisfied it.
 */
export function explainNoAnswer(
  stage: string,
  stderr: string,
  exitCode: number | null,
  timedOut: boolean,
): string {
  const first = (stderr.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 200);
  if (timedOut) return `no ${stage} response within ${String(TIMEOUT_MS)}ms`;
  if (CREDENTIAL_REFUSAL_RE.test(stderr)) {
    return `connector refused for a missing credential before ${stage} (${first}) — the dummy env did not reach it, or the variable it reads was renamed`;
  }
  const code = exitCode === null ? "?" : String(exitCode);
  return first === ""
    ? `connector exited ${code} before ${stage} with no output`
    : `connector exited ${code} before ${stage}: ${first}`;
}

function request(id: number, method: string, params: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

async function run(binary: string, id: string): Promise<Verdict> {
  const extra = DUMMY_ENV[id] ?? {};
  const proc = Bun.spawn([binary, "__nimbus-connector", id], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extra },
    windowsHide: true,
  });
  let stderr = "";
  const stderrDone = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      stderr += dec.decode(chunk, { stream: true });
    }
  })();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen: JsonRpcMessage[] = [];

  /** Read until the response to `wanted` arrives, or stdout closes (EOF → undefined). */
  async function awaitResponse(wanted: number): Promise<JsonRpcMessage | undefined> {
    for (;;) {
      const hit = findResponse(seen, wanted);
      if (hit !== undefined) return hit;
      const { value, done } = await reader.read();
      if (done) return undefined;
      buffer += decoder.decode(value, { stream: true });
      const split = splitJsonRpcLines(buffer);
      buffer = split.rest;
      seen.push(...split.messages);
    }
  }

  async function failAfterEof(stage: string): Promise<Verdict> {
    const code = await proc.exited;
    clearTimeout(timer);
    await stderrDone;
    return { ok: false, why: explainNoAnswer(stage, stderr, code, timedOut) };
  }

  try {
    proc.stdin.write(
      request(1, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "install-smoke", version: "0" },
      }),
    );
    await proc.stdin.flush();
    const init = await awaitResponse(1);
    if (init === undefined) return await failAfterEof("initialize");
    const initVerdict = judgeInitialize(init);
    if (!initVerdict.ok) return initVerdict;

    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    proc.stdin.write(request(2, "tools/list", {}));
    await proc.stdin.flush();
    const list = await awaitResponse(2);
    if (list === undefined) return await failAfterEof("tools/list");
    const verdict = judgeToolsList(list);
    return verdict.ok ? { ok: true, detail: `${initVerdict.detail}: ${verdict.detail}` } : verdict;
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const [binary, id = "github"] = argv;
  if (binary === undefined || binary === "") {
    console.error(
      "usage: bun scripts/release/connector-handshake-smoke.ts <path-to-nimbus-gateway> [connector-id]",
    );
    return 2;
  }
  if (DUMMY_ENV[id] === undefined) {
    console.error(`no dummy credential is defined for connector ${JSON.stringify(id)}`);
    return 2;
  }
  let verdict: Verdict;
  try {
    verdict = await run(binary, id);
  } catch (e) {
    verdict = {
      ok: false,
      why: `could not run ${binary}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!verdict.ok) {
    console.error(`::error::connector ${id} did not answer an MCP client: ${verdict.why}`);
    return 1;
  }
  console.log(`connector handshake smoke: ${id} answered — ${verdict.detail}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
