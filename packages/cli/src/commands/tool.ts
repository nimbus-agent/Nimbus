import { confirm, isCancel } from "@clack/prompts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

/**
 * Control outcomes, in the SAME 124-127 shell-reserved band `exec.ts`'s `EXEC_EXIT_CODES` uses, and
 * for the identical reason: 126/127 are the shell's own found-but-not-executed / not-found codes, so
 * picking them here (rather than a fresh 10-14 range that ordinary scripts would use for their own
 * errors) minimises collision with anything this command itself might one day emit. There is no
 * `wallClock`/`outputCap` pair here -- a tool registration has no running-script phase to bound, only
 * "the owner approved it" (`denied` when they didn't) or "it never got that far" (`refused`).
 */
export const TOOL_EXIT_CODES = {
  denied: 126,
  refused: 127,
} as const;

/** One `--credential <host>=<token>` binding, parsed but never rendered back to the terminal. */
export interface CredentialBindingArg {
  readonly host: string;
  readonly token: string;
}

export type CredentialSchemeArg =
  | { readonly type: "bearer"; readonly token: string }
  | { readonly type: "header"; readonly headerName: string; readonly value: string }
  | { readonly type: "basic"; readonly username: string; readonly password: string };

export type ParsedToolArgs =
  | {
      readonly sub: "create";
      readonly description: string;
      readonly hosts: string[];
      readonly credentials: CredentialBindingArg[];
    }
  | { readonly sub: "list"; readonly json: boolean }
  | { readonly sub: "revoke"; readonly toolId: string }
  | { readonly sub: "save"; readonly toolId: string }
  | {
      readonly sub: "credential-set";
      readonly toolId: string;
      readonly host: string;
      readonly scheme: CredentialSchemeArg;
    };

const USAGE = [
  "Usage: nimbus tool create --description <text> --host <h> [--host <h>...]",
  "                           [--credential <host>=<token>]...",
  "       nimbus tool list [--json]",
  "       nimbus tool revoke <tool-id>",
  "       nimbus tool save <tool-id>",
  "       nimbus tool credential set <tool-id> <host>",
  "                           (--bearer <token> | --header <name> <value> | --basic <user> <pass>)",
].join("\n");

