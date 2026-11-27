// packages/gateway/src/automation/workflow-bundle.ts
// The signed workflow bundle (I59, signed workflow import, spec § 2): a pure module that builds the
// canonical body an export signs and verifies a bundle file an import reads. No Vault, no database, no
// network and no schedule or rule names: the signer is injected by the caller, and a bundle has no field
// that could carry a schedule, a standing rule, a trigger or a credential.
//
//   { "body": { format, name, description, author, issuedAt, steps, stepsSha256 },
//     "sig":  { alg: "ed25519", pubkey: <base64 32 bytes>, signature: <base64 64 bytes> } }
//
// Signed bytes = UTF-8 of `"nimbus-workflow-bundle/v1\n"` + `canonicalJson(body)`. The leading tag makes a
// confusion with any other signed thing (a share body starts with `{`, an egress receipt signs 64 hex
// characters) structurally impossible, and `format` is INSIDE the signed body.
//
// The steps must already be CANONICAL: parsing them with the strict step parser and printing them back
// must give the same text. So the string the owner reads, the string that is signed, the string that is
// stored and the string that is hashed are ONE string (what the parser would drop, rename or default
// makes the bundle refuse). A bundle holds deterministic `query` and `write` steps only: a model (`run`)
// prompt is third-party instructions to the owner's own model (owner ruling OR-WFI-3).
import { createHash } from "node:crypto";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import { looksLikeCredential } from "../security/credential-text.ts";
import { canonicalJson } from "../util/canonical-json.ts";
import { parseWorkflowSteps, type WorkflowStep, workflowStepsSha256 } from "./workflow-steps.ts";

export const BUNDLE_FORMAT = "nimbus-workflow-bundle/v1";
/** The domain tag that leads the signed bytes. */
export const BUNDLE_SIGN_TAG = `${BUNDLE_FORMAT}\n`;

export const BUNDLE_MAX_FILE_BYTES = 256 * 1024;
export const BUNDLE_MAX_STEPS = 50;
export const BUNDLE_MAX_STEPS_BYTES = 128 * 1024;
export const BUNDLE_MAX_DESCRIPTION = 500;
export const BUNDLE_MAX_AUTHOR = 64;
/** `issuedAt` may be at most this far ahead of the importer's clock (skew allowed). */
export const BUNDLE_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

export const BUNDLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A refused bundle: `code` is the stable `ERR_*` the caller can match. */
export class BundleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const E = {
  TOO_LARGE: "ERR_WORKFLOW_BUNDLE_TOO_LARGE",
  MALFORMED: "ERR_WORKFLOW_BUNDLE_MALFORMED",
  FORBIDDEN_KEY: "ERR_WORKFLOW_BUNDLE_FORBIDDEN_KEY",
  SIGNATURE: "ERR_WORKFLOW_BUNDLE_SIGNATURE",
  FORMAT: "ERR_WORKFLOW_BUNDLE_FORMAT",
  NAME: "ERR_WORKFLOW_BUNDLE_NAME",
  ISSUED_AT: "ERR_WORKFLOW_BUNDLE_ISSUED_AT",
  STEPS: "ERR_WORKFLOW_BUNDLE_STEPS",
  MODEL_STEP: "ERR_WORKFLOW_BUNDLE_MODEL_STEP",
  CREDENTIAL: "ERR_WORKFLOW_BUNDLE_CREDENTIAL",
} as const;

const BODY_KEYS: ReadonlySet<string> = new Set([
  "format",
  "name",
  "description",
  "author",
  "issuedAt",
  "steps",
  "stepsSha256",
]);
const SIG_KEYS: ReadonlySet<string> = new Set(["alg", "pubkey", "signature"]);
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["body", "sig"]);

/**
 * Keys a bundle is told it cannot carry, by their NORMALISED spelling (lower case, no `_` or `-`), so
 * `standingRule`, `standing_rule` and `Standing-Rule` are all named in the refusal. Any other unknown key
 * is refused as an unknown key.
 */
