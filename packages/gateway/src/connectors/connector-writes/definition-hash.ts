// packages/gateway/src/connectors/connector-writes/definition-hash.ts
// The SHA-256 of a connector write tool's LISTED definition (Phase 28 AD3a-1, D-AD-9). The owner's
// `enable --door agent` approval stores it; a later listing that hashes differently suspends the tool
// for agents until the owner approves it again by name.
//
// What is hashed is what the mesh lists, through the same reader the model door uses
// (`readListedJsonSchema`): the tool id, the description (or null when it is not a string) and the
// input JSON Schema. A listing whose schema that reader cannot read has no hash, so it cannot be
// approved. Stated bound: the hash covers the JSON Schema as this gateway's Mastra version converts
// it, so a Mastra upgrade that converts differently suspends tools until they are re-approved.
import { createHash } from "node:crypto";

import { readListedJsonSchema } from "../../engine/user-mcp-agent-tools.ts";
import { canonicalJson } from "../../util/canonical-json.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Lower-case hex SHA-256 of the canonical JSON of `{ toolId, description, inputSchema }`, or
 * `undefined` when `listed` is not an object or its input schema cannot be read as a JSON Schema
 * object.
 */
export function definitionSha256(toolId: string, listed: unknown): string | undefined {
  if (!isRecord(listed)) return undefined;
  const inputSchema = readListedJsonSchema(listed["inputSchema"]);
  if (!isRecord(inputSchema)) return undefined;
  const description = typeof listed["description"] === "string" ? listed["description"] : null;
  return createHash("sha256")
    .update(canonicalJson({ toolId, description, inputSchema }))
    .digest("hex");
}
