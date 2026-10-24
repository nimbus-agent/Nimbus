import { createInterface } from "node:readline/promises";

import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import {
  type CaptureSummaryView,
  formatCaptureDetail,
  formatCaptureTable,
  parseDetail,
  parseList,
  stripControl,
} from "./captures-format.ts";

export const CAPTURES_USAGE =
  "usage: nimbus captures [list] [--state live|proposed|accepted|rejected|revoked|executing|executed|failed|expired] [--kind note|decision|term|link|action] [--limit 1-200] [--json]\n" +
  "       nimbus captures show <id> [--json]\n" +
  "       nimbus captures revoke <id> [--json]\n" +
  "       nimbus captures accept <id> [--json]\n" +
  "       nimbus captures accept --all [--kind decision|term|link] [--json]\n" +
  "       nimbus captures reject <id> [--json]\n" +
  "       nimbus captures purge <id> [--json]";

type IdVerb = "show" | "revoke" | "accept" | "reject" | "purge";
type ListArgs = { verb: "list"; state?: string; kind?: string; limit?: number; json: boolean };

export type CapturesArgs =
  | ListArgs
  | { verb: IdVerb; id: string; json: boolean }
  | { verb: "acceptAll"; kind?: NativeKind | "action"; json: boolean };

/** The kinds a batch accept may take. An action is never batched: each needs its own approval. */
const NATIVE_KINDS = ["decision", "term", "link"] as const;
type NativeKind = (typeof NATIVE_KINDS)[number];

function isNativeKind(k: string): k is NativeKind {
  return (NATIVE_KINDS as readonly string[]).includes(k);
}

/** `accept --all [--kind <native kind>]`; `--kind action` parses so the run can say why it refuses. */
function parseAcceptAll(flags: string[], json: boolean): CapturesArgs | undefined {
  if (flags.length === 0) return { verb: "acceptAll", json };
  if (flags.length !== 2 || flags[0] !== "--kind") return undefined;
  const kind = flags[1] ?? "";
  return kind === "action" || isNativeKind(kind) ? { verb: "acceptAll", kind, json } : undefined;
}

function isIdVerb(verb: string): verb is IdVerb {
  return (
    verb === "show" ||
    verb === "revoke" ||
    verb === "accept" ||
    verb === "reject" ||
    verb === "purge"
  );
}

/** `--limit`: an integer in 1..200, else undefined (the whole parse refuses). */
function parseLimit(v: string): number | undefined {
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n < 1 || n > 200 ? undefined : n;
}

/** `list`'s `--flag value` pairs; an unknown flag or a missing value refuses the whole parse. */
function parseListFlags(flags: string[], json: boolean): ListArgs | undefined {
  const out: ListArgs = { verb: "list", json };
  for (let i = 0; i < flags.length; i += 2) {
    const k = flags[i];
    const v = flags[i + 1];
    if (v === undefined || v.startsWith("--")) return undefined;
    if (k === "--state") out.state = v;
    else if (k === "--kind") out.kind = v;
    else if (k === "--limit") {
      const n = parseLimit(v);
      if (n === undefined) return undefined;
      out.limit = n;
    } else return undefined;
  }
  return out;
}

export function parseCapturesArgs(argv: string[]): CapturesArgs | undefined {
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  const verb = rest[0] ?? "list";
  if (verb === "accept" && rest[1] === "--all") return parseAcceptAll(rest.slice(2), json);
  if (isIdVerb(verb)) {
    const id = rest[1];
    if (id === undefined || id.startsWith("--") || rest.length !== 2) return undefined;
    return { verb, id, json };
  }
  if (verb !== "list" && !verb.startsWith("--")) return undefined;
  return parseListFlags(verb === "list" ? rest.slice(1) : rest, json);
}

function kindNoun(nativeRef: string): string {
  if (nativeRef.startsWith("capture:")) return "decision";
  return nativeRef.includes("|") ? "link" : "glossary term";
}

function confirmation(verb: "revoke" | "reject" | "purge", id: string): string {
  if (verb === "purge") {
    return `Purged ${id}: the stored proposal and its input are deleted; the action it ran is not undone.\n`;
  }
  if (verb === "reject") {
    return `Rejected ${id}. Nothing was written; the record is kept 90 days, then pruned.\n`;
  }
  return `Revoked ${id}: its item and embeddings are deleted; the record keeps no payload.\n`;
}

type Tty = { readonly stdin: boolean; readonly stdout: boolean };

