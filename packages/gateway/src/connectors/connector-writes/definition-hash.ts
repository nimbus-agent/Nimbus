// packages/gateway/src/connectors/connector-writes/definition-hash.ts
// The SHA-256 of a connector write tool's LISTED definition (Phase 28 AD3a-1, D-AD-9). The owner's
// `enable --door agent` approval stores it; a later listing that hashes differently suspends the tool
// for agents until the owner approves it again by name.
//
// What is hashed is what the mesh lists, through the same reader the model door uses
// (`readListedJsonSchema`): the tool id, the description and the input JSON Schema. A string
// description hashes as itself and an ABSENT one (no key, or `undefined`) as `null`, so every hash
// AD3a-1 stored stays valid; a description that is PRESENT and not a string (a `null`, a number, an
// object) makes the definition unreadable (AD3a-2a, review R-3), so a listing cannot be bent into
// hashing like a missing one. A listing whose schema that reader cannot read has no hash either, so
// it cannot be approved. (Mastra's client lists an absent description as the empty string, which
// hashes as that string.) Stated bound: the hash covers the JSON Schema as this gateway's Mastra version converts
// it, so a Mastra upgrade that converts differently suspends tools until they are re-approved.
import { createHash } from "node:crypto";

import { readListedJsonSchema } from "../../engine/user-mcp-agent-tools.ts";
import { canonicalJson } from "../../util/canonical-json.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Lower-case hex SHA-256 of the canonical JSON of `{ toolId, description, inputSchema }`, or
 * `undefined` when `listed` is not an object, its description is present and not a string, or its
 * input schema cannot be read as a JSON Schema object.
 */
export function definitionSha256(toolId: string, listed: unknown): string | undefined {
  if (!isRecord(listed)) return undefined;
  const inputSchema = readListedJsonSchema(listed["inputSchema"]);
  if (!isRecord(inputSchema)) return undefined;
  const raw = listed["description"];
  if (raw !== undefined && typeof raw !== "string") return undefined;
  const description = raw ?? null;
  return createHash("sha256")
    .update(canonicalJson({ toolId, description, inputSchema }))
    .digest("hex");
}
