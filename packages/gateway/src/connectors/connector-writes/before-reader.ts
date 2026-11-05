// packages/gateway/src/connectors/connector-writes/before-reader.ts
// Validation for a write row's `before` reader (spec § 5.4). Not imported by the row files: it
// reads the read/write classifiers, which import the row table. `withBefore` (./types.ts) checks
// the structure when a row is built; this module adds the checks that need the classifiers and is
// run over every row by its test.
import { isReadOnlyToolId } from "../../share/read-tool-registry.ts";
import { isConnectorWriteToolId } from "../connector-write-registry.ts";
import { type BeforeStateReader, type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

export { pickBeforeReaderArgs } from "./types.ts";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Probes `reader.args` with a Proxy that answers only `argKeys` and throws on any other key, so a
 * reader that reads a key it did not declare is caught in a test rather than silently reading
 * `undefined` at runtime. `undefined` means no problem.
 */
export function beforeReaderArgsProblem(reader: BeforeStateReader): string | undefined {
  const allowed = new Set(reader.argKeys);
  const target: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const k of reader.argKeys) target[k] = `probe:${k}`;
  let stray: string | undefined;
  const probe = new Proxy(target, {
    get(t, key) {
      if (typeof key === "string" && allowed.has(key)) return t[key];
      stray = String(key);
      throw new Error(`args read ${String(key)}, which is not an argKey`);
    },
    has(t, key) {
      if (typeof key === "string" && allowed.has(key)) return key in t;
      stray = String(key);
      throw new Error(`args tested ${String(key)}, which is not an argKey`);
    },
  });
  try {
    reader.args(probe);
  } catch (err) {
    return stray === undefined
      ? `before reader args threw on its own argKeys: ${errText(err)}`
      : `before reader args reads ${stray}, which is not an argKey`;
  }
  return undefined;
}

/** Test seam: the write-id set `isReadOnlyToolId` consults. */
export interface BeforeReaderCheckOptions {
  readonly writeIds?: ReadonlySet<string>;
}

/**
 * Every problem with `row.before` (empty when the row has none): it needs a typed preview, its
 * argKeys must be a non-empty, duplicate-free subset of the keys the template names, its tool must
 * be a read (`isReadOnlyToolId`) that is not a connector write (`isConnectorWriteToolId`), and its
 * `args` must read only its argKeys. Whether the tool is in the server's listing is checked when
 * the door lists the row (`engine/connector-write-agent-tools.ts`).
 */
export function beforeReaderProblems(
  row: ConnectorWriteRow,
  opts: BeforeReaderCheckOptions = {},
): string[] {
  const reader = row.before;
  if (reader === undefined) return [];
  const out: string[] = [];
  if (row.preview === undefined) {
    out.push(`row ${row.toolId}: a before reader needs a typed preview`);
  } else {
    const named = previewTemplateKeys(row.preview);
    for (const k of reader.argKeys) {
      if (!named.has(k)) out.push(`row ${row.toolId}: argKey ${k} is not a key the preview names`);
    }
  }
  if (reader.argKeys.length === 0) out.push(`row ${row.toolId}: needs at least one argKey`);
  if (new Set(reader.argKeys).size !== reader.argKeys.length) {
    out.push(`row ${row.toolId}: duplicate argKey`);
  }
  const isRead =
    opts.writeIds === undefined
      ? isReadOnlyToolId(reader.tool)
      : isReadOnlyToolId(reader.tool, opts.writeIds);
  const isWrite = isConnectorWriteToolId(reader.tool) || (opts.writeIds?.has(reader.tool) ?? false);
  if (!isRead || isWrite) {
    out.push(`row ${row.toolId}: before tool ${reader.tool} is not a read`);
  }
  const argsProblem = beforeReaderArgsProblem(reader);
  if (argsProblem !== undefined) out.push(`row ${row.toolId}: ${argsProblem}`);
  return out;
}