const FORBIDDEN_KEY_NOUNS: ReadonlyMap<string, string> = new Map([
  ["schedule", "a schedule"],
  ["scheduletz", "a schedule"],
  ["cron", "a schedule"],
  ["standingrule", "a standing rule"],
  ["standingrules", "a standing rule"],
  ["rules", "a standing rule"],
  ["rule", "a standing rule"],
  ["credentials", "a credential"],
  ["credential", "a credential"],
  ["secret", "a credential"],
  ["secrets", "a credential"],
  ["token", "a credential"],
  ["trigger", "a trigger"],
  ["triggers", "a trigger"],
  ["policy", "a policy"],
  ["connector", "a connector config"],
  ["config", "a connector config"],
]);

export type BundleBody = {
  readonly format: string;
  readonly name: string;
  readonly description: string | null;
  readonly author: string | null;
  readonly issuedAt: number;
  readonly steps: readonly unknown[];
  readonly stepsSha256: string;
};

/** What a verified bundle gives the importer. Everything here was computed or checked by this module. */
export interface VerifiedBundle {
  readonly body: BundleBody;
  /** The strictly parsed steps (equal to `body.steps` by the fixpoint rule). */
  readonly steps: readonly WorkflowStep[];
  /** `canonicalJson(steps)`: the exact text that is stored, hashed, shown and was signed. */
  readonly canonicalSteps: string;
  readonly bundleSha256: string;
  readonly signerPubkeyB64: string;
  /** 32 hex characters (`publisherKeyFingerprint`). */
  readonly signerFingerprint: string;
}

/** The bytes a bundle's signature covers. */
export function bundleSignedBytes(body: BundleBody): Uint8Array {
  return new TextEncoder().encode(BUNDLE_SIGN_TAG + canonicalJson(body));
}

export function bundleSha256Of(body: BundleBody): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strictBase64(s: unknown, bytes: number): Uint8Array | undefined {
  if (typeof s !== "string") return undefined;
  const raw = Buffer.from(s, "base64");
  if (raw.length !== bytes || raw.toString("base64") !== s) return undefined;
  return new Uint8Array(raw);
}

function refuseUnknownKeys(
  rec: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void {
  for (const key of Object.keys(rec)) {
    if (allowed.has(key)) continue;
    const noun = FORBIDDEN_KEY_NOUNS.get(key.toLowerCase().replaceAll(/[_-]/g, ""));
    if (noun !== undefined) {
      throw new BundleError(E.FORBIDDEN_KEY, `a bundle cannot carry ${noun} (found "${key}")`);
    }
    throw new BundleError(E.MALFORMED, `unknown key in the bundle's ${where}`);
  }
}

/**
 * A parsed step back in the form the parser READS. The parser turns a `when` comparison
 * `{ count, gt: 0 }` into `{ count, op: "gt", value: 0 }`; the stored and signed text keeps the form the
 * parser accepts, so the fixpoint is `print(parse(text)) === text` over this input form. The hash that
 * standing rules and run history use stays `workflowStepsSha256` of the PARSED steps.
 */
function toInputForm(step: WorkflowStep): unknown {
  if (step.kind !== "write" || step.when === undefined) return step;
  const when = step.when.map((g) => ({ count: g.count, [g.op]: g.value }));
  return { ...step, when };
}

/** The canonical text of parsed steps in the form the parser reads (what is stored and signed). */
export function canonicalStepsText(parsed: readonly WorkflowStep[]): string {
  return canonicalJson(parsed.map(toInputForm));
}

/**
 * The deterministic steps of a bundle, validated: no model (`run`) step, at most 50 steps, strictly
 * parsed, and ALREADY canonical (the parser changes nothing). Returns the parsed steps and their text.
 */
export function canonicalBundleSteps(steps: unknown): {
  parsed: WorkflowStep[];
  text: string;
} {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new BundleError(E.STEPS, "steps must be a non-empty array");
  }
  if (steps.length > BUNDLE_MAX_STEPS) {
    throw new BundleError(E.STEPS, `a bundle holds at most ${String(BUNDLE_MAX_STEPS)} steps`);
  }
  for (const row of steps as unknown[]) {
    // Phase 7 slice 4: a report step is scheduled, unattended delivery the owner builds locally
    // (`nimbus cost report schedule`); a signed bundle never carries one (I59).
    if (isRecord(row) && row["kind"] === "report") {
      throw new BundleError(
        E.STEPS,
        "a bundle holds query and write steps only: a report step is not allowed",
      );
    }
    if (!isRecord(row) || (row["kind"] !== "query" && row["kind"] !== "write")) {
      throw new BundleError(
        E.MODEL_STEP,
        "a bundle holds query and write steps only: a model (run) step is not allowed",
      );
    }
  }
  const text = canonicalJson(steps);
  if (Buffer.byteLength(text, "utf8") > BUNDLE_MAX_STEPS_BYTES) {
    throw new BundleError(E.STEPS, "the steps are too large for a bundle");
  }
  let parsed: WorkflowStep[];
  try {
    parsed = parseWorkflowSteps(text);
  } catch (e) {
    throw new BundleError(E.STEPS, `the steps are not valid: ${(e as Error).message}`);
  }
  if (canonicalStepsText(parsed) !== text) {
    throw new BundleError(E.STEPS, "steps are not in canonical form");
  }
  return { parsed, text };
}

