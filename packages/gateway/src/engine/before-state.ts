/**
 * The before-state reader for the model's connector-write door (spec § 5.4, invariant I53). When
 * the door's executor is about to prompt the local owner for a write whose row declares a `before`
 * reader, it first runs that reader's READS (one, or two when the reader declares `also`), so the
 * prompt shows the target's current state beside the new values. Each read:
 *
 *  - runs only on the door's executor (`engine/run-ask.ts` `buildModelWriteExecutor` is the one
 *    place a runner is built, static rule D40(b)), only for an `origin: "model"` action, and only
 *    after the delegation check fell back to the owner's prompt;
 *  - is a `<service>.before.read` `PlannedAction` through the SAME executor's `gate()` and then
 *    its dispatcher, so it gets its own audit row and its own I29 egress row like any connector
 *    read. `gate()` refuses such a type that would require HITL without asking anyone, so a read
 *    never raises a second prompt; the connector dispatcher lets the type resolve only to a read
 *    tool of its own service (`connectors/registry.ts`);
 *  - runs in order (the first, then `also`); `also` is never gated when the first failed or the
 *    budget is already spent, so the ledger order is deterministic, and a read whose gate resolves
 *    after the budget ran out is never dispatched;
 *  - never blocks the prompt: ONE timer of {@link BEFORE_STATE_TIMEOUT_MS} covers both reads, after
 *    which the prompt shows `unavailable (timeout)` and a late reply is dropped; every failure is
 *    one of four fixed reasons, never error text, and it is all or nothing: a failed second read
 *    shows no field of the first;
 *  - never reaches the model or the write's audit row: only the selected, sanitised values reach
 *    the preview, and the write's result is the write's own reply.
 *
 * A Wave 4 write is read-or-refuse (D1): whatever the reason the current state is not available to
 * show (no reader or preview on the row, a reader tool unlisted, `args` failing, a timeout, a failed
 * or policy-refused read, `select` failing), the runner returns `{ status: "refused", reason }`
 * with {@link WAVE4_BEFORE_REFUSAL}, or the guard's own reason when a guard applies. Waves 2 and 3
 * keep showing `unavailable (<reason>)` and still prompt.
 *
 * A reader may carry a GUARD (B2a). When the guard applies to the write's input, the runner returns
 * `{ status: "refused", reason }` unless every read succeeded and the guard's `allows` returned
 * exactly `true`; every other path (a reader tool unlisted, `args` failing, a timeout, a failed or
 * policy-refused read, a throw, `select` failing) refuses too: fail closed. That variant never
 * reaches a preview: `ToolExecutor.previewFor` turns it into a thrown
 * {@link BeforeStateRefusedError}, which `gate()` records as a rejection with the guard's fixed
 * reason, before any prompt.
 *
 * A guard may also read the gateway config (B3, R11): the runner's `guardContext` accessor is
 * called ONCE per `read()` of a guarded row, before `appliesTo`, and its result is deep-copied and
 * frozen, so `appliesTo` and `allows` see the same snapshot and config cannot change between them.
 * An accessor that is absent, throws or returns a non-object gives the guard `undefined` (the
 * config could not be read), and a guard must then apply and refuse: fail closed. The door's
 * runner (`engine/run-ask.ts`) passes the tribal KB config; a runner built without it applies the
 * KB-child guards and refuses.
 */

import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  findConnectorWriteRow,
  isPlainObject,
  sanitisePreviewText,
} from "../connectors/connector-writes/preview.ts";
import {
  BEFORE_STATE_MAX_FIELDS,
  type BeforeGuardContext,
  type BeforeStateField,
  type BeforeStateRead,
  type BeforeStateReader,
  type BeforeStateUnavailableReason,
  beforeReaderArgKeys,
  type ConnectorWriteBeforeState,
  type ConnectorWriteRow,
  pickBeforeReaderArgs,
} from "../connectors/connector-writes/types.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import { serviceOf } from "./service-of.ts";
import { extractToolInput } from "./tool-input.ts";
import type { ActionResult, PlannedAction } from "./types.ts";

