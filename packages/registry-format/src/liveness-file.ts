/**
 * The liveness file (`liveness.json`): one signed static document a registry publishes beside
 * `index.json`, carrying what the registry's own checks observed about each published version (did
 * its declared hosts answer, did its tests pass, the Nimbus baseline). It is signed by a SEPARATE
 * liveness key the index names (`livenessKey`), over the canonical JSON of the document without
 * `signature`; unknown top-level keys are tolerated and carried through.
 *
 * `parseLivenessFile` checks the envelope only. `extensions` is carried RAW and read per version with
 * `readLivenessEntry`, which never throws: a malformed entry reads as `invalid`.
 * Pure: no Bun, no gateway imports, no ES2024+ runtime API (it runs under the runner's Node).
 */
// NOSONAR S1874: deprecated in SDK 1.32.0. Signed bytes must match `index-format.ts`, which signs this
// export; `@nimbus-dev/sdk/signing` NFC-normalises differently.

import { createHash, sign } from "node:crypto";
import { canonicalize } from "@nimbus-dev/sdk"; // NOSONAR S1874
import nacl from "tweetnacl";
import { MAX_EVAL_CASES } from "./caps.ts";
import { privateKeyFromSeed } from "./ed25519-seed.ts";
import { RegistryError } from "./errors.ts";
import { type EvalBaseline, parseEvalBaseline } from "./eval-baseline.ts";

export const LIVENESS_FILE = "liveness.json";
export const MAX_LIVENESS_BYTES = 4 * 1024 * 1024;
export const LIVENESS_TEST_FAILURES = ["run-failed", "run-timeout", "sandbox-unavailable"] as const;
export type LivenessTestFailure = (typeof LIVENESS_TEST_FAILURES)[number];

export interface LivenessFile {
  format: 1;
  livenessKey: string;
  sequence: number;
  generatedAt: string;
  nimbusVersion: string;
  /** Carried RAW (the signature covers the whole document); read with `readLivenessEntry`. */
  readonly extensions: unknown;
  signature: string;
}

export type LivenessEntry = {
  readonly checkedAt: string;
  readonly hosts?: { readonly declared: number; readonly answered: number };
  readonly tests?:
    | { readonly cases: number; readonly passed: number }
    | { readonly failure: LivenessTestFailure };
  readonly baseline?: EvalBaseline;
};

export type LivenessEntryRead =
  | { readonly state: "found"; readonly entry: LivenessEntry }
  | { readonly state: "absent" }
  | { readonly state: "invalid" };

const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;
export const NIMBUS_VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/;
const MAX_HOSTS = 1000;

function invalid(detail: string): RegistryError {
  return new RegistryError("ERR_LIVENESS_INVALID", detail);
}

export function parseLivenessFile(bytes: Uint8Array): LivenessFile {
  if (bytes.byteLength > MAX_LIVENESS_BYTES) {
    throw new RegistryError(
      "ERR_REGISTRY_TOO_LARGE",
      `liveness.json exceeds ${String(MAX_LIVENESS_BYTES)} bytes`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalid("liveness.json is not valid UTF-8");
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid("liveness.json is not valid JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("liveness.json must be an object");
  }
  return readEnvelope(raw as Record<string, unknown>);
}

const REQUIRED_KEYS = [
  "format",
  "livenessKey",
  "sequence",
  "generatedAt",
  "nimbusVersion",
  "extensions",
  "signature",
] as const;

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Strict ISO-8601 UTC only. A looser `Date.parse` accepts parenthesised free text and zone-less
 * stamps, which would let signed text reach an owner-facing surface or make the day depend on the
 * owner's time zone. The round trip refuses a day that does not exist (2026-02-30).
 */
function isIsoUtc(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_UTC_RE.test(v)) return false;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === v.slice(0, 10);
}

function readSequence(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
    throw invalid("sequence must be a positive integer");
  }
  return v;
}

function readPatterned(v: unknown, re: RegExp, detail: string): string {
  if (typeof v !== "string" || !re.test(v)) throw invalid(detail);
  return v;
}

function readEnvelope(o: Record<string, unknown>): LivenessFile {
  for (const k of REQUIRED_KEYS) {
    if (!Object.hasOwn(o, k)) throw invalid(`liveness.json is missing key: ${k}`);
  }
  if (o["format"] !== 1) throw invalid("unsupported liveness format");
  const sequence = readSequence(o["sequence"]);
  const livenessKey = readPatterned(o["livenessKey"], KEY_RE, "livenessKey is malformed");
  const signature = readPatterned(o["signature"], SIGNATURE_RE, "signature is malformed");
  const generatedAt = o["generatedAt"];
  if (!isIsoUtc(generatedAt)) throw invalid("generatedAt is not a timestamp");
  const nimbusVersion = readPatterned(
    o["nimbusVersion"],
    NIMBUS_VERSION_RE,
    "nimbusVersion is malformed",
  );
  return {
    ...o,
    format: 1,
    livenessKey,
    sequence,
    generatedAt,
    nimbusVersion,
    extensions: o["extensions"],
    signature,
  };
}