function validateBodyFields(body: Record<string, unknown>, now: number): void {
  if (body["format"] !== BUNDLE_FORMAT) {
    throw new BundleError(E.FORMAT, "this is not a nimbus-workflow-bundle/v1 bundle");
  }
  const name = body["name"];
  if (typeof name !== "string" || !BUNDLE_NAME_PATTERN.test(name)) {
    throw new BundleError(
      E.NAME,
      "the workflow name must be 1 to 64 letters, digits, dot, dash or underscore",
    );
  }
  const description = body["description"];
  if (
    description !== null &&
    (typeof description !== "string" || description.length > BUNDLE_MAX_DESCRIPTION)
  ) {
    throw new BundleError(E.MALFORMED, "description must be null or at most 500 characters");
  }
  const author = body["author"];
  if (author !== null && (typeof author !== "string" || author.length > BUNDLE_MAX_AUTHOR)) {
    throw new BundleError(E.MALFORMED, "author must be null or at most 64 characters");
  }
  const issuedAt = body["issuedAt"];
  if (
    typeof issuedAt !== "number" ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt < 0 ||
    issuedAt > now + BUNDLE_MAX_FUTURE_MS
  ) {
    throw new BundleError(E.ISSUED_AT, "issuedAt must be a past time in milliseconds");
  }
}

/** Parses a bundle FILE's text into its envelope, refusing anything that is not exactly body + sig. */
function parseEnvelope(fileText: string): {
  body: Record<string, unknown>;
  sig: Record<string, unknown>;
} {
  if (Buffer.byteLength(fileText, "utf8") > BUNDLE_MAX_FILE_BYTES) {
    throw new BundleError(E.TOO_LARGE, "the bundle file is larger than 256 KiB");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(fileText);
  } catch {
    throw new BundleError(E.MALFORMED, "the bundle is not valid JSON");
  }
  if (!isRecord(envelope)) throw new BundleError(E.MALFORMED, "the bundle is not a JSON object");
  refuseUnknownKeys(envelope, ENVELOPE_KEYS, "envelope");
  const { body, sig } = envelope;
  if (!isRecord(body) || !isRecord(sig)) {
    throw new BundleError(E.MALFORMED, "the bundle needs a body and a sig");
  }
  refuseUnknownKeys(body, BODY_KEYS, "body");
  refuseUnknownKeys(sig, SIG_KEYS, "sig");
  return { body, sig };
}

/**
 * Verifies a bundle file: size, strict envelope, signature (over the domain-tagged canonical body), the
 * format, name, `issuedAt` window, the canonical deterministic steps and `stepsSha256`. Throws
 * {@link BundleError}; touches no store and asks nobody.
 */
