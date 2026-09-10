import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyArtifactSignature } from "./toolgen-keypair.ts";
import type { SavedToolDisabledReason } from "./toolgen-saved-repo.ts";
import { validateInputSchema } from "./toolgen-schema.ts";
import { assertSafeToolId } from "./toolgen-script-store.ts";
import type { PortableToolManifest, ToolInputSchema } from "./toolgen-types.ts";

/**
 * The `saved/<toolId>` directory (spec § 3) — a generated tool bound by an Ed25519 signature to
 * the exact bytes its owner approved, so it survives a gateway restart.
 *
 * **D29(d): there is no unverified read accessor for a saved artifact.** `readVerifiedSavedTool`
 * below is the ONLY function in this codebase permitted to hand a saved tool's body or artifact
 * fields to a caller, and it verifies the Ed25519 signature before it returns anything. Adding a
 * second accessor — a "just peek at the JSON" helper, a debug dump, a fast path that skips
 * verification because "the row already says healthy" — defeats the entire design: the row is a
 * cache of a past approval (`toolgen-saved-repo.ts`'s docstring), never the current truth, and only
 * a signature check performed on THIS read tells you the bytes on disk today are still the bytes
 * that were approved. If you are tempted to read `artifact.json` directly anywhere else in this
 * codebase, route through this module instead — that is the whole point of it existing.
 *
 * Three files per tool, written in this exact order and never any other:
 *
 *   saved/<toolId>/
 *     index.ts        # the approved body, 0o600 — DERIVED, re-emitted at spawn, never signed
 *     artifact.json    # the canonical artifact bytes, VERBATIM — this is what gets signed
 *     artifact.sig     # base64 Ed25519 signature over artifact.json's exact bytes, written LAST
 *
 * `artifact.sig` is written last on purpose: a crash mid-write then leaves a directory with no
 * signature (or a stale/absent artifact.json), which `readVerifiedSavedTool` reports as
 * `signature_missing` / `artifact_missing` rather than a directory that looks fully written but
 * whose signature was never actually attached.
 *
 * `index.ts` is never read, hashed or validated by this module. It cannot be — it is not part of
 * `canonicalArtifactBytes` and is re-emitted from the VERIFIED `artifact.body` at spawn time
 * (`rewriteSavedToolScript`, called by a later task), so tampering with it on disk is irrelevant
 * rather than detected: the approved bytes overwrite it before the tool ever executes.
 *
 * `readVerifiedSavedTool` reads `artifact.json` as bytes, decodes it as UTF-8, and verifies the
 * signature over that EXACT string. It never re-canonicalises: re-deriving the bytes from a parsed
 * object and verifying against the re-derivation would mean checking a signature against a string
 * other than the one that was actually signed, silently reintroducing the very bug class this
 * design exists to remove (a re-serialisation that differs in whitespace, key order, or a future
 * `canonicalize` change would then present as "not tampered" or "tampered" for reasons that have
 * nothing to do with the bytes on disk).
 */

const STORE_DIR = "toolgen";
const SAVED_DIR = "saved";
const SCRIPT_FILE = "index.ts";
const ARTIFACT_FILE = "artifact.json";
const SIG_FILE = "artifact.sig";

/** The fields a saved artifact must carry, narrowed from untrusted on-disk JSON. */
export interface SavedArtifactFields {
  readonly toolId: string;
  readonly toolName: string;
  readonly description: string;
  readonly body: string;
  readonly approvedHosts: readonly string[];
  readonly credentialHosts: readonly string[];
  readonly inputSchema: ToolInputSchema;
  readonly manifest: PortableToolManifest;
}

/**
 * Where a saved tool's three files live (spec § 3). PURE — derivable without touching the
 * filesystem, mirroring `toolScriptDir`'s shape in the ephemeral store.
 */
export function savedToolDir(configDir: string, toolId: string): string {
  assertSafeToolId(toolId);
  return join(configDir, STORE_DIR, SAVED_DIR, toolId);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * The portable manifest fields (`toolgen-portable-manifest.ts`'s signable projection) narrowed
 * from untrusted JSON — same shape discipline as the rest of this file: every field checked by
 * type, nothing coerced, nothing asserted.
 */
function parsePortableManifest(raw: unknown): PortableToolManifest | null {
  const m = asRecord(raw);
  if (m === null) return null;
  const { id, version, updateChannel, network, filesystemWrite } = m;
  if (typeof id !== "string" || typeof version !== "string" || typeof updateChannel !== "string") {
    return null;
  }
  if (!isStringArray(network) || !isStringArray(filesystemWrite)) return null;
  return { id, version, updateChannel, network, filesystemWrite };
}

/**
 * Narrow untrusted on-disk JSON into `SavedArtifactFields`, or `null` if it does not have the
 * shape this build requires. A REAL guard, field by field — never a type assertion over
 * `JSON.parse`'s result, which is `unknown` because it is external data (project rule: no `any`).
 *
 * This is the "verifies fine, but wrong shape" half of the two-part failure this store
 * distinguishes: a signature proves the bytes were not altered after approval, never that they
 * describe something this build of Nimbus can load. An artifact written by a different build can
 * verify perfectly here and still come back `null` — that is `schema_invalid`, not
 * `signature_mismatch`, in `readVerifiedSavedTool` below.
 *
 * `inputSchema` reuses `toolgen-schema.ts`'s `validateInputSchema` — the same guard the draft path
 * already applies to a model-authored schema — rather than a second, drifting copy of the same
 * rules. It throws on an invalid shape; caught here and folded into this function's `null` return.
 */
export function parseCanonicalArtifact(json: string): SavedArtifactFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const r = asRecord(parsed);
  if (r === null) return null;

  const {
    toolId,
    toolName,
    description,
    body,
    approvedHosts,
    credentialHosts,
    inputSchema,
    manifest,
  } = r;
  if (
    typeof toolId !== "string" ||
    typeof toolName !== "string" ||
    typeof description !== "string" ||
    typeof body !== "string"
  ) {
    return null;
  }
  if (!isStringArray(approvedHosts) || !isStringArray(credentialHosts)) return null;

  let schema: ToolInputSchema;
  try {
    schema = validateInputSchema(inputSchema);
  } catch {
    return null;
  }

  const portableManifest = parsePortableManifest(manifest);
  if (portableManifest === null) return null;

  return {
    toolId,
    toolName,
    description,
    body,
    approvedHosts,
    credentialHosts,
    inputSchema: schema,
    manifest: portableManifest,
  };
}

/**
 * Persist a newly-approved tool to `saved/<toolId>` (spec § 3). Owner-only (`0o700` directory,
 * `0o600` files) — on Windows these modes are advisory only, per `toolgen-script-store.ts`'s
 * docstring: Node emulates a subset of the POSIX mode bits and the OS does not enforce them, so
 * the real control there is the directory ACL, not the mode.
 *
 * `artifact.sig` is written LAST, deliberately — see the file-level docstring.
 */
export async function writeSavedTool(
  configDir: string,
  toolId: string,
  input: { readonly canonicalJson: string; readonly sigB64: string; readonly script: string },
): Promise<void> {
  const dir = savedToolDir(configDir, toolId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, SCRIPT_FILE), input.script, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(dir, ARTIFACT_FILE), input.canonicalJson, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(dir, SIG_FILE), input.sigB64, { encoding: "utf8", mode: 0o600 });
}

