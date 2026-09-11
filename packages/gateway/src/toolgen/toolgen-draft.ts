import { scanBodyForForbiddenGlobals, verifyBodySyntax } from "./toolgen-body-checks.ts";
import { type DraftGrounding, type GroundedEndpoint, groundingOf } from "./toolgen-grounding.ts";
import { buildDraftPrompt, buildRedraftPrompt } from "./toolgen-prompt.ts";
import { validateInputSchema } from "./toolgen-schema.ts";
import {
  type CreateGeneratedToolRequest,
  type DraftGeneration,
  type DraftSubject,
  ToolgenError,
  type ToolInputSchema,
} from "./toolgen-types.ts";

const GROUNDING_LIMIT = 8;

export interface DraftedTool {
  readonly body: string;
  readonly inputSchema: ToolInputSchema;
  readonly grounding: DraftGrounding;
  readonly attempts: 1 | 2;
  /**
   * Whether the model that authored this body was local. DERIVED from `provider.isLocal` (I34),
   * never from a vendor id or a config value — `drafting = "allow-remote"` permits a remote draft
   * but does not mean one happened. Recorded on the audit row and used by the CLI to decide
   * whether "configure a larger local model" is useful advice.
   */
  readonly locality: "local" | "remote";
}

export type { DraftGeneration };

export interface ToolgenDraftDeps {
  /** Narrowed router view. `null` means no eligible provider — never an empty string. */
  readonly generate: (prompt: string) => Promise<DraftGeneration | null>;
  /**
   * Whether a drafting route exists, asked WITHOUT generating.
   *
   * Exists so `draftGeneratedTool` can refuse before it grounds. `findEndpoints` is a local index
   * read, but the query EMBEDDING it computes follows `[embedding]`, and against a remote vendor
   * that is a real outbound request carrying the owner's tool description. Refusing `off` (or "no
   * eligible provider") after that would have sent the description to an embedding vendor for a
   * draft that could never happen.
   *
   * Built by `createToolgenDraftRouteProbe`, which shares ONE mode/locality decision with
   * `createToolgenDraftLlm` — see its docstring for why they must not be two copies.
   */
  readonly hasDraftRoute: () => Promise<boolean>;
  readonly findEndpoints: (query: string, limit: number) => Promise<GroundedEndpoint[]>;
}

/**
 * Pull the JSON object out of whatever the model wrapped it in. NORMALISATION, not a ladder rung.
 *
 * Three widening attempts, in order. An ANCHORED fence regex is not enough: a reply reading
 * "Here is the tool:\n```json\n{…}\n```" matches nothing, falls through as raw text, fails
 * `JSON.parse`, and burns the single redraft on a formatting artifact — spending the retry budget
 * that exists for real defects.
 *
 * Widening is safe because `JSON.parse` downstream remains the actual gate: an over-eager slice
 * that grabs prose simply fails rung 1, exactly as no extraction would have. This can make a
 * malformed reply parse; it cannot make a non-object one pass.
 */
export function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Not bare JSON — fall through to the wrapped forms.
  }
  // Unanchored, so surrounding prose does not defeat it. The run before the newline is
  // non-newline whitespace (`[^\S\n]*`) and NOT `\s*`: `\s` includes `\n`, so `\s*\n` gives the
  // engine two ways to match every newline in a run, and a reply that opens a fence it never
  // closes then costs quadratic backtracking instead of failing at once.
  const fenced = /```(?:json)?[^\S\n]*\n([\s\S]*?)\n?```/.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1].trim();

  // Outermost braces. `lastIndexOf` and not the first closing brace, so a `}` inside the body
  // string does not truncate the object.
  const open = trimmed.indexOf("{");
  const close = trimmed.lastIndexOf("}");
  if (open >= 0 && close > open) return trimmed.slice(open, close + 1).trim();

  return trimmed;
}

interface LadderFailure {
  readonly rung: string;
  readonly reason: string;
}

/** What the ladder itself can determine. `grounding`, `attempts` and `locality` are the caller's. */
type LadderPass = Pick<DraftedTool, "body" | "inputSchema">;

