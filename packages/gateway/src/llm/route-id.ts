// packages/gateway/src/llm/route-id.ts

import type { ProviderId } from "./types.ts";

/**
 * The ONLY place a route reference string is built or split.
 *
 * `routeId` is opaque INSIDE the router — `ModelRoute` already carries `providerId`
 * and `modelName` as separate fields, so parsing the key there would re-derive data
 * the struct holds. Parsing belongs only where a human typed a string:
 * `[llm] route_priority` entries and (slice 4) `nimbus llm use <ref>`.
 *
 * The split is on the FIRST slash and that is load-bearing: model names legitimately
 * contain slashes. `LlamaCppProvider`'s model name defaults to `"model.gguf"` and is
 * realistically a path (`/models/meta-llama/Llama-3-8B.gguf`, or a Windows path with
 * backslashes and a drive colon), and Ollama accepts namespaced tags like
 * `hf.co/user/model`. The delimiter is unambiguous only because the LEFT half cannot
 * contain it, which `makeRouteId` enforces.
 */
export function makeRouteId(providerId: ProviderId, modelName: string): string {
  if (providerId.includes("/")) {
    throw new Error(`providerId must not contain "/": ${providerId}`);
  }
  if (providerId === "") throw new Error("providerId must not be empty");
  if (modelName === "") throw new Error("modelName must not be empty");
  return `${providerId}/${modelName}`;
}

/**
 * Parse a human-supplied route reference. THROWS on anything malformed rather than
 * returning `undefined`: a `route_priority` entry that silently vanished would
 * degrade the router to default ordering with no signal, which is the "a supplied
 * flag decaying into an omitted filter" shape — invisible from the outside.
 */
export function parseRouteRef(raw: string): { providerId: ProviderId; modelName: string } {
  const i = raw.indexOf("/");
  if (i === -1) {
    throw new Error(`malformed route reference "${raw}": expected "<provider>/<model>"`);
  }
  const providerId = raw.slice(0, i);
  const modelName = raw.slice(i + 1); // may itself contain slashes — deliberate
  if (providerId === "") throw new Error(`malformed route reference "${raw}": empty provider`);
  if (modelName === "") throw new Error(`malformed route reference "${raw}": empty model`);
  return { providerId, modelName };
}