export function livenessSigningBytes(
  doc: Omit<LivenessFile, "signature"> | LivenessFile,
): Uint8Array {
  const { signature: _omitted, ...rest } = doc as LivenessFile;
  return new TextEncoder().encode(canonicalize(rest)); // NOSONAR S1874
}

/** SHA-256 (hex) of the file's signing bytes: what a client stores to refuse equivocation. */
export function livenessDigest(doc: LivenessFile): string {
  return createHash("sha256").update(livenessSigningBytes(doc)).digest("hex");
}

/** Not `async` and not `Promise.try`: see `verifyRegistryIndexSelf`. */
export function verifyLivenessFile(doc: LivenessFile, indexLivenessKey: string): Promise<void> {
  return new Promise((resolve) => {
    if (doc.livenessKey !== indexLivenessKey) {
      throw new RegistryError(
        "ERR_LIVENESS_KEY_MISMATCH",
        "liveness key differs from the key the index names",
      );
    }
    let ok: boolean;
    try {
      ok = nacl.sign.detached.verify(
        livenessSigningBytes(doc),
        new Uint8Array(Buffer.from(doc.signature, "base64")),
        new Uint8Array(Buffer.from(doc.livenessKey, "base64")),
      );
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new RegistryError(
        "ERR_LIVENESS_SIGNATURE_INVALID",
        "liveness signature does not verify",
      );
    }
    resolve();
  });
}

/** Not `async` and not `Promise.try`: see `signIndex`. */
export function signLivenessFile(
  unsigned: Omit<LivenessFile, "signature">,
  seed: Uint8Array,
): Promise<LivenessFile> {
  return new Promise((resolve) => {
    const { signature: _omitted, ...rest } = unsigned as LivenessFile;
    const sig = sign(null, livenessSigningBytes(rest), privateKeyFromSeed(seed));
    resolve({ ...rest, signature: sig.toString("base64") });
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

function isCount(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function readHosts(raw: unknown): { declared: number; answered: number } {
  if (!isObject(raw) || !onlyKeys(raw, ["declared", "answered"])) throw invalid("hosts");
  const declared = raw["declared"];
  if (!isCount(declared, 1, MAX_HOSTS)) throw invalid("hosts.declared");
  const answered = raw["answered"];
  if (!isCount(answered, 0, declared)) throw invalid("hosts.answered");
  return { declared, answered };
}

function readTests(
  raw: unknown,
): { cases: number; passed: number } | { failure: LivenessTestFailure } {
  if (!isObject(raw)) throw invalid("tests");
  if (Object.hasOwn(raw, "failure")) {
    const failure = raw["failure"];
    if (!onlyKeys(raw, ["failure"])) throw invalid("tests");
    if (!(LIVENESS_TEST_FAILURES as readonly unknown[]).includes(failure)) {
      throw invalid("tests.failure");
    }
    return { failure: failure as LivenessTestFailure };
  }
  if (!onlyKeys(raw, ["cases", "passed"])) throw invalid("tests");
  const cases = raw["cases"];
  if (!isCount(cases, 1, MAX_EVAL_CASES)) throw invalid("tests.cases");
  const passed = raw["passed"];
  if (!isCount(passed, 0, cases)) throw invalid("tests.passed");
  return { cases, passed };
}

function readBaseline(raw: unknown): EvalBaseline {
  try {
    return parseEvalBaseline(raw);
  } catch (e) {
    if (e instanceof RegistryError && e.code === "ERR_REGISTRY_EVAL_QUALITY_INVALID") {
      throw invalid("baseline");
    }
    throw e;
  }
}

/** One entry, strictly. Throws `ERR_LIVENESS_INVALID`; a baseline refusal is rethrown as that code. */
export function parseLivenessEntry(raw: unknown): LivenessEntry {
  if (!isObject(raw) || !onlyKeys(raw, ["checkedAt", "hosts", "tests", "baseline"])) {
    throw invalid("entry");
  }
  const checkedAt = raw["checkedAt"];
  if (!isIsoUtc(checkedAt)) throw invalid("checkedAt");
  const hosts = Object.hasOwn(raw, "hosts") ? readHosts(raw["hosts"]) : undefined;
  const tests = Object.hasOwn(raw, "tests") ? readTests(raw["tests"]) : undefined;
  const baseline = Object.hasOwn(raw, "baseline") ? readBaseline(raw["baseline"]) : undefined;
  if (hosts === undefined && tests === undefined && baseline === undefined) {
    throw invalid("entry carries no result");
  }
  return {
    checkedAt,
    ...(hosts === undefined ? {} : { hosts }),
    ...(tests === undefined ? {} : { tests }),
    ...(baseline === undefined ? {} : { baseline }),
  };
}

/** One version's entry. Never throws: a malformed entry is `invalid`. Signatures are NOT checked here. */
export function readLivenessEntry(
  doc: LivenessFile,
  id: string,
  version: string,
): LivenessEntryRead {
  const map = doc.extensions;
  if (map === undefined) return { state: "absent" };
  if (!isObject(map)) return { state: "invalid" };
  const key = `${id}@${version}`;
  if (!Object.hasOwn(map, key)) return { state: "absent" };
  try {
    return { state: "found", entry: parseLivenessEntry(map[key]) };
  } catch {
    return { state: "invalid" };
  }
}