function runLadder(raw: string): LadderPass | LadderFailure {
  // Rung 1 — the envelope parses.
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(raw));
  } catch (err) {
    return {
      rung: "rung 1 (output envelope)",
      reason: `reply is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { rung: "rung 1 (output envelope)", reason: "reply is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const body = obj["body"];
  if (typeof body !== "string" || body.trim() === "") {
    return { rung: "rung 1 (output envelope)", reason: '"body" must be a non-empty string' };
  }

  // Rung 2 — the schema is inside the restricted subset.
  let inputSchema: ToolInputSchema;
  try {
    inputSchema = validateInputSchema(obj["inputSchema"]);
  } catch (err) {
    return { rung: "rung 2 (input schema)", reason: (err as Error).message };
  }

  // Rung 3 — the body parses.
  try {
    verifyBodySyntax(body);
  } catch (err) {
    return { rung: "rung 3 (body syntax)", reason: (err as Error).message };
  }

  // Rung 4 — no construct the sandbox would refuse. NOT a security boundary; see the module.
  try {
    scanBodyForForbiddenGlobals(body);
  } catch (err) {
    return { rung: "rung 4 (forbidden globals)", reason: (err as Error).message };
  }

  return { body, inputSchema };
}

function isFailure(v: LadderPass | LadderFailure): v is LadderFailure {
  return "rung" in v;
}

export type { DraftSubject };

/**
 * Draft one tool: ground, prompt, validate, and redraft AT MOST once.
 *
 * One retry and not zero because the commonest failure is a model returning prose, which it
 * recovers from when told. One and not N because every attempt is a real model call that a remote
 * route ledgers and that spends the owner's budget (spec § 4.3).
 *
 * Takes `CreateGeneratedToolRequest` plus a host SUBJECT and nothing else: credential material must
 * never reach a drafting prompt, since a secret in a remote model's context has left the machine
 * (spec § 9.1). `credentialHosts` is a list of NAMES, resolved by the gate from the credentials it
 * holds — this function is never handed the credentials themselves and has no type that could
 * carry one.
 */
export async function draftGeneratedTool(
  req: CreateGeneratedToolRequest,
  deps: ToolgenDraftDeps,
  subject: DraftSubject,
): Promise<DraftedTool> {
  // BEFORE grounding, deliberately. `findEndpoints` reads the local index, but the query embedding
  // it computes on `req.description` follows the `[embedding]` configuration, and a remote embedder
  // makes that a real outbound request (ledgered `model`-class, but outbound all the same). A mode
  // of `"off"` — or a machine with no eligible drafting route — must therefore refuse here rather
  // than one line later, or an owner who switched drafting OFF would still have watched their tool
  // description leave the machine.
  //
  // The message and the error code are exactly what the in-loop `null` produces on a FIRST attempt
  // (`last === null` there), because that is the same fact: no model is available. The in-loop check
  // below stays, and still carries the two-part message for a redraft that loses its route
  // mid-draft.
  if (!(await deps.hasDraftRoute())) {
    throw new ToolgenError(
      "ERR_TOOLGEN_NO_DRAFT_MODEL",
      "no model is available to draft a tool body",
    );
  }
  const endpoints = await deps.findEndpoints(req.description, GROUNDING_LIMIT);
  const grounding = groundingOf(endpoints);
  const prompt = buildDraftPrompt({
    description: req.description,
    // NORMALISED hosts, from the gate. Passing `req.hosts` here would show the model what the
    // owner TYPED (`https://api.github.com/v1`) while the broker matches `url.hostname`
    // (`api.github.com`) — the prompt would name a host the tool cannot actually reach.
    hosts: subject.hosts,
    credentialHosts: subject.credentialHosts,
    endpoints,
  });

  let current = prompt;
  let last: LadderFailure | null = null;
  // The locality of the last route that actually ANSWERED, kept across attempts so the final
  // `ERR_TOOLGEN_DRAFT_INVALID` throw (both attempts answered but failed the ladder) can report
  // which route produced the body the owner would have been asked to approve. `null` here means
  // no model has answered yet -- distinct from `ERR_TOOLGEN_NO_DRAFT_MODEL`, which has no locality
  // to report at all because nothing answered.
  let lastLocality: "local" | "remote" | null = null;
  for (const attempt of [1, 2] as const) {
    const generated = await deps.generate(current);
    if (generated === null) {
      // A `null` on the redraft call means the FIRST attempt's failure is being discarded —
      // the owner must not be sent off to "configure a model" when one just answered and failed
      // validation. State both facts: what the first attempt got wrong, and that the redraft
      // could not reach a model at all. A `null` on the very first call has no prior failure to
      // report, so `last` is `null` there and the message stays exactly as it always was.
      //
      // No `locality` here: `ERR_TOOLGEN_NO_DRAFT_MODEL` means no route answered AT ALL on this
      // call, so there is nothing to report -- reusing `lastLocality` from a PRIOR attempt would
      // claim a route for a failure that has none.
      throw new ToolgenError(
        "ERR_TOOLGEN_NO_DRAFT_MODEL",
        last === null
          ? "no model is available to draft a tool body"
          : `the first attempt failed at ${last.rung}: ${last.reason} — no model was available for the redraft`,
      );
    }
    lastLocality = generated.isLocal ? "local" : "remote";
    const result = runLadder(generated.text);
    if (!isFailure(result)) {
      return {
        ...result,
        grounding,
        attempts: attempt,
        locality: lastLocality,
      };
    }
    last = result;
    current = buildRedraftPrompt(prompt, result.rung, result.reason);
  }

  // Both attempts reached a model and both failed the ladder -- `lastLocality` is the route that
  // produced the second (most recent) failing draft, carried on the error so the CLI can decide
  // whether "configure a larger local model" is useful advice (spec: only when the failing route
  // was local).
  throw new ToolgenError(
    "ERR_TOOLGEN_DRAFT_INVALID",
    `the drafted tool failed validation twice — ${last?.rung ?? "unknown"}: ${last?.reason ?? ""}`,
    lastLocality ?? undefined,
  );
}

/**
 * The exact composition `platform/assemble.ts`'s `draftTool` closure is built from —
 * `(req, subject) => draftGeneratedTool(req, deps, subject)` — extracted into one factory so a
 * caller drives the SAME function `assemble.ts` wires into `ToolgenGateDeps.draftTool`, rather
 * than a copy of its shape that could silently drift from it. Reverting `assemble.ts` to build its
 * closure some other way (or to stop calling this at all) changes what every caller of this
 * factory produces, including a test's.
 *
 * Typed structurally (`CreateGeneratedToolRequest`/`DraftSubject`/`Promise<DraftedTool>`, matching
 * `ToolgenGateDeps["draftTool"]`'s own shape in `toolgen-gate.ts`) rather than by importing
 * `ToolgenGateDeps` itself — that module already imports `DraftedTool` from this one, and importing
 * its type back here would be a cycle.
 */
export function createDraftToolClosure(
  deps: ToolgenDraftDeps,
): (req: CreateGeneratedToolRequest, subject: DraftSubject) => Promise<DraftedTool> {
  return (req, subject) => draftGeneratedTool(req, deps, subject);
}
