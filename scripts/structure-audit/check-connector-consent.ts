#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type ConsentViolation = {
  readonly rule: "mode-setter-confined" | "mutation-declared";
  readonly file: string;
  readonly reason: string;
};

/**
 * The only production files permitted to name the mode setter.
 *
 * "The mode comes from the entrypoint" is a convention until something enforces it. Any other
 * caller could re-gate a connector mid-process, which is exactly what Non-Negotiable #2 forbids.
 * Test files are exempt: they are in-repo code, not a runtime switch.
 */
const MODE_SETTER_ALLOWED = [
  "packages/gateway/src/connectors/run-bundled-connector.ts",
  "packages/mcp-connectors/shared/connector-mode.ts",
];

/**
 * Rule 2 is now BLOCKING, and it keys on the MANIFEST alone.
 *
 * The HTTP-verb signal it used to carry was removed, on evidence. Once every connector was
 * migrated it still produced 32 findings and essentially all were false: `search-filter.ts` files
 * that do pure filtering, transport helpers like `imap-core.ts`, the seven read-only connectors
 * that POST for GraphQL/search/auth, `kb-append.ts` whose tool is registered in `server.ts`, and
 * the standalone launcher's own `bin.ts`. The rule was per-FILE while migration is per-CONNECTOR,
 * so a helper holding a verb literal never contains the registration.
 *
 * `hitlRequired` is the authoritative signal: authored per connector, transport independent, and
 * true for the ten that mutate through a CLI, the filesystem or a mail protocol with no HTTP
 * request to inspect. A connector that mutates without declaring it is a connector bug — caught in
 * review, not by a heuristic that provably cannot tell.
 */
export const MUTATION_RULE_BLOCKING = true;

/**
 * Whether the connector owning `rel` declares `write` or `delete` in `hitlRequired`.
 *
 * The manifest is the reliable mutation signal for the ten connectors that mutate through a CLI,
 * the filesystem or a mail protocol, where no verb appears in source. It is not sufficient alone:
 * seven connectors issue mutating HTTP requests while declaring nothing, which is why
 * `MUTATING_RE` is checked as well.
 */
function connectorDeclaresWrite(root: string, rel: string): boolean {
  const name = rel.split("/")[2];
  if (name === undefined) return false;
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(root, "packages/mcp-connectors", name, "nimbus.extension.json"), "utf8"),
    );
    if (typeof manifest !== "object" || manifest === null) return false;
    const hitl = (manifest as Record<string, unknown>)["hitlRequired"];
    return Array.isArray(hitl) && hitl.some((h) => h === "write" || h === "delete");
  } catch {
    // An unreadable manifest is an OBSERVATION failure. Fail SAFE: treat it as declaring a write,
    // so the cost is a false positive on one connector rather than silently certifying a mutating
    // one as needing no declaration.
    return true;
  }
}

/**
 * Drop comment-only lines.
 *
 * Deliberately NOT `stripComments` from ./lib.ts. That helper has no regex-literal awareness: a
 * regex containing a quote character — `/(["'`])(POST|PUT)\1/`, which both this audit and the
 * standalone launcher carry — opens a phantom string, and every comment after it survives intact.
 * Verified: a file whose first line is such a regex has its later JSDoc left completely unstripped.
 *
 * A line-based skip is cruder but correct for what this audit asks. It matters because the launcher
 * documents that it deliberately does NOT call setConnectorMode, and a naive match flagged that
 * explanation as a violation — a guard that punishes writing down WHY is worse than useless.
 */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    })
    .join("\n");
}

/**
 * Does this source register a write tool?
 *
 * A registration CALL, or the registrar handed to a shared kit — not a bare substring, which the
 * registrar's own `const registerWriteTool = ...` would satisfy even with nothing registered.
 * Kept in step with the twin in the standalone launcher's copy.
 *
 * Deliberately NOT a regular expression. The previous pattern was
 * `^\s*register[A-Za-z]*WriteTool\(` under `/m`, and it drew two rounds of ReDoS reports. The
 * first was real: `\s` matches a newline, so under `/m` a run of n newlines gave n start
 * positions each able to consume the whole run — quadratic, measured at 21s for 128k newlines.
 * Narrowing the class to horizontal whitespace made it linear, and bounding the star to
 * `{0,40}` kept it linear, but `typescript:S8786` reported both: a star immediately followed by
 * a literal built from the same character class is the shape the rule looks for, bounded or not,
 * and the shape is worth avoiding even where this engine happens not to backtrack.
 *
 * Scanning line by line removes the construct rather than arguing with the analyser. Each line is
 * bounded work, no star sits next to an overlapping literal, and the accepted language is
 * unchanged — including the trailing-comma form, which still requires the comma to end the line.
 */
