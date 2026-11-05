import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderConnectorWriteManifest } from "../../../../../scripts/gen-connector-write-manifest.ts";
import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { CHATOPS_POST_TOOL_IDS } from "../../chatops/transport/connector-post.ts";
import { TRIBAL_KB_WRITE_TOOL_IDS } from "../../tribal/tribal-write-gate.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { CONNECTOR_WRITE_MANIFEST } from "./manifest.generated.ts";

const MANIFEST_PATH = join(import.meta.dir, "manifest.generated.ts");
const sources = readConnectorPackageSources(installedConnectorsPackageRoot());
const scan = scanWriteToolRegistrations(sources);
const gateConfined = (id: string): boolean =>
  CHATOPS_POST_TOOL_IDS.has(id) || TRIBAL_KB_WRITE_TOOL_IDS.has(id);
const manifestIds = new Set(CONNECTOR_WRITE_MANIFEST.map((e) => e.toolId));
const rowIds = new Set(CONNECTOR_WRITE_ROWS.map((r) => r.toolId));

/**
 * The text of `const <name> = ...;` in `code`, ended at the first `;` outside brackets, or
 * `undefined` when `code` declares no such const.
 */
function constStatement(code: string, name: string): string | undefined {
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
function topLevelArgs(call: string): string[] {
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

/**
 * `call` plus the declaration of the local schema const it passes as an argument (`schema` or
 * `schema.extend({...})`) and that const's `.extend(` base chain. Nothing else the call names is
 * followed: a key that appears only in some other local const is not the tool's input.
 */
function withSchemaArgumentDeclarations(code: string, call: string): string {
  const parts = [call];
  const seen = new Set<string>();
  for (const arg of topLevelArgs(call)) {
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

describe("connector write manifest", () => {
  test("the committed manifest is what the generator produces from the installed package", () => {
    const committed = readFileSync(MANIFEST_PATH, "utf8").replaceAll("\r\n", "\n");
    expect(
      committed === renderConnectorWriteManifest(scan),
      "stale manifest: run `bun run gen:connector-write-manifest` and commit the result",
    ).toBe(true);
  });

  test("no gate-confined id is spelled in the generated file", () => {
    const text = readFileSync(MANIFEST_PATH, "utf8");
    const spelled = [...CHATOPS_POST_TOOL_IDS, ...TRIBAL_KB_WRITE_TOOL_IDS].filter((id) =>
      text.includes(id),
    );
    expect(spelled).toEqual([]);
  });

  test("every registered write has a row", () => {
    const missing = [...manifestIds].filter((id) => !rowIds.has(id));
    expect(
      missing,
      "classify it in packages/gateway/src/connectors/connector-writes/<group>.ts",
    ).toEqual([]);
  });

  test("every row not marked registeredAs read names a registered write", () => {
    const stray = CONNECTOR_WRITE_ROWS.filter(
      (r) => r.registeredAs === undefined && !manifestIds.has(r.toolId),
    ).map((r) => r.toolId);
    expect(stray).toEqual([]);
  });

  test("every registeredAs-read row is still registered as a read", () => {
    const registered = CONNECTOR_WRITE_ROWS.filter(
      (r) => r.registeredAs !== undefined && manifestIds.has(r.toolId),
    ).map((r) => r.toolId);
    expect(registered, "upstream now registers it as a write: drop registeredAs").toEqual([]);
  });

  test("a literal mutates agrees with the row", () => {
    const rowById = new Map(CONNECTOR_WRITE_ROWS.map((r) => [r.toolId, r]));
    const code = new Map(sources.map((s) => [s.rel, stripComments(s.text)]));
    const problems: string[] = [];
    let compared = 0;
    for (const r of scan.registrations) {
      if (gateConfined(r.id)) continue;
      const row = rowById.get(r.id);
      if (row === undefined) {
        problems.push(`${r.id}: no row`);
        continue;
      }
      const call = (code.get(r.file) ?? "").slice(r.span[0], r.span[1] + 1);
      const m = /\bmutates:\s*"([^"]*)"/.exec(call);
      if (m?.[1] === undefined || m[1].includes("${")) continue;
      compared++;
      if (m[1] !== row.actionType) problems.push(`${r.id}: ${m[1]} != ${row.actionType}`);
    }
    expect(problems).toEqual([]);
    // 0.3.0 has 70 literal `mutates` on rowed writes; a span or regex that stopped matching would
    // compare none and pass, so the comparison count is pinned too.
    expect(compared).toBeGreaterThanOrEqual(60);
  });

  test("every template key names an input key the connector declares", () => {
    const regByTool = new Map(scan.registrations.map((r) => [r.id, r]));
    const code = new Map(sources.map((s) => [s.rel, stripComments(s.text)]));
    const templateKeys = (r: (typeof CONNECTOR_WRITE_ROWS)[number], extra: string[] = []) => {
      const t = r.preview;
      if (t === undefined) return [];
      const keys = new Set<string>([...t.fields.map((f) => f.key), ...extra]);
      for (const text of [t.target, t.summary]) {
        for (const m of text.matchAll(/\{([A-Za-z0-9_]+)\}/g))
          if (m[1] !== undefined) keys.add(m[1]);
      }
      return [...keys];
    };
    const problemsFor = (r: (typeof CONNECTOR_WRITE_ROWS)[number], extra: string[] = []) => {
      const reg = regByTool.get(r.toolId);
      if (reg === undefined) return [`${r.toolId}: not registered`];
      // Slice by the registration's own span: `id:` / `name:` appear for other tools in the file.
      const fileCode = code.get(reg.file) ?? "";
      // A tool registered through a local helper (Monte Carlo, Bigeye) declares its input schema in
      // the helper's body, which the forwarding call's span does not contain; for those the file is
      // the narrowest region available. Every other tool is checked against its own call only.
      const own = reg.tags.includes("forwarder")
        ? fileCode
        : fileCode.slice(reg.span[0], reg.span[1] + 1);
      // A tool whose input schema is a local const (`slackMessagePostSchema`, or a `.extend` of
      // one) declares its keys in that const's statement, outside the call: follow it alone.
      const call = reg.tags.includes("forwarder")
        ? own
        : withSchemaArgumentDeclarations(fileCode, own);
      return templateKeys(r, extra)
        .filter((k) => !call.includes(`${k}:`))
        .map((k) => `${r.toolId}: ${k}`);
    };
    const templated = CONNECTOR_WRITE_ROWS.filter(
      (r) => r.preview !== undefined && r.registeredAs === undefined,
    );
    expect(templated.length).toBeGreaterThanOrEqual(18);
    expect(templated.flatMap((r) => problemsFor(r))).toEqual([]);
    // Negative control: a made-up key must be reported, so the check can fail.
    const tableau = templated.find((r) => r.toolId === "tableau_datasource_refresh");
    if (tableau === undefined) throw new Error("tableau_datasource_refresh row missing");
    expect(problemsFor(tableau, ["nonexistentKey"])).toEqual([
      "tableau_datasource_refresh: nonexistentKey",
    ]);
  });

  test("the manifest's size is plausible", () => {
    expect(CONNECTOR_WRITE_MANIFEST.length).toBeGreaterThanOrEqual(80);
  });

  test("guard: only the schema argument and its .extend chain are followed", () => {
    const code = [
      "const baseSchema = z.object({ owner: z.string() });",
      "const postSchema = baseSchema.extend({ body: z.string() });",
      "const unrelated = { secretKey: 1, title: 2 };",
      "const helper = (p) => ({ path: p });",
      'reg("t", "Post a, b (c)", postSchema, async (parsed) => unrelated);',
    ].join("\n");
    const callAt = code.indexOf('reg("t"') + 3;
    const call = code.slice(callAt, code.lastIndexOf(")") + 1);
    const followed = withSchemaArgumentDeclarations(code, call);
    expect(followed).toContain("body:");
    expect(followed).toContain("owner:");
    // A key present only in an unrelated local const is NOT the tool's input: it is reported.
    expect(followed).not.toContain("secretKey:");
    expect(followed).not.toContain("title:");
    expect(topLevelArgs('("a, b", { x: [1, 2] }, s, (p) => f(p, q))')).toEqual([
      '"a, b"',
      "{ x: [1, 2] }",
      "s",
      "(p) => f(p, q)",
    ]);
    // An inline `.extend(` of a schema const is followed too; a non-schema const is not.
    const inline = withSchemaArgumentDeclarations(
      code,
      '("t", baseSchema.extend({ a: 1 }), helper)',
    );
    expect(inline).toContain("owner:");
    expect(inline).not.toContain("path:");
  });
});
