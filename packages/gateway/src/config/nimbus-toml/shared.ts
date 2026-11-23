import { existsSync, readFileSync } from "node:fs";
import {
  fallbackMessage,
  layeredConfigText,
  layerReadError,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "../layered-config.ts";
import {
  hasUnterminatedString,
  isTableHeader,
  parseBool,
  parseIntDec,
  splitKeyValue,
  stripComment,
} from "../toml-primitives.ts";

/**
 * The one core of every defaults-on-missing-or-throw section loader. `text === null` means "no
 * file"; a throw from `parse` is reported to `onFallback` and the defaults are returned.
 */
function loadTomlSectionFromText<T>(
  text: string | null,
  fallback: T,
  parse: (raw: string) => T,
  onFallback?: SectionFallbackSink,
): T {
  if (text === null) {
    return structuredClone(fallback);
  }
  try {
    return parse(text);
  } catch (err) {
    onFallback?.(fallbackMessage(err));
    return structuredClone(fallback);
  }
}

/** Single-file reader: one file on disk, no layering. A read error falls back like a parse error. */
export function loadTomlSection<T>(tomlPath: string, fallback: T, parse: (raw: string) => T): T {
  let text: string | null;
  try {
    text = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : null;
  } catch {
    return structuredClone(fallback);
  }
  return loadTomlSectionFromText(text, fallback, parse);
}

/**
 * Config-dir reader over the layered snapshot (packs, base, active profile). Same semantics as
 * `loadTomlSection` for the same text, and a swallowed parse error is recorded as the section's
 * fallback so `config explain` can report it. A layer that exists but cannot be read falls back
 * to the defaults, as `loadTomlSection`'s read error did, recorded with the file it names.
 */
export function loadTomlSectionFromConfig<T>(
  configDir: string,
  sectionId: string,
  fallback: T,
  parse: (raw: string) => T,
): T {
  const readError = layerReadError(configDir);
  if (readError !== undefined) {
    sectionFallbackSink(configDir, sectionId)(readError);
    return structuredClone(fallback);
  }
  return loadTomlSectionFromText(
    layeredConfigText(configDir),
    fallback,
    parse,
    sectionFallbackSink(configDir, sectionId),
  );
}

/**
 * Assign a boolean key when — and only when — the raw value actually parses as one.
 *
 * The whole file's contract for a malformed value is "leave the field UNSET so the default
 * survives", never "coerce to false"; written once here so the ~30 boolean keys in this file
 * cannot each re-derive it and one of them get it wrong.
 */
export function assignBool(valRaw: string, assign: (b: boolean) => void): void {
  const b = parseBool(valRaw);
  if (b !== undefined) assign(b);
}

/**
 * Assign an integer key when it parses AND lands inside `[min, max]` (both inclusive).
 *
 * Out-of-range is REJECTED, not clamped: clamping leaves the running config silently disagreeing
 * with what the file says, which is the harder of the two failures to diagnose.
 */
export function assignBoundedInt(
  valRaw: string,
  bounds: { readonly min: number; readonly max: number },
  assign: (n: number) => void,
): void {
  const n = parseIntDec(valRaw);
  if (n !== undefined && n >= bounds.min && n <= bounds.max) assign(n);
}

/**
 * `enabled` — the one toggle EVERY pass section has.
 *
 * Split from `applyPassSectionToggle` below rather than folded into it, because a section that
 * does not declare `use_llm` must not have one INVENTED for it: `out` here is a
 * `Partial<Nimbus…Toml>` that gets spread over the defaults, so writing a field the type does not
 * carry puts a key in the returned config that nothing reads and every equality assertion sees.
 * `[ownership]` is that section.
 */
export function applyEnabledToggle(
  out: { enabled?: boolean },
  key: string,
  valRaw: string,
): boolean {
  if (key !== "enabled") return false;
  assignBool(valRaw, (b) => {
    out.enabled = b;
  });
  return true;
}

/**
 * The `enabled` / `use_llm` prelude shared by the three LLM-backed pass sections — `[glossary]`,
 * `[decisions]` and `[premortem]`.
 *
 * It MUST run before each section's integer branch, and that ordering is precisely why it is one
 * function rather than three copies: routed through `parseIntDec`, `use_llm` is silently dropped
 * and the section reads as if it were never set.
 *
 * Returns true when the key was one of the two and has been HANDLED — including when the value
 * was malformed and deliberately left unset, which is still handled and must not fall through to
 * a numeric parse.
 */
export function applyPassSectionToggle(
  out: { enabled?: boolean; useLlm?: boolean },
  key: string,
  valRaw: string,
): boolean {
  if (applyEnabledToggle(out, key, valRaw)) return true;
  if (key !== "use_llm") return false;
  assignBool(valRaw, (b) => {
    out.useLlm = b;
  });
  return true;
}

export function forEachSectionEntry(
  source: string,
  sectionHeader: string,
  onEntry: (key: string, valRaw: string) => void,
): void {
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    // A line whose quoted value never closes is malformed. Skipping beats
    // acting on the mangled value the old parser produced (a leading `"` plus
    // a truncated fragment) — no value is better than a wrong one.
    if (hasUnterminatedString(line)) {
      continue;
    }
    if (trimmed === "") {
      continue;
    }
    if (isTableHeader(trimmed)) {
      inSection = trimmed === sectionHeader;
      continue;
    }
    if (!inSection) {
      continue;
    }
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) {
      onEntry(kv.key, kv.valRaw);
    }
  }
}