function parseCreateArgs(rest: readonly string[]): Extract<ParsedToolArgs, { sub: "create" }> {
  let description: string | undefined;
  const hosts: string[] = [];
  const credentials: CredentialBindingArg[] = [];

  let i = 0;
  while (i < rest.length) {
    const flag = rest[i];
    const next = (): string => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${flag} requires a value\n${USAGE}`);
      return v;
    };
    switch (flag) {
      case "--description":
        description = next();
        break;
      case "--host":
        hosts.push(next());
        break;
      case "--credential": {
        const raw = next();
        // Split on the FIRST "=" only -- a bearer token can itself contain "=" (base64 padding),
        // so `raw.split("=")` would silently truncate it.
        const eq = raw.indexOf("=");
        if (eq <= 0) {
          throw new Error(`--credential must be <host>=<token>, got "${raw}"\n${USAGE}`);
        }
        credentials.push({ host: raw.slice(0, eq), token: raw.slice(eq + 1) });
        break;
      }
      default:
        throw new Error(`Unknown flag: ${flag}\n${USAGE}`);
    }
    i += 1;
  }

  if (description === undefined) {
    throw new Error(`nimbus tool create: --description is required\n${USAGE}`);
  }
  if (hosts.length === 0) {
    throw new Error(`nimbus tool create: at least one --host is required\n${USAGE}`);
  }
  // A credential naming a host the owner did not also grant via --host would let the approval
  // prompt's `credentialHosts` disclose a binding for a host the tool was never approved to reach --
  // refused here, before anything is sent to the gateway, rather than resolved by silently adding
  // the host to the grant.
  //
  // Compared case-INSENSITIVELY (and trimmed), because the gateway's `normalizeHost` lowercases:
  // `--host api.example.com --credential API.example.com=…` names ONE host there and was refused
  // here, a pure over-refusal. This deliberately does NOT reimplement the rest of `normalizeHost`
  // (scheme stripping, port stripping) — the gateway is the boundary and the CLI must not carry a
  // second, drifting copy of it, and `packages/cli` may not import gateway source at all. So
  // `--credential https://api.example.com/v1=…` against `--host api.example.com` is still refused
  // even though the gateway would accept it: an over-refusal in the safe direction, with a message
  // that names both spellings.
  const hostsLower = hosts.map((h) => h.trim().toLowerCase());
  for (const cred of credentials) {
    if (!hostsLower.includes(cred.host.trim().toLowerCase())) {
      throw new Error(
        `nimbus tool create: --credential names host "${cred.host}", which is not in --host\n${USAGE}`,
      );
    }
  }
  return { sub: "create", description, hosts, credentials };
}

function parseListArgs(rest: readonly string[]): Extract<ParsedToolArgs, { sub: "list" }> {
  let json = false;
  for (const flag of rest) {
    if (flag === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown flag: ${flag}\n${USAGE}`);
  }
  return { sub: "list", json };
}

function parseRevokeArgs(rest: readonly string[]): Extract<ParsedToolArgs, { sub: "revoke" }> {
  const toolId = rest[0];
  if (toolId === undefined || toolId.startsWith("--")) {
    throw new Error(`nimbus tool revoke: a tool id is required\n${USAGE}`);
  }
  return { sub: "revoke", toolId };
}

function parseSaveArgs(rest: readonly string[]): Extract<ParsedToolArgs, { sub: "save" }> {
  const toolId = rest[0];
  if (toolId === undefined || toolId.startsWith("--")) {
    throw new Error(`nimbus tool save: a tool id is required\n${USAGE}`);
  }
  return { sub: "save", toolId };
}

/**
 * `nimbus tool credential set <tool-id> <host> (--bearer|--header|--basic ...)`.
 *
 * Parsing succeeds independently of whether the tool named is live -- that check belongs to
 * `runCredentialSetCmd`, which refuses unconditionally (see its doc comment). Kept separate so the
 * pure parser stays testable without a gateway.
 */
function parseCredentialSetArgs(
  rest: readonly string[],
): Extract<ParsedToolArgs, { sub: "credential-set" }> {
  const positional: string[] = [];
  let bearer: string | undefined;
  let header: { name: string; value: string } | undefined;
  let basic: { user: string; pass: string } | undefined;
  let schemeCount = 0;

  let i = 0;
  while (i < rest.length) {
    const flag = rest[i];
    const next = (): string => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${flag} requires a value\n${USAGE}`);
      return v;
    };
    switch (flag) {
      case "--bearer":
        bearer = next();
        schemeCount += 1;
        break;
      case "--header":
        header = { name: next(), value: next() };
        schemeCount += 1;
        break;
      case "--basic":
        basic = { user: next(), pass: next() };
        schemeCount += 1;
        break;
      default:
        if (flag?.startsWith("--")) {
          throw new Error(`Unknown flag: ${flag}\n${USAGE}`);
        }
        if (flag !== undefined) positional.push(flag);
        break;
    }
    i += 1;
  }

  const toolId = positional[0];
  const host = positional[1];
  if (toolId === undefined) {
    throw new Error(`nimbus tool credential set: a tool id is required\n${USAGE}`);
  }
  if (host === undefined) {
    throw new Error(`nimbus tool credential set: a host is required\n${USAGE}`);
  }
  // ONE message covers both the "none supplied" and "more than one supplied" cases: it names every
  // scheme flag (so a caller who typed none sees what to add) and says "exactly one" (so a caller
  // who typed two sees why it was refused rather than one being picked silently).
  if (schemeCount !== 1) {
    throw new Error(
      "nimbus tool credential set requires exactly one of --bearer <token>, " +
        `--header <name> <value>, or --basic <user> <pass>\n${USAGE}`,
    );
  }
  let scheme: CredentialSchemeArg;
  if (bearer !== undefined) {
    scheme = { type: "bearer", token: bearer };
  } else if (header !== undefined) {
    scheme = { type: "header", headerName: header.name, value: header.value };
  } else if (basic !== undefined) {
    scheme = { type: "basic", username: basic.user, password: basic.pass };
  } else {
    // Unreachable: `schemeCount === 1` above guarantees exactly one of the three is set.
    throw new Error(`internal: no credential scheme captured\n${USAGE}`);
  }
  return { sub: "credential-set", toolId, host, scheme };
}

/**
 * Parse `nimbus tool`'s argv. Unknown flags and unknown subcommands THROW rather than being
 * ignored or defaulted -- silently dropping `--credential` would approve a tool for fewer secrets
 * than the owner believed they granted, and silently defaulting an unknown subcommand would run the
 * wrong one.
 */
export function parseToolArgs(argv: readonly string[]): ParsedToolArgs {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "create":
      return parseCreateArgs(rest);
    case "list":
      return parseListArgs(rest);
    case "revoke":
      return parseRevokeArgs(rest);
    case "save":
      return parseSaveArgs(rest);
    case "credential": {
      const [action, ...credRest] = rest;
      if (action !== "set") {
        throw new Error(`Unknown "nimbus tool credential" subcommand: "${action ?? ""}"\n${USAGE}`);
      }
      return parseCredentialSetArgs(credRest);
    }
    default:
      throw new Error(`Unknown "nimbus tool" subcommand: "${sub ?? ""}"\n${USAGE}`);
  }
}

// -------------------------------------------------------------------------------------------
// Orchestration below. Only the parser above and the pure render/format helpers are unit-tested
// directly with real assertions on message content; the gateway round-trip is exercised through
// injected fakes, matching `exec.ts`'s split.
// -------------------------------------------------------------------------------------------

