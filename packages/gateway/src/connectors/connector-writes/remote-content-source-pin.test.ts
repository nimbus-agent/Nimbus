import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  regexLiteralEnd,
  startsRegexLiteral,
  stripComments,
  stripStringLiterals,
} from "../../../../../scripts/structure-audit/lib.ts";

// Moved out of markup-tokens.test.ts (file-size gate): the source pin of the B3r detector files.

// ---------------------------------------------------------------------------------------------
// Source pin (plan Global Constraints; CodeQL js/incomplete-multi-character-sanitization and
// js/bad-tag-filter): the B3r detector files never strip or replace, and no regex in them matches
// a tag. Their comment-stripped source has no `.replace(` / `.replaceAll(` call, no runtime
// `RegExp(` construction (which could hide a `<` in a string), and no regex literal containing `<`.
// The detectors are split by format into remote-content/, and every file there is pinned.
// ---------------------------------------------------------------------------------------------
const SPLIT = readdirSync(join(import.meta.dir, "remote-content")).filter((f) => f.endsWith(".ts"));
const PINNED_FILES: string[] = [
  "markup-tokens.ts",
  "remote-content.ts",
  ...SPLIT.sort().map((f) => `remote-content/${f}`),
];

/**
 * `text-normalise.ts` (the shared normalisation the detectors read) is pinned too (final review
 * item 5), with an explicit allowlist: these two lines build MATCHING COPIES (the entity decode
 * and the whitespace collapse), never text that is sent, shown or written back. No other replace
 * call may appear there.
 */
const TEXT_NORMALISE_MATCHING_COPIES: readonly string[] = [
  "return s.replace(ENTITY, (m: string, hex?: string, dec?: string, name?: string) => {",
  String.raw`return (keepLines ? cur : cur.replaceAll(/\s+/g, " ")).toLowerCase();`,
];