/**
 * An agent-proposed action is approved at the executor's HITL prompt, which needs a human at a
 * terminal on BOTH ends: piped stdin cannot answer it honestly and redirected stdout hides it.
 * Fails CLOSED: a `captures.get` that names no kind could be an action, so without a TTY it is
 * refused too; a well-formed native kind needs no prompt and is never refused here. This is a
 * CLI-side guard, not a gateway one: a raw local-owner socket client is not subject to it.
 */
export function actionAcceptTtyRefusal(kind: string | undefined, tty: Tty): string | undefined {
  if (tty.stdin && tty.stdout) return undefined;
  if (kind === "action") {
    return "nimbus captures accept requires an interactive terminal (TTY) to approve an agent-proposed action.";
  }
  if (kind === undefined) {
    return "nimbus captures accept requires an interactive terminal (TTY): the gateway did not say what kind of capture this is, so it may be an agent-proposed action.";
  }
  return undefined;
}

export type AcceptView =
  | { state: "accepted"; nativeRef: string }
  | { state: "executed"; outcomeRef?: string }
  | { state: "rejected" }
  | { state: "failed"; errorCode: string };

/**
 * Failures KNOWN to have happened before any request reached the service (the tool did not
 * resolve). Every other failure code, including one this CLI has never heard of, may have reached
 * it, and says so.
 */
const NOT_DISPATCHED = new Set(["ERR_ACTION_TOOL_NOT_FOUND"]);

/** A success line needs a real result; anything else is a gateway contract break. */
export function parseAcceptResult(raw: unknown): AcceptView {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const nativeRef = r["nativeRef"];
  if (r["state"] === "accepted" && typeof nativeRef === "string" && nativeRef !== "") {
    return { state: "accepted", nativeRef };
  }
  if (r["state"] === "executed") {
    const outcomeRef = r["outcomeRef"];
    return typeof outcomeRef === "string"
      ? { state: "executed", outcomeRef }
      : { state: "executed" };
  }
  if (r["state"] === "rejected") return { state: "rejected" };
  const errorCode = r["errorCode"];
  if (r["state"] === "failed" && typeof errorCode === "string") {
    return { state: "failed", errorCode };
  }
  throw new Error(
    "captures.accept returned a malformed result; the capture was not confirmed accepted",
  );
}

function acceptLine(
  id: string,
  v: AcceptView,
  actionType: string | undefined,
): { line: string; exit: number } {
  const type = actionType === undefined ? "the action" : stripControl(actionType);
  switch (v.state) {
    case "accepted": {
      const nativeRef = stripControl(v.nativeRef);
      return {
        line: `Accepted ${id}: it now counts as a ${kindNoun(nativeRef)} (${nativeRef}) and is labelled agent-authored.\n`,
        exit: 0,
      };
    }
    case "executed": {
      const ref = v.outcomeRef === undefined ? "" : stripControl(v.outcomeRef);
      return { line: `[ok] executed ${type} (${ref || "no outcome reference"})\n`, exit: 0 };
    }
    case "rejected":
      return { line: "[rejected] not executed — you declined the approval\n", exit: 1 };
    case "failed": {
      const code = stripControl(v.errorCode);
      const service =
        actionType === undefined ? "the service" : (stripControl(actionType).split(".")[0] ?? "");
      return {
        line: NOT_DISPATCHED.has(v.errorCode)
          ? `[failed] ${code}\n`
          : `[failed] ${code} — the action may or may not have reached ${service || "the service"}\n`,
        exit: 1,
      };
    }
  }
}

/** `kind` and, for an action, its `payload.actionType` — read from ONE `captures.get`. */
function acceptTarget(detail: unknown): { kind?: string; actionType?: string } {
  const r = (typeof detail === "object" && detail !== null ? detail : {}) as Record<
    string,
    unknown
  >;
  const kind = typeof r["kind"] === "string" ? r["kind"] : undefined;
  if (kind !== "action") return kind === undefined ? {} : { kind };
  const payload = r["payload"];
  const t =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)["actionType"]
      : undefined;
  return typeof t === "string" ? { kind, actionType: t } : { kind };
}

async function runAccept(
  c: Pick<IPCClient, "call">,
  a: { id: string; json: boolean },
  sink: Sink,
  tty: Tty,
): Promise<number> {
  // NOT caught: the TTY guard depends on the kind this returns, so a failure fails the accept
  // closed through the caller's catch and captures.accept is never called.
  const target = acceptTarget(await c.call<unknown>("captures.get", { id: a.id }));
  const refusal = actionAcceptTtyRefusal(target.kind, tty);
  if (refusal !== undefined) {
    if (a.json) sink.out(`${JSON.stringify({ error: refusal })}\n`);
    else sink.err(`${refusal}\n`);
    return 1;
  }
  const raw = await c.call<unknown>("captures.accept", { id: a.id });
  const { line, exit } = acceptLine(a.id, parseAcceptResult(raw), target.actionType);
  sink.out(a.json ? `${JSON.stringify(raw, undefined, 2)}\n` : line);
  return exit;
}