/**
 * Every `nimbus tool` invocation from this CLI shares one session id. The gateway's
 * `ToolgenRegistry` is keyed by `sessionId` (it also bounds `max_tools_per_session`), and a real
 * agent conversation mints a fresh one per session via `agentRequestContext`. A CLI-originated tool
 * belongs to no such conversation, so a random id per invocation would make `nimbus tool list`
 * unable to find a tool `nimbus tool create` had just registered in a different process. A single
 * fixed id groups every CLI-originated tool into one stable, listable session for the life of the
 * gateway process (the registry itself is in-memory only and does not survive a restart).
 *
 * **This is a real, stated tradeoff, not a bug:** because every CLI invocation is a SEPARATE
 * process sharing this ONE id, `max_tools_per_session` is NOT a per-command-invocation limit for
 * the CLI the way it is for a real agent conversation. It is a single budget of
 * `max_tools_per_session` live generated tools shared by every `nimbus tool create` this gateway
 * process ever serves, gateway-process-lifetime rather than per-invocation. See
 * `docs/cli-reference.md`'s "What `max_tools_per_session` actually bounds from the CLI" note.
 */
export const CLI_TOOLGEN_SESSION_ID = "cli";

/** What a `toolgen.create` call resolves to, mirroring the gateway's `ToolgenOutcome`. */
export interface ToolOutcomeShape {
  readonly status: string;
  readonly code?: string;
  readonly toolId?: string;
  /**
   * Mirrors the gateway's `DraftedTool.locality` (packages/gateway/src/toolgen/toolgen-draft.ts).
   * Present only on a draft-related refusal -- the gate has no locality to report for a refusal
   * decided before drafting (a disabled capability, org policy, a bad host).
   */
  readonly locality?: "local" | "remote";
}

/** Where rendered output goes. Injected so rendering is testable without a live process. */
export interface OutcomeSink {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

/**
 * Map a `toolgen.create` outcome to a process exit code. An unrecognised shape maps to `refused`,
 * never 0 -- exiting 0 on something this command did not understand would read as "it registered".
 */
export function exitCodeForTool(outcome: ToolOutcomeShape): number {
  if (outcome.status === "registered") return 0;
  if (outcome.status === "denied") return TOOL_EXIT_CODES.denied;
  return TOOL_EXIT_CODES.refused;
}

/**
 * Write a `toolgen.create` outcome to the user. Pure over an injected sink, matching
 * `exec.ts`'s `renderOutcome` split.
 */
export function renderToolOutcome(outcome: ToolOutcomeShape, sink: OutcomeSink): void {
  if (outcome.status === "registered") {
    sink.out(`Tool registered: ${outcome.toolId ?? "(unknown id)"}\n`);
    return;
  }
  if (outcome.status === "denied") {
    sink.err("nimbus: tool registration denied\n");
    return;
  }
  sink.err(`nimbus: refused (${outcome.code ?? "unknown"})\n`);
  // Only when the failing route was LOCAL: suggesting a bigger local model to someone already on
  // a frontier model is noise, not help.
  if (outcome.code === "ERR_TOOLGEN_DRAFT_INVALID" && outcome.locality === "local") {
    sink.err(
      "hint: the local model could not produce a valid tool. Either configure a larger local\n" +
        "      model (see [llm] min_reasoning_params) or allow remote drafting with\n" +
        '      [tool_generation] drafting = "allow-remote".\n',
    );
  }
}

/** Mirrors the gateway's `ToolInputScalar` (packages/gateway/src/toolgen/toolgen-types.ts). */
type ToolInputScalar = "string" | "number" | "boolean";

/** Mirrors the gateway's `ToolInputProperty` (packages/gateway/src/toolgen/toolgen-types.ts). */
type ToolInputProperty =
  | { readonly type: ToolInputScalar; readonly description?: string }
  | {
      readonly type: "array";
      readonly items: { readonly type: ToolInputScalar };
      readonly description?: string;
    };

/** Mirrors the gateway's `ToolInputSchema` (packages/gateway/src/toolgen/toolgen-types.ts). */
interface ToolInputSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, ToolInputProperty>>;
  readonly required?: readonly string[];
}

/** Mirrors the gateway's `DraftGrounding` (packages/gateway/src/toolgen/toolgen-grounding.ts). */
type DraftGrounding =
  | { readonly kind: "endpoints"; readonly count: number; readonly services: readonly string[] }
  | { readonly kind: "description_only" };