/**
 * The ONLY accessor for a saved tool's body/artifact — see D29(d) in the file-level docstring.
 *
 * Order of checks, and why it is this order:
 *
 * 1. `artifact.json` unreadable → `artifact_missing`.
 * 2. `artifact.sig` unreadable → `signature_missing`, distinct from a mismatch: no signature was
 *    ever attached, as opposed to one that was attached and no longer verifies.
 * 3. Signature does not verify over the bytes read in step 1, EXACTLY as read (never
 *    re-canonicalised) → `signature_mismatch`. This is deliberately returned even when the true
 *    cause is a Vault key rotation rather than tampering — cryptography cannot tell those apart,
 *    and only a caller holding the row's stored `pubkey` can (Task 8 upgrades this to
 *    `pubkey_rotated` when it knows the row's pubkey differs from the Vault's current one).
 * 4. Signature verifies, but the bytes do not parse into this build's expected shape →
 *    `schema_invalid`. A signature proves integrity, not shape.
 *
 * `index.ts` is never touched by this function — see the file-level docstring.
 */
export async function readVerifiedSavedTool(
  configDir: string,
  toolId: string,
  pubkeyB64: string,
): Promise<
  | { readonly ok: true; readonly canonicalJson: string; readonly artifact: SavedArtifactFields }
  | { readonly ok: false; readonly reason: SavedToolDisabledReason }
> {
  const dir = savedToolDir(configDir, toolId);

  let canonicalJson: string;
  try {
    canonicalJson = await readFile(join(dir, ARTIFACT_FILE), "utf8");
  } catch {
    return { ok: false, reason: "artifact_missing" };
  }

  let sigB64: string;
  try {
    sigB64 = await readFile(join(dir, SIG_FILE), "utf8");
  } catch {
    return { ok: false, reason: "signature_missing" };
  }

  if (!verifyArtifactSignature(canonicalJson, sigB64, pubkeyB64)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  const artifact = parseCanonicalArtifact(canonicalJson);
  if (artifact === null) {
    return { ok: false, reason: "schema_invalid" };
  }

  return { ok: true, canonicalJson, artifact };
}

/** Idempotent: revoking/removing a tool that was never saved (or already removed) must not throw. */
export async function removeSavedTool(configDir: string, toolId: string): Promise<void> {
  await rm(savedToolDir(configDir, toolId), { recursive: true, force: true });
}

/**
 * Directory NAMES only (not paths) under `saved/`, for the boot-time orphan sweep (spec § 7.1) —
 * the caller joins them itself. Best-effort: an unreadable or absent `saved/` directory (nothing
 * has ever been persisted) reports no entries rather than throwing.
 *
 * Filtered to `isDirectory()` entries — a stray FILE under `saved/` (macOS Finder drops a
 * `.DS_Store` into any directory it has viewed; nothing else writes into `saved/` today, but that
 * is exactly why this cannot be assumed) must not reach a caller that treats every name as a tool
 * id. Task 8's orphan sweep feeds each name straight into `removeSavedTool`, whose
 * `assertSafeToolId` regex (`^[A-Za-z0-9_-]{1,64}$`) rejects a dot and throws — so an unfiltered
 * `.DS_Store` would crash boot reconciliation on macOS only, never on Windows/Linux, which is
 * precisely the kind of platform inequality this codebase treats as a non-negotiable.
 */
export async function listSavedToolDirs(configDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(configDir, STORE_DIR, SAVED_DIR), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Re-emit the derived `index.ts` from a VERIFIED artifact's body at spawn time (spec § 7). Never
 * called with unverified content — the caller must have obtained `body` from
 * `readVerifiedSavedTool`'s `artifact.body`, not from any other source.
 */
export async function rewriteSavedToolScript(
  configDir: string,
  toolId: string,
  script: string,
): Promise<string> {
  const dir = savedToolDir(configDir, toolId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, SCRIPT_FILE);
  await writeFile(file, script, { encoding: "utf8", mode: 0o600 });
  return file;
}