type Sink = { out(s: string): void; err(s: string): void };

/** One question, one answer: the batch accept's single confirmation. */
export type Ask = (question: string) => Promise<string>;

/** `captures.list`'s own cap: one run accepts at most this many. */
export const ACCEPT_ALL_MAX = 200;

/** The proposed native captures a batch will take, oldest first, and whether more are waiting. */
async function listNativeProposals(
  c: Pick<IPCClient, "call">,
  kinds: readonly NativeKind[],
): Promise<{ rows: CaptureSummaryView[]; more: boolean }> {
  // Independent reads, one per kind: issued together (in kind order) and merged below.
  const perKind = await Promise.all(
    kinds.map(async (kind) => {
      const raw = await c.call<unknown>("captures.list", {
        state: "proposed",
        kind,
        // Oldest first BEFORE the limit: with more waiting than one run takes, the oldest go first.
        order: "asc",
        limit: ACCEPT_ALL_MAX,
      });
      // Re-filtered here, not trusted: an action row must never reach the accept loop.
      return parseList(raw).filter((r) => r.state === "proposed" && r.kind === kind);
    }),
  );
  let more = perKind.some((got) => got.length >= ACCEPT_ALL_MAX);
  let rows = perKind.flat();
  rows.sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id));
  if (rows.length > ACCEPT_ALL_MAX) {
    more = true;
    rows = rows.slice(0, ACCEPT_ALL_MAX);
  }
  return { rows, more };
}

type BatchResult =
  | { id: string; state: "accepted"; nativeRef: string }
  | { id: string; error: string };

