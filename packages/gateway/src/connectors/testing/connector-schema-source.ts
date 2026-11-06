// Test support: reading a connector tool's input-schema keys out of the installed
// `@nimbus-dev/connectors` source as TEXT (it is never imported). Shared by
// `connector-writes/manifest.sync.test.ts` (a template key must be a declared key) and
// `connector-writes/c1-templates.test.ts` (a template's keys must EQUAL the declared set).
import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import type { PackageSource } from "./connector-write-registrations.ts";

/**
 * The text of `const <name> = ...;` in `code`, ended at the first `;` outside brackets, or
 * `undefined` when `code` declares no such const.
 */
export function constStatement(code: string, name: string): string | undefined {
  const m = new RegExp(String.raw`\bconst\s+${name}\s*=`).exec(code);
  if (m === null) return undefined;
  let depth = 0;
  for (let i = m.index; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth === 0) return code.slice(m.index, i + 1);
  }
  return code.slice(m.index);
}

/** The top-level arguments of a call's `( ... )` text, split outside strings and brackets. */
export function topLevelArgs(call: string): string[] {
  const inner = call.slice(1, -1);
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote !== undefined) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out;
}

/** An argument (or const right-hand side) that names a schema: `X` or `X.extend(...)`. */
const SCHEMA_REF = /^([A-Za-z_$][\w$]*)\s*(?:\.extend\s*\(|$)/;

/** A const statement whose value is a zod schema: `z.<...>` or `<const>.extend(...)`. */
function schemaConstBase(statement: string): { readonly base?: string } | undefined {
  const rhs = statement.slice(statement.indexOf("=") + 1).trim();
  if (/^z\s*\./.test(rhs)) return {};
  const m = /^([A-Za-z_$][\w$]*)\s*\.extend\s*\(/.exec(rhs);
  return m?.[1] === undefined ? undefined : { base: m[1] };
}

/** The shared mail kit, whose `emailToolSchemas` the draft and send tools pass by member (B3). */
const SHARED_EMAIL_KIT = "shared/imap-tool-kit.ts";

/**
 * An argument `emailToolSchemas.<member>`: the declaration of `<member>` in the shared mail kit,
 * when that file's `emailToolSchemas` const names it. Only that one shared object is followed.
 */
function sharedEmailSchemaDeclaration(
  sources: readonly PackageSource[],
  arg: string,
): string | undefined {
  const m = /^emailToolSchemas\.([A-Za-z_$][\w$]*)$/.exec(arg);
  const member = m?.[1];
  if (member === undefined) return undefined;
  const kit = stripComments(sources.find((s) => s.rel === SHARED_EMAIL_KIT)?.text ?? "");
  const table = constStatement(kit, "emailToolSchemas") ?? "";
  if (!new RegExp(String.raw`\b${member}\b`).test(table)) return undefined;
  const statement = constStatement(kit, member);
  return statement !== undefined && schemaConstBase(statement) !== undefined
    ? statement
    : undefined;
}

/**
 * `call` plus the declaration of the local schema const it passes as an argument (`schema` or
 * `schema.extend({...})`) and that const's `.extend(` base chain, plus one shared-kit exception:
 * an argument `emailToolSchemas.<member>` is followed into `shared/imap-tool-kit.ts`
 * ({@link sharedEmailSchemaDeclaration}), where the mail draft and send tools declare their input.
 * Nothing else the call names is followed: a key that appears only in some other local const is
 * not the tool's input.
 */
export function withSchemaArgumentDeclarations(
  sources: readonly PackageSource[],
  code: string,
  call: string,
): string {
  const parts = [call];
  const seen = new Set<string>();
  for (const arg of topLevelArgs(call)) {
    const shared = sharedEmailSchemaDeclaration(sources, arg);
    if (shared !== undefined) parts.push(shared);
    let name = SCHEMA_REF.exec(arg)?.[1];
    while (name !== undefined && !seen.has(name) && seen.size < 20) {
      seen.add(name);
      const statement = constStatement(code, name);
      const schema = statement === undefined ? undefined : schemaConstBase(statement);
      if (statement === undefined || schema === undefined) break;
      parts.push(statement);
      name = schema.base;
    }
  }
  return parts.join("\n");
}

/**
 * The offset of the bracket closing the one opened at `open` in `code` (strings skipped), or -1
 * when it never closes.
 */
export function matchingClose(code: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (quote !== undefined) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The call `("<toolId>", ...)` that registers a READ tool in `code` (comment-free text): the text
 * from its `(` to the matching `)`, or `undefined` when `code` has no such registration. A name in
 * a tool-name array or a description is not preceded by `(`, so it is not matched.
 */
export function registrationCallOf(code: string, toolId: string): string | undefined {
  const m = new RegExp(String.raw`\(\s*"${toolId}"\s*,`).exec(code);
  if (m === null) return undefined;
  const close = matchingClose(code, m.index);
  return close < 0 ? undefined : code.slice(m.index, close + 1);
}

/**
 * The input keys a tool declares: the top-level keys of every `z.object({ ... })` and
 * `.extend({ ... })` object literal in `declaration` (the text {@link withSchemaArgumentDeclarations}
 * returns for the tool's registering call), sorted and without repeats. Only those two shapes are
 * read, so a handler's own object literals (`mutates: ...`, query parameters) are not keys. An
 * empty result means the shape was not recognised: callers must treat that as a failure.
 */
export function declaredInputKeys(declaration: string): string[] {
  const keys = new Set<string>();
  for (const m of declaration.matchAll(/(?:\bz\.object|\.extend)\s*\(\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchingClose(declaration, open);
    if (close < 0) continue;
    for (const entry of topLevelArgs(`(${declaration.slice(open + 1, close)})`)) {
      const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(entry)?.[1];
      if (key !== undefined) keys.add(key);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}