/** The prompt never waits longer than this for the current state (both reads together). */
export const BEFORE_STATE_TIMEOUT_MS = 5000;

/** The one spelling of the read's action-type suffix (D40(a): confined to this module and the guard). */
const BEFORE_READ_SUFFIX = ".before.read";

/**
 * The one fixed reason a Wave 4 model write is refused when the current state of its target could
 * not be read (D1, spec 5.4 and 15.2: the prompt for an irreversible write must show the target as
 * it is now). It names no target, no tool and no error text.
 */
export const WAVE4_BEFORE_REFUSAL =
  "the current state of the target could not be read, so nothing was sent";

/** The audit reason `gate()` records when it refuses a before-read that would need approval. */
export const BEFORE_READ_HITL_REFUSAL = "policy requires approval";

/** `<service>.before.read`: the read's action type, so `serviceOf` names the connector (I29). */
function beforeReadActionType(service: string): string {
  return `${service}${BEFORE_READ_SUFFIX}`;
}

export function isBeforeReadActionType(actionType: string): boolean {
  return actionType.endsWith(BEFORE_READ_SUFFIX);
}

/** What the runner needs from the executor that runs it: its own gate and its own dispatcher. */
export interface BeforeReadOps {
  gate(action: PlannedAction): Promise<ActionResult | "proceed">;
  dispatch(action: PlannedAction): Promise<unknown>;
}

export interface BeforeReadOptions {
  /** The door found a reader tool (the first or `also`) missing from the server's listing. */
  readonly readerUnlisted?: boolean;
}

/** A guard refused the write before the prompt (B2a); never part of a preview. */
export interface BeforeStateRefusal {
  readonly status: "refused";
  /** The guard's fixed reason. */
  readonly reason: string;
}

/** What the runner returns: the before-state for the preview, or a guard's refusal. */
export type BeforeStateOutcome = ConnectorWriteBeforeState | BeforeStateRefusal;

/**
 * Thrown by `ToolExecutor.previewFor` when the runner returned a {@link BeforeStateRefusal}, and
 * caught by `gate()` beside `ConsentDisconnectedError`: the write is rejected with `reason`, no
 * prompt is shown and nothing is dispatched.
 */