/** What a `toolgen.approvalRequest` broadcast carries, prior to validation. */
export interface ToolApprovalPrompt {
  readonly toolName: string;
  readonly description: string;
  readonly body: string;
  readonly approvedHosts: readonly string[];
  readonly credentialHosts: readonly string[];
  /** The parameters the owner is being asked to approve -- the same object the gateway hashed. */
  readonly inputSchema: ToolInputSchema;
  /** How the draft was grounded -- disclosed so the owner can see whether it is a guess. */
  readonly grounding: DraftGrounding;
}

const list = (v: readonly string[]): string => (v.length === 0 ? "none" : v.join(", "));

// `string[]` rather than a bare `array`: the element type is part of what the owner is approving,
// and this prompt is the security boundary -- it should say the most it can in the space it has.
const formatPropType = (p: ToolInputProperty): string =>
  p.type === "array" ? `${p.items.type}[]` : p.type;

/**
 * `(required)` is spelled out rather than left to the absence of a `?` suffix: a required
 * parameter is the one an owner most needs to notice, and a marker that reads as "not marked
 * optional" is easy to miss at a glance in a security prompt.
 */
const formatParams = (s: ToolInputSchema): string => {
  const required = new Set(s.required ?? []);
  const names = Object.entries(s.properties).map(([n, def]) => {
    const type = formatPropType(def);
    return required.has(n) ? `${n}: ${type} (required)` : `${n}: ${type}?`;
  });
  return names.length === 0 ? "none" : names.join(", ");
};

/**
 * Whether the body was written against real indexed endpoints or guessed from the description
 * alone. Without this the owner cannot tell those two apart, and they are very different things
 * to be approving (spec § 6.2).
 */
const formatGrounding = (g: DraftGrounding): string =>
  g.kind === "description_only"
    ? "no indexed API specification matched — drafted from the description alone"
    : `${g.count} indexed endpoint(s) from ${g.services.join(", ")}`;

/**
 * Render what the owner is being asked to approve.
 *
 * The body is shown VERBATIM, never as a digest -- the human is the entire security boundary for
 * this capability. `credentialHosts` names only HOSTS, never a credential value: the wire shape
 * this reads from (`ToolgenApprovalInput`) never carries a token, header value, or password, so
 * there is nothing here that could leak one even by omission of care.
 *
 * The trailing `note:` line is I39's WHERE-not-WHAT residual, made real rather than merely
 * documented: the host list this prompt shows bounds WHERE the tool may send a request, never
 * WHAT it sends there -- an approved host may receive anything the tool can compute, including
 * data it legitimately read through the same broker. `docs/SECURITY-INVARIANTS.md`'s I39 section
 * says this belongs in the approval prompt as well as in the doc; this is that placement.
 */
export function formatToolApprovalPrompt(p: ToolApprovalPrompt): string {
  return [
    `Register the generated tool "${p.toolName}"?`,
    "",
    `  description: ${p.description}`,
    "",
    p.body,
    "",
    `  parameters:       ${formatParams(p.inputSchema)}`,
    `  grounding:        ${formatGrounding(p.grounding)}`,
    "",
    `  hosts:            ${list(p.approvedHosts)}`,
    `  credential hosts: ${list(p.credentialHosts)}`,
    "",
    "  note: an approved host may receive anything this tool can compute. The host list bounds",
    "        WHERE it may send, never WHAT.",
  ].join("\n");
}

type ToolApprovalBroadcast = Partial<ToolApprovalPrompt> & { requestId?: string };

const EMPTY_INPUT_SCHEMA: ToolInputSchema = { type: "object", properties: {} };
const UNGROUNDED: DraftGrounding = { kind: "description_only" };

const isToolInputScalar = (v: unknown): v is ToolInputScalar =>
  v === "string" || v === "number" || v === "boolean";

/**
 * A single malformed property is DROPPED, not treated as invalidating the whole schema -- the
 * owner still sees every parameter the wire shape got right, rather than "none" over one bad entry
 * (the same asymmetry `parseCredentials` on the gateway side applies to a malformed credential).
 */
function toToolInputProperty(v: unknown): ToolInputProperty | undefined {
  const r = asRecord(v);
  if (r["type"] === "array") {
    const items = asRecord(r["items"]);
    return isToolInputScalar(items["type"])
      ? { type: "array", items: { type: items["type"] } }
      : undefined;
  }
  return isToolInputScalar(r["type"]) ? { type: r["type"] } : undefined;
}

/** A malformed `inputSchema` -- wrong shape, or `type` not `"object"` -- renders as "none". */
function toToolInputSchema(v: unknown): ToolInputSchema {
  const r = asRecord(v);
  if (r["type"] !== "object") return EMPTY_INPUT_SCHEMA;
  // NULL-PROTOTYPE, mirroring the gateway validator: assigning a property literally named
  // `__proto__` onto a plain object invokes the inherited setter instead of creating an own
  // property, so `Object.entries` cannot see it afterwards. That matters here specifically because
  // `formatParams` renders this map into the APPROVAL PROMPT — the owner would be shown fewer
  // parameters than the tool actually takes, which is the one place in this feature where a
  // silently incomplete disclosure is worst.
  const properties: Record<string, ToolInputProperty> = Object.create(null);
  for (const [name, def] of Object.entries(asRecord(r["properties"]))) {
    const prop = toToolInputProperty(def);
    if (prop !== undefined) properties[name] = prop;
  }
  const required = Array.isArray(r["required"])
    ? r["required"].filter((e): e is string => typeof e === "string")
    : [];
  return required.length === 0
    ? { type: "object", properties }
    : { type: "object", properties, required };
}