async function acceptOne(c: Pick<IPCClient, "call">, id: string): Promise<BatchResult> {
  try {
    const v = parseAcceptResult(await c.call<unknown>("captures.accept", { id }));
    if (v.state !== "accepted") return { id, error: `unexpected result state ${v.state}` };
    return { id, state: "accepted", nativeRef: v.nativeRef };
  } catch (e) {
    return { id, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The batch's listing, printed before its one confirmation. */
function printProposals(rows: CaptureSummaryView[], more: boolean, say: (s: string) => void): void {
  say(`${String(rows.length)} agent-authored proposal(s), oldest first:\n`);
  for (const r of rows) {
    say(
      `  ${r.id}  ${r.kind}  ${stripControl(r.clientLabel ?? "-")}  ${stripControl(r.title).slice(0, 60)}\n`,
    );
  }
  if (more) {
    say(
      `More proposals are waiting than one run accepts (${String(ACCEPT_ALL_MAX)}); run it again afterwards.\n`,
    );
  }
}

/**
 * Accepts the confirmed rows one at a time, oldest first — deliberately sequential, not
 * `Promise.all`: each accept is a gateway write (and its own transaction), the run promises the
 * oldest go first, and each row's line prints as its own accept resolves, in the listed order.
 */
async function acceptRows(
  c: Pick<IPCClient, "call">,
  rows: CaptureSummaryView[],
  say: (s: string) => void,
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (const r of rows) {
    const res = await acceptOne(c, r.id); // NOSONAR S9382: accepts run oldest first, one gateway write at a time (see acceptRows)
    results.push(res);
    if ("error" in res) say(`[refused] ${r.id}: ${stripControl(res.error)}\n`);
    else
      say(
        `accepted ${r.id}: ${kindNoun(stripControl(res.nativeRef))} (${stripControl(res.nativeRef)})\n`,
      );
  }
  return results;
}

/**
 * `nimbus captures accept --all`: every proposed decision, term and link, after ONE confirmation
 * at a terminal (no `--yes`: accepting many agent-written claims at once stays a human act). An
 * action is never batched — each keeps its own TTY guard and the executor's HITL prompt. Each
 * accept is the gateway's own, with every per-capture check; one refusal does not stop the run.
 */
async function runAcceptAll(
  c: Pick<IPCClient, "call">,
  a: { kind?: NativeKind | "action"; json: boolean },
  sink: Sink,
  tty: Tty,
  ask: Ask,
): Promise<number> {
  const refuse = (msg: string): number => {
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${msg}\n`);
    return 1;
  };
  if (a.kind === "action") {
    return refuse(
      "agent-proposed actions are never accepted in a batch; accept each one with `nimbus captures accept <id>`",
    );
  }
  if (!(tty.stdin && tty.stdout)) {
    return refuse(
      "nimbus captures accept --all requires an interactive terminal (TTY): it asks once before accepting agent-authored proposals.",
    );
  }
  const { rows, more } = await listNativeProposals(
    c,
    a.kind === undefined ? NATIVE_KINDS : [a.kind],
  );
  // With --json, stdout carries only the JSON result: the listing and prompt go to stderr.
  const say = (s: string): void => (a.json ? sink.err(s) : sink.out(s));
  if (rows.length === 0) {
    if (a.json)
      sink.out(`${JSON.stringify({ accepted: 0, total: 0, more: false, results: [] })}\n`);
    else say("No proposed decisions, terms or links to accept.\n");
    return 0;
  }
  printProposals(rows, more, say);
  const answer = (
    await ask(`Accept these ${String(rows.length)} proposal(s)? [y/N] `)
  ).toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    return refuse("Accepted nothing.");
  }
  const results = await acceptRows(c, rows, say);
  const accepted = results.filter((r) => !("error" in r)).length;
  if (a.json) {
    sink.out(`${JSON.stringify({ accepted, total: rows.length, more, results }, undefined, 2)}\n`);
  } else {
    say(`Accepted ${String(accepted)} of ${String(rows.length)}.\n`);
  }
  return accepted === rows.length ? 0 : 1;
}

async function runList(c: Pick<IPCClient, "call">, a: ListArgs, sink: Sink): Promise<number> {
  const params: Record<string, unknown> = {};
  if (a.state !== undefined) params["state"] = a.state;
  if (a.kind !== undefined) params["kind"] = a.kind;
  if (a.limit !== undefined) params["limit"] = a.limit;
  const raw = await c.call<unknown>("captures.list", params);
  sink.out(
    a.json
      ? `${JSON.stringify(raw, undefined, 2)}\n`
      : formatCaptureTable(parseList(raw), Date.now()),
  );
  return 0;
}

async function runShow(
  c: Pick<IPCClient, "call">,
  a: { id: string; json: boolean },
  sink: Sink,
): Promise<number> {
  const raw = await c.call<unknown>("captures.get", { id: a.id });
  sink.out(
    a.json ? `${JSON.stringify(raw, undefined, 2)}\n` : formatCaptureDetail(parseDetail(raw)),
  );
  return 0;
}

/** Fail-closed default: a caller that supplies no TTY facts cannot accept an action. */
const NO_TTY: Tty = { stdin: false, stdout: false };

export async function runCapturesWith(
  c: Pick<IPCClient, "call">,
  a: CapturesArgs,
  sink: Sink,
  tty: Tty = NO_TTY,
  // Fail-closed default: a caller that supplies no way to ask declines every batch.
  ask: Ask = () => Promise.resolve(""),
): Promise<number> {
  try {
    if (a.verb === "list") return await runList(c, a, sink);
    if (a.verb === "show") return await runShow(c, a, sink);
    if (a.verb === "accept") return await runAccept(c, a, sink, tty);
    if (a.verb === "acceptAll") return await runAcceptAll(c, a, sink, tty, ask);
    const raw = await c.call<unknown>(`captures.${a.verb}`, { id: a.id });
    sink.out(a.json ? `${JSON.stringify(raw, undefined, 2)}\n` : confirmation(a.verb, a.id));
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    // A refusal can quote agent text (a term key, an item id): strip it like every other print.
    else sink.err(`${stripControl(msg)}\n`);
    return 1;
  }
}

/** The batch confirmation; under --json the question goes to stderr so stdout stays JSON. */
async function askOnTerminal(question: string, json: boolean): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: json ? process.stderr : process.stdout,
  });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function runCapturesCmd(argv: string[]): Promise<void> {
  const a = parseCapturesArgs(argv);
  if (a === undefined) {
    process.stderr.write(`${CAPTURES_USAGE}\n`);
    throw new CliExit(2);
  }
  const paths = getCliPlatformPaths();
  // One connection, one captures.get: the TTY guard lives inside runCapturesWith. An action
  // accept blocks on the executor's HITL prompt (withGatewayIpc's default interactive consent
  // handler), so the call gets the long budget rather than the 30s default.
  const code = await withGatewayIpc(
    (c) =>
      runCapturesWith(
        c,
        a,
        { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
        { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
        (q) => askOnTerminal(q, a.json),
      ),
    paths,
    a.verb === "accept" ? { requestTimeoutMs: BATCH_RPC_TIMEOUT_MS } : {},
  );
  if (code !== 0) throw new CliExit(code);
}