export class BeforeStateRefusedError extends Error {
  override readonly name = "BeforeStateRefusedError";
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * D1: an `origin: "model"` action of a Wave 4 type whose typed preview could not be built has no
 * before-state to show, so it is refused like any other unread Wave 4 target, before any prompt,
 * with {@link WAVE4_BEFORE_REFUSAL}. The row is found from `action.type` alone (I3). Called by
 * `ToolExecutor` only when its preview is absent; any other action passes through.
 */
export function throwIfWave4WithoutPreview(
  action: PlannedAction,
  rows: readonly ConnectorWriteRow[],
): void {
  if (action.origin === "model" && rows.some((r) => r.wave === 4 && r.actionType === action.type)) {
    throw new BeforeStateRefusedError(WAVE4_BEFORE_REFUSAL);
  }
}

export interface BeforeStateRunner {
  /** The rows the door executor previews with (production: the write table). */
  readonly rows: readonly ConnectorWriteRow[];
  /**
   * The current state for `action`'s row, a guard's refusal, or `undefined` when no before-state
   * applies (no row, no reader, not a model action). Never rejects.
   */
  read(
    action: PlannedAction,
    ops: BeforeReadOps,
    opts?: BeforeReadOptions,
  ): Promise<BeforeStateOutcome | undefined>;
}

/** Test seams: the rows, the cap and the timer; and the config a guard may read. */
export interface BeforeStateRunnerOptions {
  readonly rows?: readonly ConnectorWriteRow[];
  /**
   * The config a guard may read (the door passes the tribal KB destinations). Called once per
   * `read()` of a guarded row; absent, throwing or non-object: the guard gets `undefined`.
   */
  readonly guardContext?: () => BeforeGuardContext;
  readonly timeoutMs?: number;
  readonly timers?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

/** The ONE construction of a refusal: a guard's reason, or {@link WAVE4_BEFORE_REFUSAL}. */
function refusalOf(reason: string): BeforeStateRefusal {
  return { status: "refused", reason };
}

const unavailable = (reason: BeforeStateUnavailableReason): ConnectorWriteBeforeState => ({
  status: "unavailable",
  reason,
});

/**
 * The fixed reason for a failed read. A tool the dispatcher cannot find (the connector is not
 * configured, or its server lists no such tool) is `not configured`; anything else is `failed`.
 */
export function classifyBeforeStateError(err: unknown): "not configured" | "failed" {
  const msg = err instanceof Error ? err.message : "";
  return msg === "Tool not found" ? "not configured" : "failed";
}

/** What the selection and the guard see; `alsoReply` is `undefined` exactly when there is no `also`. */
interface Replies {
  readonly reply: unknown;
  readonly alsoReply: unknown;
  readonly picked: Readonly<Record<string, unknown>>;
}

/**
 * The reader's fields, sanitised and capped; `undefined` when `select` throws or returns anything
 * but an array of `{ label: string, value: string }`, and, for a Wave 4 row, when no field has a
 * non-blank value. Values are never cut; fields past the cap are
 * counted.
 */
function selectFields(
  row: ConnectorWriteRow,
  reader: BeforeStateReader,
  replies: Replies,
): ConnectorWriteBeforeState | undefined {
  let raw: unknown;
  try {
    raw = reader.select(replies.reply, replies.picked, replies.alsoReply);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const fields: BeforeStateField[] = [];
  for (const entry of raw as unknown[]) {
    if (!isPlainObject(entry)) return undefined;
    const { label, value } = entry;
    if (typeof label !== "string" || typeof value !== "string") return undefined;
    fields.push({ label: sanitisePreviewText(label), value: sanitisePreviewText(value) });
  }
  // D1: a Wave 4 prompt must show the target as it is now, so a selection that shows nothing (no
  // field, or only blank values) counts as a failed read, which a Wave 4 row turns into a refusal.
  if (row.wave === 4 && fields.every((f) => f.value.trim() === "")) return undefined;
  const shown = fields.slice(0, BEFORE_STATE_MAX_FIELDS);
  const notShown = fields.length - shown.length;
  return notShown > 0 ? { status: "ok", fields: shown, notShown } : { status: "ok", fields: shown };
}

/** One read's input from its OWN `argKeys` only; `undefined` when it cannot be built. */
function readArgs(
  read: BeforeStateRead,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  try {
    const args = read.args(pickBeforeReaderArgs(read.argKeys, input));
    return isPlainObject(args) ? args : undefined;
  } catch {
    return undefined;
  }
}

/** `v` and everything reachable from it frozen (a value already frozen is not walked again). */
function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const inner of Object.values(v)) deepFreeze(inner);
  }
  return v;
}

/**
 * ONE snapshot of the guard context: the accessor's `kb`, deep-copied and frozen. `undefined`
 * (the config could not be read) when there is no accessor, it throws, it returns a non-object,
 * its `kb` is present but not a plain object (`null`, a string, an array), or the copy fails.
 */
function snapshotGuardContext(
  accessor: (() => BeforeGuardContext) | undefined,
): BeforeGuardContext | undefined {
  if (accessor === undefined) return undefined;
  try {
    const raw: unknown = accessor();
    if (!isPlainObject(raw)) return undefined;
    const kb = raw["kb"];
    if (kb !== undefined && !isPlainObject(kb)) return undefined;
    return deepFreeze(structuredClone({ kb }) as BeforeGuardContext);
  } catch {
    return undefined;
  }
}