/** A malformed `grounding` renders as `description_only` -- the "this was a guess" disclosure. */
function toDraftGrounding(v: unknown): DraftGrounding {
  const r = asRecord(v);
  if (r["kind"] !== "endpoints") return UNGROUNDED;
  const count = r["count"];
  const services = Array.isArray(r["services"])
    ? r["services"].filter((e): e is string => typeof e === "string")
    : undefined;
  return typeof count === "number" && services !== undefined
    ? { kind: "endpoints", count, services }
    : UNGROUNDED;
}

/**
 * Answer one `toolgen.approvalRequest` broadcast. Mirrors `exec.ts`'s `handleApprovalBroadcast`:
 * every field validated (including nested arrays) before use, a broadcast with no usable
 * `requestId` is ignored rather than answered, and only an explicit `true` approves. The prompt
 * must never throw on bad input -- it is the last thing standing between a model-authored body and
 * a human's yes.
 */
export async function handleToolApprovalBroadcast(
  params: unknown,
  ask: (message: string) => Promise<unknown>,
  respond: (requestId: string, approved: boolean) => Promise<unknown>,
): Promise<void> {
  const p = (params ?? {}) as ToolApprovalBroadcast;
  if (typeof p.requestId !== "string" || p.requestId === "") return;

  const strs = (v: unknown): string[] =>
    Array.isArray(v) && v.every((e) => typeof e === "string") ? [...(v as string[])] : [];

  const answer = await ask(
    formatToolApprovalPrompt({
      toolName: typeof p.toolName === "string" ? p.toolName : "unknown",
      description: typeof p.description === "string" ? p.description : "",
      body: typeof p.body === "string" ? p.body : "",
      approvedHosts: strs(p.approvedHosts),
      credentialHosts: strs(p.credentialHosts),
      inputSchema: toToolInputSchema(p.inputSchema),
      grounding: toDraftGrounding(p.grounding),
    }),
  );
  await respond(p.requestId, !isCancel(answer) && answer === true);
}

/** The slice of the IPC client `nimbus tool` uses. Narrow so a test can supply one. */
export interface ToolClient {
  onNotification(method: string, handler: (params: unknown) => unknown): void;
  call(method: string, params: unknown): Promise<unknown>;
}

/** Seams `runTool` needs from the outside world, matching `exec.ts`'s `RunExecDeps` split. */
export interface RunToolDeps {
  readonly runWithClient: <T>(fn: (c: ToolClient) => Promise<T>) => Promise<T>;
  readonly ask: (message: string) => Promise<unknown>;
  readonly sink: OutcomeSink;
  readonly setExitCode: (code: number) => void;
  /**
   * Whether stdin is an interactive TTY right now. Injected (rather than read from
   * `process.stdin.isTTY` inline) so the non-TTY refusal path is testable without spawning a real
   * detached process — `runTool` never calls `process.exit` itself, only `setExitCode`, so a test
   * can assert the refusal without killing the test runner.
   */
  readonly isInteractiveTty: () => boolean;
}

const defaultDeps: RunToolDeps = {
  runWithClient: (fn) =>
    withGatewayIpc(fn as never, undefined, {
      // The call can block on the owner answering the approval prompt.
      requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS,
    }) as never,
  ask: (message) => confirm({ message }),
  sink: {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
  },
  setExitCode: (c) => {
    process.exitCode = c;
  },
  isInteractiveTty: () => process.stdin.isTTY === true,
};

/** Narrows an `unknown` IPC response to a keyed record. */
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