export function verifyBundle(fileText: string, now: number): VerifiedBundle {
  const { body, sig } = parseEnvelope(fileText);
  if (sig["alg"] !== "ed25519") {
    throw new BundleError(E.SIGNATURE, "the signature algorithm is not ed25519");
  }
  const pub = strictBase64(sig["pubkey"], 32);
  const signature = strictBase64(sig["signature"], 64);
  if (pub === undefined || signature === undefined) {
    throw new BundleError(E.SIGNATURE, "the signature or public key is malformed");
  }
  const typed = body as unknown as BundleBody;
  if (!nacl.sign.detached.verify(bundleSignedBytes(typed), signature, pub)) {
    throw new BundleError(E.SIGNATURE, "the signature does not match the bundle");
  }
  validateBodyFields(body, now);
  const { parsed, text } = canonicalBundleSteps(body["steps"]);
  if (body["stepsSha256"] !== workflowStepsSha256(parsed)) {
    throw new BundleError(E.STEPS, "stepsSha256 does not match the steps");
  }
  const pubkeyB64 = sig["pubkey"] as string;
  return {
    body: typed,
    steps: parsed,
    canonicalSteps: text,
    bundleSha256: bundleSha256Of(typed),
    signerPubkeyB64: pubkeyB64,
    signerFingerprint: publisherKeyFingerprint(pubkeyB64),
  };
}

export interface BuildBundleInput {
  readonly name: string;
  readonly description: string | null;
  readonly author: string | null;
  readonly issuedAt: number;
  /** The stored `steps_json` of the workflow being exported. */
  readonly stepsJson: string;
}

/**
 * The body an export signs, built from a stored workflow. Refuses a model step, a step count or size over
 * the caps, a name or text that a bundle cannot hold, and any step whose text looks like a credential
 * (naming the step). The credential scan is a heuristic.
 */
export function buildBundleBody(input: BuildBundleInput, now: number): BundleBody {
  let parsed: WorkflowStep[];
  try {
    parsed = parseWorkflowSteps(input.stepsJson);
  } catch (e) {
    throw new BundleError(E.STEPS, `the workflow's steps are not valid: ${(e as Error).message}`);
  }
  // Validate the CANONICAL form exactly as an importer will.
  const canonical = canonicalBundleSteps(JSON.parse(canonicalStepsText(parsed)) as unknown);
  canonical.parsed.forEach((step, i) => {
    if (looksLikeCredential(canonicalJson(step))) {
      // Never echo a label that itself looks like a credential: the message reaches IPC.
      const label =
        step.label === undefined || looksLikeCredential(step.label)
          ? ""
          : ` ("${step.label.slice(0, 40)}")`;
      throw new BundleError(
        E.CREDENTIAL,
        `step ${String(i + 1)}${label} looks like it holds a credential; remove it before exporting`,
      );
    }
  });
  // The description and the author label are signed into the bundle too; the refusal names the
  // field and never echoes its text.
  for (const [field, value] of [
    ["description", input.description],
    ["author", input.author],
  ] as const) {
    if (value !== null && looksLikeCredential(value)) {
      throw new BundleError(
        E.CREDENTIAL,
        `the workflow's ${field} looks like it holds a credential; remove it before exporting`,
      );
    }
  }
  const body: BundleBody = {
    format: BUNDLE_FORMAT,
    name: input.name,
    description: input.description,
    author: input.author,
    issuedAt: input.issuedAt,
    steps: JSON.parse(canonical.text) as unknown[],
    stepsSha256: workflowStepsSha256(canonical.parsed),
  };
  validateBodyFields(body as unknown as Record<string, unknown>, now);
  return body;
}

/** The file text of a signed bundle (what `workflow export` writes). */
export function assembleBundle(body: BundleBody, signatureB64: string, pubkeyB64: string): string {
  const envelope = { body, sig: { alg: "ed25519", pubkey: pubkeyB64, signature: signatureB64 } };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}
