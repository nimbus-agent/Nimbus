// packages/gateway/src/connectors/connector-writes/before-reader.ts
// Validation for a write row's `before` reader (spec § 5.4). Not imported by the row files: it
// reads the read/write classifiers, which import the row table. `withBefore` (./types.ts) checks
// the structure when a row is built; this module adds the checks that need the classifiers and is
// run over every row by its test.
import { isReadOnlyToolId } from "../../share/read-tool-registry.ts";
import { isConnectorWriteToolId } from "../connector-write-registry.ts";
import {
  type BeforeGuardContext,
  type BeforeStateRead,
  type BeforeStateReader,
  beforeGuardReasonProblem,
  beforeReadArgKeyProblems,
  beforeReaderArgKeys,
  type ConnectorWriteRow,
  previewTemplateKeys,
} from "./types.ts";

export { pickBeforeReaderArgs } from "./types.ts";

/** The guard context the selection probe hands a guard: both KB destinations configured. */
const PROBE_GUARD_CONTEXT: BeforeGuardContext = Object.freeze({
  kb: Object.freeze({
    notion: Object.freeze({ databaseId: "probe-notion-db" }),
    confluence: Object.freeze({ spaceKey: "PROBE", parentPageId: "1" }),
  }),
});

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A frozen-shape probe pick answering only `keys` (each `probe:<key>`) and throwing on any other
 * key, read or `in`-tested; `stray()` names the first other key touched.
 */
function strictPick(keys: readonly string[]): {
  readonly pick: Readonly<Record<string, unknown>>;
  stray(): string | undefined;
} {
  const allowed = new Set(keys);
  const target: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const k of keys) target[k] = `probe:${k}`;
  let stray: string | undefined;
  const pick = new Proxy(target, {
    get(t, key) {
      if (typeof key === "string" && allowed.has(key)) return t[key];
      stray ??= String(key);
      throw new Error(`read ${String(key)}, which is not an argKey`);
    },
    has(t, key) {
      if (typeof key === "string" && allowed.has(key)) return key in t;
      stray ??= String(key);
      throw new Error(`tested ${String(key)}, which is not an argKey`);
    },
  });
  return { pick, stray: () => stray };
}

/**
 * Probes `read.args` with a Proxy that answers only its `argKeys` and throws on any other key, so a
 * reader that reads a key it did not declare is caught in a test rather than silently reading
 * `undefined` at runtime. `undefined` means no problem.
 */
export function beforeReaderArgsProblem(read: BeforeStateRead): string | undefined {
  const probe = strictPick(read.argKeys);
  try {
    read.args(probe.pick);
  } catch (err) {
    const stray = probe.stray();
    return stray === undefined
      ? `before reader args threw on its own argKeys: ${errText(err)}`
      : `before reader args reads ${stray}, which is not an argKey`;
  }
  return undefined;
}

/**
 * Probes `select` (and a guard's `appliesTo` / `allows`) with a pick that answers only the union
 * of the reads' `argKeys`, so a selection or guard that depends on an undeclared input key is
 * reported. The replies are `undefined`, so a function that throws on the reply before it reads
 * the pick is not probed past that point (a stated bound: the runner's own pick holds only the
 * declared keys, so an undeclared key reads as absent at runtime, never as the model's value).
 */
export function beforeReaderSelectionProblems(reader: BeforeStateReader): string[] {
  const keys = beforeReaderArgKeys(reader);
  const out: string[] = [];
  type Probe = readonly [string, (pick: Readonly<Record<string, unknown>>) => unknown];
  const probes: Probe[] = [["select", (pick) => reader.select(undefined, pick, undefined)]];
  const guard = reader.guard;
  if (guard !== undefined) {
    // With a context naming both KB destinations (so a context-reading guard runs past its
    // `appliesTo`), and with none (the unreadable-config path).
    for (const ctx of [PROBE_GUARD_CONTEXT, undefined]) {
      probes.push(
        ["guard appliesTo", (pick) => guard.appliesTo(pick, ctx)],
        ["guard allows", (pick) => guard.allows(undefined, pick, undefined, ctx)],
      );
    }
  }
  for (const [name, call] of probes) {
    const probe = strictPick(keys);
    try {
      call(probe.pick);
    } catch {
      // A throw on the probe reply is expected; only a stray key is a problem.
    }
    const stray = probe.stray();
    if (stray !== undefined) {
      out.push(`before reader ${name} reads ${stray}, which is not an argKey`);
    }
  }
  // A guard is probed twice (with and without a context): report each problem once.
  return [...new Set(out)];
}

/** Test seam: the write-id set `isReadOnlyToolId` consults. */
export interface BeforeReaderCheckOptions {
  readonly writeIds?: ReadonlySet<string>;
}

/** The read-tool problems with one read: a read (`isReadOnlyToolId`) that is not a connector write. */
function readToolProblem(
  read: BeforeStateRead,
  opts: BeforeReaderCheckOptions,
): string | undefined {
  const isRead =
    opts.writeIds === undefined
      ? isReadOnlyToolId(read.tool)
      : isReadOnlyToolId(read.tool, opts.writeIds);
  const isWrite = isConnectorWriteToolId(read.tool) || (opts.writeIds?.has(read.tool) ?? false);
  return !isRead || isWrite ? `before tool ${read.tool} is not a read` : undefined;
}

/**
 * Every problem with `row.before` (empty when the row has none): it needs a typed preview; EACH
 * read (the first and `also`) needs argKeys that are a non-empty, duplicate-free subset of the keys
 * the template names, a tool that is a read (`isReadOnlyToolId`) and not a connector write
 * (`isConnectorWriteToolId`), and `args` that read only its own argKeys; `select` and a guard may
 * read only the union of those argKeys; a guard's reason is fixed text. Whether each tool is in the
 * server's listing is checked when the door lists the row (`engine/connector-write-agent-tools.ts`).
 */
export function beforeReaderProblems(
  row: ConnectorWriteRow,
  opts: BeforeReaderCheckOptions = {},
): string[] {
  const reader = row.before;
  if (reader === undefined) return [];
  const out: string[] = [];
  const named = row.preview === undefined ? undefined : previewTemplateKeys(row.preview);
  if (named === undefined) out.push(`row ${row.toolId}: a before reader needs a typed preview`);
  const reads: ReadonlyArray<readonly [string, BeforeStateRead]> =
    reader.also === undefined
      ? [["", reader]]
      : [
          ["", reader],
          ["also ", reader.also],
        ];
  for (const [which, read] of reads) {
    const prefix = `row ${row.toolId}: ${which}`;
    for (const p of beforeReadArgKeyProblems(read, named ?? new Set(read.argKeys))) {
      out.push(`${prefix}${p}`);
    }
    const toolProblem = readToolProblem(read, opts);
    if (toolProblem !== undefined) out.push(`${prefix}${toolProblem}`);
    const argsProblem = beforeReaderArgsProblem(read);
    if (argsProblem !== undefined) out.push(`${prefix}${argsProblem}`);
  }
  for (const p of beforeReaderSelectionProblems(reader)) out.push(`row ${row.toolId}: ${p}`);
  const guardProblem =
    reader.guard === undefined ? undefined : beforeGuardReasonProblem(reader.guard);
  if (guardProblem !== undefined) out.push(`row ${row.toolId}: ${guardProblem}`);
  return out;
}