async function runCreateCmd(
  parsed: Extract<ParsedToolArgs, { sub: "create" }>,
  deps: RunToolDeps,
): Promise<void> {
  // Refuse OUTRIGHT in a non-TTY, before any gateway connection is opened. `toolgen.create` is
  // LAN-forbidden and local-only (§ 9.2 of the design spec) -- there is no headless path, by
  // design, because a piped "y" must never be able to approve model-authored code that then runs
  // with the owner's credentials.
  if (!deps.isInteractiveTty()) {
    deps.sink.err("error: nimbus tool create needs an interactive TTY for owner approval.\n");
    deps.sink.err("There is no headless path: toolgen.create is LAN-forbidden and local-only.\n");
    deps.setExitCode(TOOL_EXIT_CODES.refused);
    return;
  }

  try {
    const outcome = await deps.runWithClient(async (c) => {
      // Registered before the call: the approval broadcast can share a socket chunk with the
      // response, matching `exec.ts`'s ordering.
      c.onNotification("toolgen.approvalRequest", (params: unknown) =>
        handleToolApprovalBroadcast(params, deps.ask, (requestId, approved) =>
          c.call("toolgen.approvalRespond", { requestId, approved }),
        ),
      );
      return (await c.call("toolgen.create", {
        sessionId: CLI_TOOLGEN_SESSION_ID,
        description: parsed.description,
        hosts: parsed.hosts,
        // Sent now that the gateway consumes them: `toolgen.create` binds per-host at create time,
        // because the toolId does not exist until create runs and adding one to a LIVE tool would
        // change the artifact the owner approved.
        credentials: parsed.credentials.map((cred) => ({ host: cred.host, token: cred.token })),
      })) as ToolOutcomeShape;
    });

    renderToolOutcome(outcome, deps.sink);
    deps.setExitCode(exitCodeForTool(outcome));
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(TOOL_EXIT_CODES.refused);
  }
}

/** One `toolgen.list` entry, mirroring the gateway's `toListEntry` wire shape. Never a credential. */
export interface ToolListEntry {
  readonly toolId: string;
  readonly toolName: string;
  readonly description: string;
  readonly approvedHosts: readonly string[];
  readonly credentialHosts: readonly string[];
  readonly approvedAt: number;
  /** Whether this is a PERSISTED tool (survives a gateway restart) vs an ephemeral one. */
  readonly saved: boolean;
  /** A saved tool whose credentialed hosts have no CURRENT Vault binding -- true after every
   * restart until the owner re-binds with `nimbus tool credential set` (spec § 8.3/8.4). Always
   * `false` for an ephemeral tool. */
  readonly needsCredentials: boolean;
  /** Why a SAVED tool is not currently loadable (`signature_mismatch`, `pubkey_rotated`, ...) --
   * `null` for a healthy saved tool and for every ephemeral one. */
  readonly disabledReason: string | null;
}

function toToolListEntry(raw: unknown): ToolListEntry | undefined {
  const r = asRecord(raw);
  const toolId = typeof r["toolId"] === "string" ? r["toolId"] : undefined;
  const toolName = typeof r["toolName"] === "string" ? r["toolName"] : undefined;
  const description = typeof r["description"] === "string" ? r["description"] : undefined;
  if (toolId === undefined || toolName === undefined || description === undefined) {
    return undefined;
  }
  const strs = (v: unknown): string[] =>
    Array.isArray(v) && v.every((e) => typeof e === "string") ? [...(v as string[])] : [];
  const approvedAt = typeof r["approvedAt"] === "number" ? r["approvedAt"] : 0;
  return {
    toolId,
    toolName,
    description,
    approvedHosts: strs(r["approvedHosts"]),
    credentialHosts: strs(r["credentialHosts"]),
    approvedAt,
    // Malformed/absent degrades to the SAFER, less-alarming reading for each field: not saved,
    // not needing a credential, no disabled reason -- an older or malformed gateway response must
    // not manufacture a health warning nobody sent.
    saved: r["saved"] === true,
    needsCredentials: r["needsCredentials"] === true,
    disabledReason: typeof r["disabledReason"] === "string" ? r["disabledReason"] : null,
  };
}

/**
 * Render `nimbus tool list`'s plain-text form. Never renders a credential VALUE — the wire shape
 * this reads from carries only host names for `credentialHosts`, never a token/header/password.
 */
export function renderToolList(entries: readonly ToolListEntry[]): string {
  if (entries.length === 0) {
    return "No active generated tools.\n";
  }
  return `${entries
    .map((e) => {
      const approvedAt = new Date(e.approvedAt);
      const when = Number.isFinite(approvedAt.getTime())
        ? approvedAt.toISOString()
        : `unknown (${String(e.approvedAt)})`;
      const kind = e.saved ? "saved" : "ephemeral";
      const health =
        e.disabledReason !== null
          ? `  [DISABLED: ${e.disabledReason}]`
          : e.needsCredentials
            ? "  [needs credentials -- nimbus tool credential set]"
            : "";
      return (
        `  ${e.toolId}  ${e.toolName} — ${e.description}  (${kind})${health}\n` +
        `      hosts: ${list(e.approvedHosts)}  credential hosts: ${list(e.credentialHosts)}  approved: ${when}`
      );
    })
    .join("\n")}\n`;
}

