import type { GroundedEndpoint } from "./toolgen-grounding.ts";

export interface DraftPromptInput {
  readonly description: string;
  readonly hosts: readonly string[];
  /** Hosts that will carry a credential. NAMES ONLY — this module never sees a secret value. */
  readonly credentialHosts: readonly string[];
  readonly endpoints: readonly GroundedEndpoint[];
}

function groundingBlock(endpoints: readonly GroundedEndpoint[]): string {
  if (endpoints.length === 0) {
    return "No indexed API specification matched this description. Draft from the description and standard REST conventions, and prefer conservative assumptions.";
  }
  const lines = endpoints.map((e) => {
    const opId = e.operationId === null ? "" : ` (operationId: ${e.operationId})`;
    const summary = e.summary === "" ? "" : `\n  ${e.summary}`;
    return `- [${e.serviceName}] ${e.method} ${e.path}${opId}${summary}`;
  });
  return `These endpoints come from OpenAPI specifications indexed on this machine. Prefer them over guessed paths:\n${lines.join("\n")}`;
}

function credentialBlock(credentialHosts: readonly string[]): string {
  if (credentialHosts.length === 0) {
    return "No credential is configured. Do not invent an Authorization header.";
  }
  return `For these hosts a credential is attached automatically by the gateway, outside your code: ${credentialHosts.join(", ")}. Do NOT write an Authorization header yourself — you cannot see the secret and any header you write would be stripped.`;
}

/**
 * The drafting prompt.
 *
 * Its REQUIRED CONTENT is a contract (spec § 4.4) because each item is a fact about the emitted
 * skeleton rather than a matter of phrasing. The `nimbusFetch` return shape is the load-bearing
 * one: models are trained on the Web `fetch` API and will otherwise draft `await res.json()`,
 * which passes every ladder rung and fails only at runtime, after the owner has approved it.
 */
export function buildDraftPrompt(input: DraftPromptInput): string {
  return [
    "You author the body of a sandboxed Nimbus tool. Return code, not prose.",
    "",
    "ENVIRONMENT",
    "- Your code becomes the body of: async function __invoke(args) { <your body> }",
    "- The process has NO network. The only way out is the injected global:",
    "    nimbusFetch(url, init?) -> Promise<{ status, statusText, headers, body }>",
    "- IMPORTANT: `body` is ALREADY a decoded string. There is no res.json() and no res.text().",
    "  Parse JSON with JSON.parse(res.body).",
    "- IMPORTANT: `headers` is a plain object of lower-cased header names to string values.",
    '  Access headers as res.headers["content-type"], with no .get() method.',
    "- There are no imports and no node_modules. Only standard ECMAScript globals exist",
    "  (JSON, URL, URLSearchParams, Math, Date, Array, String, Number). Build query strings",
    "  with URLSearchParams.",
    "- Do not use fetch, require, import, eval, process or Bun. They are unavailable and the",
    "  draft will be rejected.",
    `- Requests may only go to these hosts: ${input.hosts.join(", ")}`,
    "- Every request must use https://. The gateway refuses http:// even for an approved host.",
    `- ${credentialBlock(input.credentialHosts)}`,
    "- Throw an Error when the API responds with status >= 400. Return a JSON-serialisable value.",
    "",
    "OUTPUT",
    "Reply with ONE JSON object and nothing else, with exactly these two keys:",
    '  "inputSchema": {"type":"object","properties":{...},"required":[...]}',
    '  "body": "<the JavaScript body of __invoke, as a string>"',
    "Each property type must be string, number, boolean, or an array of those. Nested objects,",
    "$ref, $schema, oneOf, anyOf, allOf and additionalProperties are not allowed.",
    "",
    "REQUEST",
    input.description,
    "",
    "INDEXED API REFERENCE",
    groundingBlock(input.endpoints),
  ].join("\n");
}

export function buildRedraftPrompt(previous: string, rung: string, reason: string): string {
  return [
    previous,
    "",
    "YOUR PREVIOUS REPLY WAS REJECTED",
    `Failed check: ${rung}`,
    `Reason: ${reason}`,
    "Return only the corrected JSON object with the two keys. Do not explain the change.",
  ].join("\n");
}