/**
 * Whether the reader's guard applies to this write. Fail closed: a non-object input (nothing to
 * pick) or a throwing `appliesTo` applies; only an exact `false` does not.
 */
function guardApplies(
  reader: BeforeStateReader,
  picked: Readonly<Record<string, unknown>> | undefined,
  ctx: BeforeGuardContext | undefined,
): boolean {
  const guard = reader.guard;
  if (guard === undefined) return false;
  if (picked === undefined) return true;
  try {
    return guard.appliesTo(picked, ctx) !== false;
  } catch {
    return true;
  }
}

/** Whether the guard allows the write over these replies: exactly `true`, never a throw. */
function guardAllows(
  reader: BeforeStateReader,
  replies: Replies,
  ctx: BeforeGuardContext | undefined,
): boolean {
  try {
    return reader.guard?.allows(replies.reply, replies.picked, replies.alsoReply, ctx) === true;
  } catch {
    return false;
  }
}

type GatedRead =
  | { readonly kind: "refused" }
  | { readonly kind: "spent" }
  | { readonly kind: "reply"; readonly reply: unknown };

type ReadsOutcome =
  | { readonly kind: "refused" }
  | { readonly kind: "spent" }
  | { readonly kind: "replies"; readonly reply: unknown; readonly alsoReply: unknown };

/**
 * One read: its gate, then its dispatch. A read whose budget ran out while its gate was pending is
 * never dispatched (the gate's own audit and egress rows stand; nothing reaches the connector).
 */
async function gateThenDispatch(
  readAction: PlannedAction,
  ops: BeforeReadOps,
  spent: () => boolean,
): Promise<GatedRead> {
  const gated = await ops.gate(readAction);
  if (gated !== "proceed") return { kind: "refused" };
  if (spent()) return { kind: "spent" };
  return { kind: "reply", reply: await ops.dispatch(readAction) };
}

/**
 * The reads in order: the first, then `also`. `also` is never gated when the first was refused or
 * threw (the throw propagates), or when the budget was spent while the first was in flight; and
 * neither read is dispatched when the budget ran out while its gate was pending.
 */
async function readInOrder(
  first: PlannedAction,
  second: PlannedAction | undefined,
  ops: BeforeReadOps,
  spent: () => boolean,
): Promise<ReadsOutcome> {
  const a = await gateThenDispatch(first, ops, spent);
  if (a.kind !== "reply") return a;
  if (second === undefined) return { kind: "replies", reply: a.reply, alsoReply: undefined };
  if (spent()) return { kind: "spent" };
  const b = await gateThenDispatch(second, ops, spent);
  if (b.kind !== "reply") return b;
  return { kind: "replies", reply: a.reply, alsoReply: b.reply };
}

function beforeReadAction(
  service: string,
  tool: string,
  args: Record<string, unknown>,
): PlannedAction {
  return {
    type: beforeReadActionType(service),
    payload: { mcpToolId: mcpClientToolKey(service, tool), input: args },
  };
}

/** The reads after the race: their replies, or the fixed reason none can be shown. */
type RaceOutcome =
  | { readonly kind: "replies"; readonly reply: unknown; readonly alsoReply: unknown }
  | { readonly kind: "unavailable"; readonly reason: BeforeStateUnavailableReason };

