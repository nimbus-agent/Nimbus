import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeTerm } from "../glossary/term-normalize.ts";
import {
  hasUnterminatedString,
  isTableHeader,
  parseString,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/** One authored term. `termKey` is normalized; `displayTerm` is as written. */
export type ManualTerm = { termKey: string; displayTerm: string; definition: string };

/** A rejected config entry, reported to the user by `--refresh` (spec §8). */
export type ManualSkip = { entry: string; reason: string };

/**
 * `loaded: false` means the config could NOT be read — never "there are no
 * authored terms".
 *
 * This distinction is the whole reason the module does not use
 * `loadTomlSection`, which catches every error and returns defaults. Under the
 * desired-state semantics of `glossary-manual.ts`, an unreadable file
 * interpreted as an empty config would delete every authored term on the
 * machine. The removal half of the pre-pass therefore runs only on
 * `loaded: true`.
 */
export type GlossaryManualConfig =
  | { loaded: false }
  | {
      loaded: true;
      terms: ManualTerm[];
      /** Normalized alias -> the `termKey` it resolves to. */
      synonyms: Map<string, string>;
      skipped: ManualSkip[];
    };

const GLOSSARY_HEADER = "[glossary]";
const TERMS_HEADER = "[glossary.terms]";
const SYNONYMS_HEADER = "[glossary.synonyms]";

type RawEntry = { key: string; value: string };

/**
 * Collects the raw entries of both blocks in one pass.
 *
 * A dedicated loop rather than `forEachSectionEntry` because this parser must
 * report WHY an entry was rejected, and that helper deliberately discards the
 * distinction between "no `=` on the line" and "not in this section".
 *
 * `misplaced` catches the one *valid TOML* shape this line parser cannot see:
 * a dotted key under the parent table (`[glossary]` + `terms.CDR = "…"`).
 * Full TOML compliance is out of scope — the parser is deliberately
 * dependency-free — but silently ignoring a correctly-written term is the
 * silent-failure class this whole slice exists to remove, so it is reported
 * through the same `skipped` channel as any other rejected entry.
 */
function collectBlocks(raw: string): {
  terms: RawEntry[];
  synonyms: RawEntry[];
  misplaced: ManualSkip[];
} {
  const terms: RawEntry[] = [];
  const synonyms: RawEntry[] = [];
  const misplaced: ManualSkip[] = [];
  let target: RawEntry[] | null = null;
  let inGlossaryRoot = false;

  for (const line of raw.split(/\r?\n/)) {
    if (hasUnterminatedString(line)) continue;
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inGlossaryRoot = trimmed === GLOSSARY_HEADER;
      if (trimmed === TERMS_HEADER) target = terms;
      else if (trimmed === SYNONYMS_HEADER) target = synonyms;
      else target = null;
      continue;
    }
    if (inGlossaryRoot) {
      const kv = splitKeyValue(trimmed);
      const key = kv?.key.trim() ?? "";
      if (key.startsWith("terms.") || key.startsWith("synonyms.")) {
        misplaced.push({
          entry: key,
          reason:
            "dotted keys under [glossary] are not read — move it under [glossary.terms] " +
            "or [glossary.synonyms]",
        });
      }
      continue;
    }
    if (target === null) continue;
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) {
      target.push({ key: parseString(kv.key), value: parseString(kv.valRaw) });
    }
  }
  return { terms, synonyms, misplaced };
}

function buildTerms(raw: RawEntry[], skipped: ManualSkip[]): ManualTerm[] {
  const byKey = new Map<string, ManualTerm>();
  for (const { key, value } of raw) {
    const termKey = normalizeTerm(key);
    if (termKey === "") {
      skipped.push({ entry: key, reason: "key normalizes to nothing" });
      continue;
    }
    if (value.trim() === "") {
      skipped.push({ entry: key, reason: "empty definition" });
      continue;
    }
    if (byKey.has(termKey)) {
      // Two DIFFERENT raw keys normalizing to one term_key ("CDR" and "Cdr")
      // is last-wins like any duplicate, but unlike a literal duplicate it is
      // almost certainly a mistake, so it is reported.
      skipped.push({ entry: key, reason: `duplicate of an earlier entry for "${termKey}"` });
    }
    byKey.set(termKey, { termKey, displayTerm: key, definition: value.trim() });
  }
  return [...byKey.values()];
}

function buildSynonyms(
  raw: RawEntry[],
  terms: readonly ManualTerm[],
  skipped: ManualSkip[],
): Map<string, string> {
  const authored = new Set(terms.map((t) => t.termKey));
  const out = new Map<string, string>();
  for (const { key, value } of raw) {
    const alias = normalizeTerm(key);
    const target = normalizeTerm(value);
    if (alias === "" || target === "") {
      skipped.push({ entry: key, reason: "alias or target normalizes to nothing" });
      continue;
    }
    if (authored.has(alias)) {
      skipped.push({ entry: key, reason: "alias is itself an authored term" });
      continue;
    }
    if (!authored.has(target)) {
      // Aliases resolve only to AUTHORED terms in this slice. Pointing one at
      // a mined term would pull a mined row into the desired-state
      // reconciliation, which is a separate decision (spec §4).
      skipped.push({ entry: key, reason: `no authored term "${value}" to alias` });
      continue;
    }
    if (out.has(alias)) {
      // Last-wins, matching `buildTerms` and every other section of this
      // parser — but reported, because two aliases for the same phrase
      // pointing at different terms is a mistake, not an override.
      skipped.push({ entry: key, reason: `duplicate alias definition for "${key}"` });
    }
    out.set(alias, target);
  }
  return out;
}

export function parseGlossaryManualToml(raw: string): GlossaryManualConfig {
  const blocks = collectBlocks(raw);
  const skipped: ManualSkip[] = [...blocks.misplaced];
  const terms = buildTerms(blocks.terms, skipped);
  const synonyms = buildSynonyms(blocks.synonyms, terms, skipped);
  return { loaded: true, terms, synonyms, skipped };
}

/**
 * Reads `<configDir>/nimbus.toml`.
 *
 * Deliberately NOT built on `loadTomlSection`: every failure must surface as
 * `loaded: false` rather than as an empty-but-valid config. See the
 * `GlossaryManualConfig` docstring.
 */
export function loadGlossaryManualFromConfigDir(configDir: string): GlossaryManualConfig {
  const tomlPath = join(configDir, "nimbus.toml");
  if (!existsSync(tomlPath)) return { loaded: false };
  try {
    return parseGlossaryManualToml(readFileSync(tomlPath, "utf8"));
  } catch {
    return { loaded: false };
  }
}