async function runListCmd(
  parsed: Extract<ParsedToolArgs, { sub: "list" }>,
  deps: RunToolDeps,
): Promise<void> {
  try {
    const entries = await deps.runWithClient(async (c) => {
      const res = await c.call("toolgen.list", { sessionId: CLI_TOOLGEN_SESSION_ID });
      const rawTools = asRecord(res)["tools"];
      if (!Array.isArray(rawTools)) return [] as ToolListEntry[];
      const out: ToolListEntry[] = [];
      for (const raw of rawTools) {
        const entry = toToolListEntry(raw);
        if (entry !== undefined) out.push(entry);
      }
      return out;
    });
    if (parsed.json) {
      deps.sink.out(`${JSON.stringify(entries, null, 2)}\n`);
    } else {
      deps.sink.out(renderToolList(entries));
    }
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(TOOL_EXIT_CODES.refused);
  }
}

async function runRevokeCmd(
  parsed: Extract<ParsedToolArgs, { sub: "revoke" }>,
  deps: RunToolDeps,
): Promise<void> {
  try {
    // `toolgen.revoke` drops BOTH halves server-side -- `registry.revoke` (closes the live child)
    // AND `removeScript` (drops the approved body from disk) -- see `ipc/toolgen-rpc.ts`'s
    // `ToolgenRpcCtx.removeScript` doc comment. This command's job is only to call the one RPC that
    // does both; there is no separate "drop the script" step for the CLI to forget, because the CLI
    // never touches the gateway's config dir directly.
    await deps.runWithClient(async (c) => {
      await c.call("toolgen.revoke", { toolId: parsed.toolId });
    });
    deps.sink.out(`Revoked ${parsed.toolId}.\n`);
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(TOOL_EXIT_CODES.refused);
  }
}

/** What `toolgen.save` resolves to, mirroring the gateway's `ToolgenSaveOutcome`. */
export interface ToolSaveOutcomeShape {
  readonly status: string;
  readonly code?: string;
  readonly toolId?: string;
}

/**
 * Map a `toolgen.save` outcome to a process exit code. `already_saved` and `repaired` are BOTH
 * success -- neither made a fresh consent decision (`toolgen-save-gate.ts`'s `hitlStatusFor`
 * docstring), but from the owner's point of view nothing went wrong either time: the tool is
 * durably saved either way. An unrecognised status maps to `refused`, never 0, matching
 * `exitCodeForTool`'s identical rule.
 */
export function exitCodeForSave(outcome: ToolSaveOutcomeShape): number {
  if (
    outcome.status === "saved" ||
    outcome.status === "already_saved" ||
    outcome.status === "repaired"
  ) {
    return 0;
  }
  if (outcome.status === "denied") return TOOL_EXIT_CODES.denied;
  return TOOL_EXIT_CODES.refused;
}

/** Write a `toolgen.save` outcome to the user. Pure over an injected sink, matching
 * `renderToolOutcome`'s split. */
export function renderToolSaveOutcome(outcome: ToolSaveOutcomeShape, sink: OutcomeSink): void {
  switch (outcome.status) {
    case "saved":
      sink.out(
        `Tool saved: ${outcome.toolId ?? "(unknown id)"}. It will now survive a gateway restart.\n`,
      );
      return;
    case "already_saved":
      sink.out(
        `Tool ${outcome.toolId ?? "(unknown id)"} is already saved with these exact contents; nothing to do.\n`,
      );
      return;
    case "repaired":
      sink.out(
        `Tool ${outcome.toolId ?? "(unknown id)"}'s saved copy was repaired -- its content was already approved.\n`,
      );
      return;
    case "denied":
      sink.err("nimbus: tool save denied\n");
      return;
    default:
      sink.err(`nimbus: save refused (${outcome.code ?? "unknown"})\n`);
      return;
  }
}

/**
 * What a `toolgen.saveApprovalRequest` broadcast asks the owner to approve. Reuses
 * `ToolApprovalPrompt`'s shape (the fields are identical -- `persistence` adds no new datum to
 * DISPLAY, only a different meaning for the same body/hosts/schema) but renders under a DIFFERENT
 * title and with an EXTRA disclosure: this is a STANDING approval, not a one-off run, and
 * under-showing that distinction here would defeat the whole reason `toolgen.save` uses its own
 * broker and broadcast method rather than reusing `toolgen.create`'s (spec § 6.1).
 */
export function formatToolSaveApprovalPrompt(p: ToolApprovalPrompt): string {
  return [
    `Persist the generated tool "${p.toolName}" so it runs in EVERY future session --`,
    "without being asked again?",
    "",
    `  description: ${p.description}`,
    "",
    p.body,
    "",
    `  parameters:       ${formatParams(p.inputSchema)}`,
    `  grounding:        ${formatGrounding(p.grounding)}`,
    "",
    `  hosts:            ${list(p.approvedHosts)}`,
    `  credential hosts: ${list(p.credentialHosts)}`,
    "",
    "  note: an approved host may receive anything this tool can compute. The host list bounds",
    "        WHERE it may send, never WHAT.",
    "",
    "  note: THIS IS A STANDING APPROVAL, different from running the tool once. Approving means",
    "        it will run, unattended, in every future gateway session until you",
    "        `nimbus tool revoke` it. Its Vault credentials do NOT survive a restart -- re-bind",
    "        them with `nimbus tool credential set` when this tool needs one again.",
  ].join("\n");
}

