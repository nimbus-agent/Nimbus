/**
 * The before-state reader for the model's connector-write door (spec § 5.4, invariant I53). When
 * the door's executor is about to prompt the local owner for a write whose row declares a `before`
 * reader, it first runs that one READ, so the prompt shows the target's current state beside the
 * new values. The read:
 *
 *  - runs only on the door's executor (`engine/run-ask.ts` `buildModelWriteExecutor` is the one
 *    place a runner is built, static rule D40(b)), only for an `origin: "model"` action, and only
 *    after the delegation check fell back to the owner's prompt;
 *  - is a `<service>.before.read` `PlannedAction` through the SAME executor's `gate()` and then
 *    its dispatcher, so it gets its own audit row and its own I29 egress row like any connector
 *    read. `gate()` refuses such a type that would require HITL without asking anyone, so a read
 *    never raises a second prompt; the connector dispatcher lets the type resolve only to a read
 *    tool of its own service (`connectors/registry.ts`);
 *  - never blocks the prompt: after {@link BEFORE_STATE_TIMEOUT_MS} the prompt shows
 *    `unavailable (timeout)` and a late reply is dropped; every failure is one of four fixed
 *    reasons, never error text;
 *  - never reaches the model or the write's audit row: only the selected, sanitised values reach
 *    the preview, and the write's result is the write's own reply.
 */

import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  findConnectorWriteRow,
  isPlainObject,
  sanitisePreviewText,
} from "../connectors/connector-writes/preview.ts";
import {
  BEFORE_STATE_MAX_FIELDS,
  type BeforeStateField,
  type BeforeStateReader,
  type BeforeStateUnavailableReason,
  type ConnectorWriteBeforeState,
  type ConnectorWriteRow,
  pickBeforeReaderArgs,
} from "../connectors/connector-writes/types.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import { serviceOf } from "./service-of.ts";
import { extractToolInput } from "./tool-input.ts";
import type { ActionResult, PlannedAction } from "./types.ts";

/** The prompt never waits longer than this for the current state. */
export const BEFORE_STATE_TIMEOUT_MS = 5000;

/** The one spelling of the read's action-type suffix (D40(a): confined to this module and the guard). */
const BEFORE_READ_SUFFIX = ".before.read";

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
  /** The door found the reader's tool missing from the server's listing: no read, `failed`. */
  readonly readerUnlisted?: boolean;
}

export interface BeforeStateRunner {
  /** The rows the door executor previews with (production: the write table). */
  readonly rows: readonly ConnectorWriteRow[];
  /**
   * The current state for `action`'s row, or `undefined` when no before-state applies (no row, no
   * reader, not a model action). Never rejects.
   */
  read(
    action: PlannedAction,
    ops: BeforeReadOps,
    opts?: BeforeReadOptions,
  ): Promise<ConnectorWriteBeforeState | undefined>;
}

/** Test seams: the rows, the cap and the timer. Production passes none. */
export interface BeforeStateRunnerOptions {
  readonly rows?: readonly ConnectorWriteRow[];
  readonly timeoutMs?: number;
  readonly timers?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
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

/**
 * The reader's fields, sanitised and capped; `undefined` when `select` throws or returns anything
 * but an array of `{ label: string, value: string }`. Values are never cut; fields past the cap are
 * counted.
 */
function selectFields(
  reader: BeforeStateReader,
  reply: unknown,
): ConnectorWriteBeforeState | undefined {
  let raw: unknown;
  try {
    raw = reader.select(reply);
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
  const shown = fields.slice(0, BEFORE_STATE_MAX_FIELDS);
  const notShown = fields.length - shown.length;
  return notShown > 0 ? { status: "ok", fields: shown, notShown } : { status: "ok", fields: shown };
}

/** The read's input from the write's `argKeys` only; `undefined` when it cannot be built. */
function readArgs(reader: BeforeStateReader, input: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(input)) return undefined;
  try {
    const args = reader.args(pickBeforeReaderArgs(reader.argKeys, input));
    return isPlainObject(args) ? args : undefined;
  } catch {
    return undefined;
  }
}

type ReadOutcome =
  | { readonly kind: "refused" }
  | { readonly kind: "reply"; readonly reply: unknown };

async function gateThenDispatch(
  readAction: PlannedAction,
  ops: BeforeReadOps,
): Promise<ReadOutcome> {
  const gated = await ops.gate(readAction);
  if (gated !== "proceed") return { kind: "refused" };
  return { kind: "reply", reply: await ops.dispatch(readAction) };
}

export function createBeforeStateRunner(options: BeforeStateRunnerOptions = {}): BeforeStateRunner {
  const rows = options.rows ?? CONNECTOR_WRITE_ROWS;
  const timeoutMs = options.timeoutMs ?? BEFORE_STATE_TIMEOUT_MS;
  const timers = options.timers ?? {
    set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clear: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
  };

  /** The race: the read against the cap. The timer is cleared whichever wins. */
  async function race(
    inFlight: Promise<ReadOutcome>,
    reader: BeforeStateReader,
  ): Promise<ConnectorWriteBeforeState> {
    let handle: unknown;
    const timedOut = new Promise<"timeout">((resolve) => {
      handle = timers.set(() => resolve("timeout"), timeoutMs);
    });
    try {
      const first = await Promise.race([inFlight, timedOut]);
      // A reply that arrives after this point is never read: `inFlight` has no other consumer.
      if (first === "timeout") return unavailable("timeout");
      if (first.kind === "refused") return unavailable(BEFORE_READ_HITL_REFUSAL);
      return selectFields(reader, first.reply) ?? unavailable("failed");
    } catch (err) {
      return unavailable(classifyBeforeStateError(err));
    } finally {
      timers.clear(handle);
    }
  }

  return {
    rows,
    async read(action, ops, opts = {}) {
      if (action.origin !== "model") return undefined;
      const row = findConnectorWriteRow(action, rows);
      const reader = row?.before;
      if (row === undefined || reader === undefined || row.preview === undefined) return undefined;
      if (opts.readerUnlisted === true) return unavailable("failed");
      const args = readArgs(reader, extractToolInput(action));
      if (args === undefined) return unavailable("failed");
      const service = serviceOf(row.actionType);
      const readAction: PlannedAction = {
        type: beforeReadActionType(service),
        payload: { mcpToolId: mcpClientToolKey(service, reader.tool), input: args },
      };
      const inFlight = gateThenDispatch(readAction, ops);
      // A failure that lands after the cap has no awaiting consumer. `Promise.race` below also
      // subscribes, so this is belt and braces: it keeps a late failure handled even if the race
      // is ever restructured.
      inFlight.catch(() => undefined);
      return race(inFlight, reader);
    },
  };
}