export function createBeforeStateRunner(options: BeforeStateRunnerOptions = {}): BeforeStateRunner {
  const rows = options.rows ?? CONNECTOR_WRITE_ROWS;
  const timeoutMs = options.timeoutMs ?? BEFORE_STATE_TIMEOUT_MS;
  const timers = options.timers ?? {
    set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clear: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
  };

  /**
   * The race: the reads against ONE cap, set before the first read and cleared once, whichever
   * way the race ends.
   */
  async function race(
    start: (spent: () => boolean) => Promise<ReadsOutcome>,
  ): Promise<RaceOutcome> {
    let handle: unknown;
    let expired = false;
    const timedOut = new Promise<"timeout">((resolve) => {
      handle = timers.set(() => {
        expired = true;
        resolve("timeout");
      }, timeoutMs);
    });
    const inFlight = start(() => expired);
    // A failure that lands after the cap has no awaiting consumer. `Promise.race` below also
    // subscribes, so this is belt and braces: it keeps a late failure handled even if the race
    // is ever restructured.
    inFlight.catch(() => undefined);
    try {
      const first = await Promise.race([inFlight, timedOut]);
      // A reply that arrives after this point is never read: `inFlight` has no other consumer.
      // (`spent` cannot win the race, since the cap that spent the budget settled it first; it is
      // classified as the timeout it is rather than trusted.)
      if (first === "timeout" || first.kind === "spent") {
        return { kind: "unavailable", reason: "timeout" };
      }
      if (first.kind === "refused") {
        return { kind: "unavailable", reason: BEFORE_READ_HITL_REFUSAL };
      }
      return first;
    } catch (err) {
      return { kind: "unavailable", reason: classifyBeforeStateError(err) };
    } finally {
      timers.clear(handle);
    }
  }

  return {
    rows,
    async read(action, ops, opts = {}) {
      if (action.origin !== "model") return undefined;
      const row = findConnectorWriteRow(action, rows);
      if (row === undefined) return undefined;
      const reader = row.before;
      if (reader === undefined || row.preview === undefined) {
        // A bound row's prepare step (I54) is its current state, as `isModelOfferableRow` says
        // (`before || bound`): with a preview, it is the executor's prepare phase that reads.
        if (reader === undefined && row.preview !== undefined && row.bound !== undefined) {
          return undefined;
        }
        // Defence in depth: such a row is never offered (`isModelOfferableRow`), but an
        // `origin: "model"` action can reach an executor through other paths.
        return row.wave === 4 ? refusalOf(WAVE4_BEFORE_REFUSAL) : undefined;
      }
      const input = extractToolInput(action);
      const picked = isPlainObject(input)
        ? pickBeforeReaderArgs(beforeReaderArgKeys(reader), input)
        : undefined;
      // Whether the guard applies is decided FIRST, from the write's input and ONE config
      // snapshot (the same one `allows` gets), so every early exit and every failure below
      // refuses instead of showing `unavailable`.
      const ctx =
        reader.guard === undefined ? undefined : snapshotGuardContext(options.guardContext);
      const guarded = guardApplies(reader, picked, ctx);
      // A guard that applies refuses with its own reason; a Wave 4 row without one refuses with
      // the fixed Wave 4 text. Any other row only shows `unavailable`.
      const mustRead = guarded || row.wave === 4;
      const guardReason = guarded ? reader.guard?.reason : undefined;
      const refusal = refusalOf(guardReason ?? WAVE4_BEFORE_REFUSAL);
      const fail = (reason: BeforeStateUnavailableReason): BeforeStateOutcome =>
        mustRead ? refusal : unavailable(reason);
      if (opts.readerUnlisted === true || picked === undefined || !isPlainObject(input)) {
        return fail("failed");
      }
      const args = readArgs(reader, input);
      const also = reader.also;
      const alsoArgs = also === undefined ? undefined : readArgs(also, input);
      if (args === undefined || (also !== undefined && alsoArgs === undefined)) {
        return fail("failed");
      }
      const service = serviceOf(row.actionType);
      const first = beforeReadAction(service, reader.tool, args);
      const second =
        also === undefined || alsoArgs === undefined
          ? undefined
          : beforeReadAction(service, also.tool, alsoArgs);
      const outcome = await race((spent) => readInOrder(first, second, ops, spent));
      if (outcome.kind === "unavailable") return fail(outcome.reason);
      const replies: Replies = { reply: outcome.reply, alsoReply: outcome.alsoReply, picked };
      if (guarded && !guardAllows(reader, replies, ctx)) return refusal;
      return selectFields(row, reader, replies) ?? fail("failed");
    },
  };
}
