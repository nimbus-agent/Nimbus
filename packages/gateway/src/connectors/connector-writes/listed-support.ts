// packages/gateway/src/connectors/connector-writes/listed-support.ts
// What a connector's raw tool listing must carry for a write row to be used as designed, shared by
// the model door (`engine/connector-write-agent-tools.ts`) and the agent door (AD3a-2a): the row's
// typed preview must name only keys the listed schema declares (drift), and the tools its
// before-state reader and its bound prepare step call must be listed (spec § 5.4, I54). Pure
// functions over a listing; none of them lists or spawns anything.
import { readListedJsonSchema } from "../../engine/user-mcp-agent-tools.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { isPlainObject, previewTemplateKeys } from "./preview.ts";
import type { ConnectorWriteRow } from "./types.ts";

/** A connector's raw listing: `description` + `inputSchema` per `mcpClientToolKey`. */
export type ServerToolListing = Readonly<Record<string, unknown>>;

/**
 * Drift check: whether every input key the row's typed preview names (each `{key}` in `target` /
 * `summary` and each `fields[].key`, `whenUnset` fields included) is a TOP-LEVEL property of the
 * listed JSON Schema. A row without a template, or a schema without a `properties` object, fails.
 */
export function templateKeysInSchema(
  row: ConnectorWriteRow,
  jsonSchema: Record<string, unknown>,
): boolean {
  if (row.preview === undefined) return false;
  const properties = jsonSchema["properties"];
  if (!isPlainObject(properties)) return false;
  for (const key of previewTemplateKeys(row.preview)) {
    if (!Object.hasOwn(properties, key)) return false;
  }
  return true;
}

/**
 * {@link templateKeysInSchema} over one raw LISTING ENTRY (`{ description, inputSchema }`): false
 * when the entry is not an object or its schema cannot be read.
 */
export function listedEntryDeclaresPreviewKeys(row: ConnectorWriteRow, entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const schema = readListedJsonSchema(entry["inputSchema"]);
  return isPlainObject(schema) && templateKeysInSchema(row, schema);
}

function listedAsObject(service: string, tool: string, listing: ServerToolListing): boolean {
  const key = mcpClientToolKey(service, tool);
  return Object.hasOwn(listing, key) && isPlainObject(listing[key]);
}

/** Whether `row` has a `before` reader one of whose tools (the first, `also`) its listing lacks. */
export function beforeReaderMissing(
  row: ConnectorWriteRow,
  service: string,
  listing: ServerToolListing,
): boolean {
  const reader = row.before;
  if (reader === undefined) return false;
  const tools = reader.also === undefined ? [reader.tool] : [reader.tool, reader.also.tool];
  return tools.some((tool) => !listedAsObject(service, tool, listing));
}

/** Whether `row` is bound and its prepare tool is missing from its listing (I54). */
export function prepareToolMissing(
  row: ConnectorWriteRow,
  service: string,
  listing: ServerToolListing,
): boolean {
  const bound = row.bound;
  if (bound === undefined) return false;
  // The settle tool (the Terraform `show` read, D2) is one more prepare read of the same step.
  const tools = [bound.prepare.tool, bound.prepare.settleTool].filter(
    (t): t is string => t !== undefined,
  );
  return tools.some((tool) => !listedAsObject(service, tool, listing));
}