/**
 * Answer one `toolgen.saveApprovalRequest` broadcast. Mirrors `handleToolApprovalBroadcast` field
 * for field, over the SAVE prompt's renderer and the SAVE broker's own respond method
 * (`toolgen.saveApprovalRespond`, wired by the caller) -- never `toolgen.approvalRespond`.
 */
export async function handleToolSaveApprovalBroadcast(
  params: unknown,
  ask: (message: string) => Promise<unknown>,
  respond: (requestId: string, approved: boolean) => Promise<unknown>,
): Promise<void> {
  const p = (params ?? {}) as ToolApprovalBroadcast;
  if (typeof p.requestId !== "string" || p.requestId === "") return;

  const strs = (v: unknown): string[] =>
    Array.isArray(v) && v.every((e) => typeof e === "string") ? [...(v as string[])] : [];

  const answer = await ask(
    formatToolSaveApprovalPrompt({
      toolName: typeof p.toolName === "string" ? p.toolName : "unknown",
      description: typeof p.description === "string" ? p.description : "",
      body: typeof p.body === "string" ? p.body : "",
      approvedHosts: strs(p.approvedHosts),
      credentialHosts: strs(p.credentialHosts),
      inputSchema: toToolInputSchema(p.inputSchema),
      grounding: toDraftGrounding(p.grounding),
    }),
  );
  await respond(p.requestId, !isCancel(answer) && answer === true);
}

async function runSaveCmd(
  parsed: Extract<ParsedToolArgs, { sub: "save" }>,
  deps: RunToolDeps,
): Promise<void> {
  // Same posture as create: `toolgen.save` is LAN-forbidden and local-only, and a STANDING
  // approval is not something a piped "y" may ever grant.
  if (!deps.isInteractiveTty()) {
    deps.sink.err("error: nimbus tool save needs an interactive TTY for owner approval.\n");
    deps.sink.err("There is no headless path: toolgen.save is LAN-forbidden and local-only.\n");
    deps.setExitCode(TOOL_EXIT_CODES.refused);
    return;
  }

  try {
    const outcome = await deps.runWithClient(async (c) => {
      c.onNotification("toolgen.saveApprovalRequest", (params: unknown) =>
        handleToolSaveApprovalBroadcast(params, deps.ask, (requestId, approved) =>
          c.call("toolgen.saveApprovalRespond", { requestId, approved }),
        ),
      );
      return (await c.call("toolgen.save", { toolId: parsed.toolId })) as ToolSaveOutcomeShape;
    });

    renderToolSaveOutcome(outcome, deps.sink);
    deps.setExitCode(exitCodeForSave(outcome));
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(TOOL_EXIT_CODES.refused);
  }
}

/**
 * Binds a credential to a host the named tool was ALREADY approved to reach (spec § 8.3) -- the
 * fix for a saved tool that lost its Vault binding across a restart, and the first user-facing
 * path for `header`/`basic` bindings (their parser has existed since PR 1; only `bearer` had
 * anywhere to go). Never widens the tool's approved scope from here: `credentialHosts` lives
 * inside the signed artifact, so a host outside it is refused server-side
 * (`ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN`) rather than silently accepted.
 *
 * This REPLACES the permanent refusal stub that shipped in PR 1/2 -- there is no live tool this
 * command cannot reach anymore; "revoke and recreate" is no longer the only path.
 */
async function runCredentialSetCmd(
  parsed: Extract<ParsedToolArgs, { sub: "credential-set" }>,
  deps: RunToolDeps,
): Promise<void> {
  try {
    await deps.runWithClient(async (c) => {
      await c.call("toolgen.credentialSet", {
        toolId: parsed.toolId,
        host: parsed.host,
        binding: parsed.scheme,
      });
    });
    deps.sink.out(`Credential bound for ${parsed.toolId} @ ${parsed.host}.\n`);
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(TOOL_EXIT_CODES.refused);
  }
}

export async function runTool(args: string[], deps: RunToolDeps = defaultDeps): Promise<void> {
  let parsed: ParsedToolArgs;
  try {
    parsed = parseToolArgs(args);
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(TOOL_EXIT_CODES.refused);
    return;
  }

  switch (parsed.sub) {
    case "create":
      await runCreateCmd(parsed, deps);
      return;
    case "list":
      await runListCmd(parsed, deps);
      return;
    case "revoke":
      await runRevokeCmd(parsed, deps);
      return;
    case "save":
      await runSaveCmd(parsed, deps);
      return;
    case "credential-set":
      await runCredentialSetCmd(parsed, deps);
      return;
  }
}