/**
 * Opens a sub-table for {@link collectSubTableKv}: given a VALID `[...]` header line, returns the id
 * whose bucket the `key = value` lines below it belong to, creating that bucket in `accum`; or
 * `undefined` when the header names a different table, or this one with an unusable id — the lines
 * below it are then dropped.
 */
type BeginSubTable = (
  accum: Map<string, Record<string, string>>,
  trimmed: string,
) => string | undefined;

/**
 * Accumulates raw kv strings per `[<section>.<id>]` sub-table: `[llm.local.*]`, `[llm.remote.*]`,
 * `[hitl.quorum."*"]` and `[federation.preflight."*"]`.
 *
 * `beginTable` — which header opens which id — is the ONLY difference between those sections, so
 * they share this one scanner and its header reset below. That reset was once fixed in the
 * `[llm.*]` copy alone, and the `[hitl.quorum]` and `[federation.preflight]` copies kept the bug it
 * fixes: under a quorum header missing its `]`, `approvers = 1` replaced the PREVIOUS action type's
 * approver count (I21), and under a preflight one, `command` replaced the previous namespace's
 * command (I24).
 */
export function collectSubTableKv(
  source: string,
  beginTable: BeginSubTable,
): Map<string, Record<string, string>> {
  const accum = new Map<string, Record<string, string>>();
  let currentId: string | undefined;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    const unterminated = hasUnterminatedString(line);
    // Header-LIKE, not header-VALID: a line that opens with `[` is a table header the writer
    // meant, whether or not it closes. Ending the current block on the OPENING bracket — before
    // `isTableHeader` gets to reject `[llm.local.bad` for its missing `]` — is what makes a
    // malformed header end the previous table instead of leaking into it. Without the reset,
    // `currentId` stayed on the last VALID id, so every line under the malformed header was
    // written into the PREVIOUS table's bucket: `[llm.local.good]` followed by `[llm.local.bad`
    // silently became `good` carrying `bad`'s runtime and model.
    //
    // A header whose quote never closes (`[hitl.quorum."x]`) is malformed the same way, which is
    // why this test runs BEFORE the unterminated-string skip below: skipped there, that header
    // reset nothing and its keys leaked into the previous table exactly as above. It ends the
    // previous table and opens none.
    if (trimmed.startsWith("[")) {
      currentId = isTableHeader(trimmed) && !unterminated ? beginTable(accum, trimmed) : undefined;
      continue;
    }
    // A key line whose quoted value never closes is malformed. Skipping beats acting on the
    // mangled value the old parser produced (a leading `"` plus a truncated fragment) — no value
    // is better than a wrong one.
    if (unterminated) continue;
    if (currentId === undefined) continue;
    applyKvLine(accum.get(currentId), trimmed);
  }

  return accum;
}

/**
 * Records a `key = value` line into the current sub-table's bucket, if any.
 *
 * ONE definition for every `[<section>.<id>]` sub-table parser in this file — `[llm.local.*]`,
 * `[hitl.quorum."*"]` and the rest all accumulate raw kv strings identically, and a second copy of
 * these four lines is a second place for "a line outside any table is DROPPED, never misfiled into
 * the previous table" to drift.
 */
function applyKvLine(bucket: Record<string, string> | undefined, trimmed: string): void {
  if (bucket === undefined) return;
  const kv = splitKeyValue(trimmed);
  if (kv !== undefined) bucket[kv.key] = kv.valRaw;
}

/**
 * If `trimmed` is a `<prefix><id>"]` header with a non-empty id — `prefix` being
 * `[hitl.quorum."` or `[federation.preflight."` — ensures a bucket exists in `accum` and returns
 * the id; otherwise returns undefined.
 */
export function beginQuotedIdTable(
  accum: Map<string, Record<string, string>>,
  trimmed: string,
  prefix: string,
): string | undefined {
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith('"]')) return undefined;
  const id = trimmed.slice(prefix.length, -2);
  if (id.length === 0) return undefined;
  if (!accum.has(id)) accum.set(id, {});
  return id;
}

/** Parse an integer kv value with a minimum floor; returns undefined when absent/non-numeric/below `min`. */
export function parseIntWithMin(valRaw: string, min: number): number | undefined {
  const n = parseIntDec(valRaw);
  return n !== undefined && n >= min ? n : undefined;
}