/** The trimmed lines of comment-free `src` that call `.replace(` or `.replaceAll(` (strings skipped). */
function replaceCallLines(src: string): string[] {
  const code = stripComments(src);
  const blanked = stripStringLiterals(code).split("\n");
  const lines = code.split("\n");
  const out: string[] = [];
  blanked.forEach((b, i) => {
    if (/\.replace(?:All)?\s*\(/.test(b)) out.push((lines[i] ?? "").trim());
  });
  return out;
}

/**
 * Every regex literal of comment-free `code`. A `/` that `stripStringLiterals` blanked is inside a
 * string and skipped; the literal itself is read from `code` (that helper blanks regex bodies).
 */
function regexLiterals(code: string): string[] {
  const blanked = stripStringLiterals(code);
  const out: string[] = [];
  for (let i = 0; i < code.length; i++) {
    if (blanked[i] !== "/" || !startsRegexLiteral(code, i)) continue;
    const end = regexLiteralEnd(code, i);
    if (end === null) continue;
    out.push(code.slice(i, end));
    i = end - 1;
  }
  return out;
}

/** The pin's violations in one source text. */
function pinViolations(src: string): string[] {
  const code = stripComments(src);
  const calls = stripStringLiterals(code);
  const out: string[] = [];
  if (/\.replace(?:All)?\s*\(/.test(calls)) out.push("replace call");
  if (/\bRegExp\s*\(/.test(calls)) out.push("RegExp construction");
  for (const re of regexLiterals(code)) if (regexCanMatchLt(re)) out.push(`regex ${re}`);
  return out;
}

/** Whether `atom`, compiled alone with `flags`, matches `<` (a throw counts as yes: fail closed). */
function atomMatchesLt(atom: string, flags: string): boolean {
  try {
    return new RegExp(
      `^(?:${atom})$`,
      flags
        .split("")
        .filter((f) => f !== "g" && f !== "y")
        .join(""),
    ).test("<");
  } catch {
    return true;
  }
}

/** The escape atom starting at the `\` at `i` of a regex body (`\x3c`, `<`, `\u{3c}`, `\074`). */
function escapeAtom(body: string, i: number): string {
  const next = body.charAt(i + 1);
  const braced = body.charAt(i + 2) === "{";
  if ((next === "u" || next === "p" || next === "P") && braced) {
    const close = body.indexOf("}", i + 3);
    return body.slice(i, close === -1 ? body.length : close + 1);
  }
  if (next === "x") return body.slice(i, i + 4);
  if (next === "u") return body.slice(i, i + 6);
  if (next === "c") return body.slice(i, i + 3);
  if (/[0-9]/.test(next)) {
    let j = i + 1;
    while (/[0-9]/.test(body.charAt(j))) j++;
    return body.slice(i, j);
  }
  return body.slice(i, i + 2);
}

/** The character class starting at the `[` at `i` of a regex body, brackets included. */
function classAtom(body: string, i: number): string {
  let j = i + 1;
  if (body.charAt(j) === "^") j++;
  if (body.charAt(j) === "]") j++;
  while (j < body.length && body.charAt(j) !== "]") j += body.charAt(j) === "\\" ? 2 : 1;
  return body.slice(i, j + 1);
}

/**
 * Whether a regex literal can match `<` anywhere (the source pin, closed after the adversarial
 * review found `\x3c` slipped past a literal-`<` check): a literal `<` (which also catches the
 * `(?<` lookbehind and named-group syntax), an escape that names it (`\x3c`, `<`, `\u{3c}`,
 * octal `\074`), a named backreference `\k<...>`, a `.` or `\W`/`\S`/`\D`, or a character class
 * that contains it (a range across U+003C, or a negated class). Each escape and class is compiled
 * on its own and tested against `<`.
 */
function regexCanMatchLt(literal: string): boolean {
  const close = literal.lastIndexOf("/");
  const body = literal.slice(1, close);
  const flags = literal.slice(close + 1);
  let i = 0;
  while (i < body.length) {
    const ch = body.charAt(i);
    let atom = ch;
    if (ch === "\\") {
      if (body.charAt(i + 1) === "k") return true;
      atom = escapeAtom(body, i);
    } else if (ch === "[") {
      atom = classAtom(body, i);
    } else if (ch === "<") {
      return true;
    } else if (ch !== ".") {
      i++;
      continue;
    }
    if (atomMatchesLt(atom, flags)) return true;
    i += atom.length;
  }
  return false;
}

describe("source pin: the remote-content files never strip, replace or match a tag", () => {
  test.each(PINNED_FILES)("%s", (file) => {
    const src = readFileSync(join(import.meta.dir, file), "utf8");
    expect(pinViolations(src)).toEqual([]);
  });

  test("text-normalise.ts: no RegExp construction or `<`-matching regex, and its ONLY replace calls are the two matching-copy lines", () => {
    const src = readFileSync(join(import.meta.dir, "text-normalise.ts"), "utf8");
    expect(pinViolations(src).filter((v) => v !== "replace call")).toEqual([]);
    expect(replaceCallLines(src)).toEqual([...TEXT_NORMALISE_MATCHING_COPIES]);
  });

  test("guard: the replace-call lister sees every call, one line each", () => {
    expect(
      replaceCallLines(
        `const a = s.replace(x, y);\n// t.replace(z)\nconst b = "u.replace(";\nconst c = v.replaceAll (w, q);`,
      ),
    ).toEqual(["const a = s.replace(x, y);", "const c = v.replaceAll (w, q);"]);
  });

  test("the pin's matcher fails mutated snippets and passes clean ones", () => {
    expect(pinViolations(`const a = s.replace(/x/g, "");`)).toEqual(["replace call"]);
    expect(pinViolations("const a = s.replaceAll ( 'x', '' );")).toEqual(["replace call"]);
    expect(pinViolations(`const r = new RegExp("<img");`)).toEqual(["RegExp construction"]);
    expect(pinViolations("const r = /<img/i;")).toEqual(["regex /<img/i"]);
    expect(pinViolations("if (x) return /a[<]b/.test(s);")).toEqual(["regex /a[<]b/"]);
    // Every other way a regex literal can match `<` (adversarial review).
    for (const re of [
      String.raw`/\x3c/`,
      String.raw`/\x3Cimg/i`,
      "/</",
      String.raw`/\u{3c}/u`,
      String.raw`/\u{0003C}/u`,
      String.raw`/\074/`,
      String.raw`/\74img/`,
      "/[;-=]/",
      String.raw`/[\x3b-\x3d]/`,
      "/[^a]/",
      "/a.b/",
      String.raw`/\W/`,
      String.raw`/\S/`,
      String.raw`/\D/`,
      String.raw`/\P{L}/u`,
      "/(?<=a)b/",
      String.raw`/(?<n>a)\k<n>/`,
    ]) {
      expect(pinViolations(`const r = ${re};`)).toEqual([`regex ${re}`]);
    }
    for (const re of [
      String.raw`/url\(/`,
      "/[a-z0-9+.-]/",
      String.raw`/\s*=\s*(?:["'\x60]\s*)?/`,
      String.raw`/[\\/][\\/]/`,
      "/^[0-9a-f]$/i",
      String.raw`/\p{L}/u`,
      String.raw`/\x3d/`,
    ]) {
      expect(pinViolations(`const r = ${re};`)).toEqual([]);
    }
    // Clean: a `<` comparison, a `<` in a string, and a mention in a comment.
    expect(
      pinViolations(`// s.replace(/<a/)\nconst a = b < c; const t = "<p>"; const r = /url\\(/;`),
    ).toEqual([]);
  });
});