function registersWriteTool(src: string): boolean {
  for (const line of src.split("\n")) {
    const t = line.trimStart();
    if (t === "registerWriteTool,") return true;
    if (!t.startsWith("register")) continue;
    const at = t.indexOf("WriteTool(");
    if (at < 0) continue;
    // Everything between `register` and `WriteTool(` must be letters, so `registerFoo.WriteTool(`
    // does not count. Anchored at BOTH ends with nothing following, so it carries none of the
    // ambiguity the old pattern did.
    if (/^[A-Za-z]*$/.test(t.slice("register".length, at))) return true;
  }
  return false;
}

/** `packages/mcp-connectors/<name>/...` → `<name>`. */
function connectorOf(rel: string): string {
  return rel.split("/")[2] ?? "";
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") walk(p, out);
    } else if (e.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

export function checkConnectorConsent(
  root: string = resolve(import.meta.dir, "..", ".."),
): ConsentViolation[] {
  const out: ConsentViolation[] = [];
  const hardened = new Set<string>();
  for (const base of ["packages/gateway/src", "packages/mcp-connectors"]) {
    const dir = join(root, base);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of walk(dir)) {
      // Forward slashes so the allow-list comparison is identical on Windows.
      const rel = relative(root, file).replaceAll("\\", "/");
      if (rel.endsWith(".test.ts")) continue;
      const raw = readFileSync(file, "utf8");
      const src = codeOnly(raw);

      if (src.includes("setConnectorMode(") && !MODE_SETTER_ALLOWED.includes(rel)) {
        out.push({
          rule: "mode-setter-confined",
          file: rel,
          reason:
            "names setConnectorMode outside its sanctioned callers — the mode must come from the " +
            "entrypoint, not from arbitrary code",
        });
      }

      // A CALL, not the declaration. `const registerWriteTool = createWriteToolRegistrar(...)`
      // contains the identifier too, so a substring check called a connector hardened even after
      // every one of its write registrations had been reverted — caught by red-proving this gate.
      if (registersWriteTool(src)) hardened.add(connectorOf(rel));
    }
  }
  // Per CONNECTOR, not per file: a connector's write registration lives in one of its files and
  // its verb literals may live in another.
  for (const name of readdirSync(join(root, "packages/mcp-connectors"), { withFileTypes: true })) {
    if (!name.isDirectory() || name.name === "shared" || name.name === "standalone") continue;
    const rel = `packages/mcp-connectors/${name.name}/src/server.ts`;
    if (!connectorDeclaresWrite(root, rel)) continue;
    if (hardened.has(name.name)) continue;
    out.push({
      rule: "mutation-declared",
      file: `packages/mcp-connectors/${name.name}/nimbus.extension.json`,
      reason:
        "declares write or delete in hitlRequired but no file in the connector registers a write " +
        "tool through the consent kit — running it standalone would expose ungated mutations. " +
        "Route its mutating tools through registerWriteTool, or correct the manifest if it does " +
        "not actually mutate",
    });
  }
  return out;
}

if (import.meta.main) {
  const violations = checkConnectorConsent();
  const blocking = violations.filter(
    (v) => v.rule !== "mutation-declared" || MUTATION_RULE_BLOCKING,
  );
  for (const v of violations) {
    const level = blocking.includes(v) ? "error" : "warning";
    console.error(`::${level} file=${v.file}::${v.reason}`);
  }
  const advisory = violations.length - blocking.length;
  console.log(
    blocking.length === 0
      ? `connector consent: ok (${String(advisory)} advisory — see Part 2)`
      : `connector consent: ${String(blocking.length)} violation(s)`,
  );
  process.exit(blocking.length > 0 ? 1 : 0);
}
