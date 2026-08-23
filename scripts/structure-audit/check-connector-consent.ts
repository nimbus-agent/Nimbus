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
 * A mutating HTTP method as a quoted literal, in any of the three quote styles. Biome normalises
 * to double quotes, but a template literal is untouched by it.
 *
 * BOUNDED BY DESIGN: this cannot see a method built from a variable, nor tell a GraphQL read POST
 * from a write POST. That is precisely why write status is DECLARED via `registerWriteTool` rather
 * than detected — this rule is a net for the obvious cases, not the mechanism. Do not extend it
 * into a substitute for the declaration.
 */
const MUTATING_RE = /(["'`])(POST|PUT|PATCH|DELETE)\1/;

/**
 * Rule 2 is ADVISORY in Part 1 and blocking at the end of Part 2.
 *
 * ~43 connectors still register mutations through the plain registrar, so blocking now would red
 * `main` for work that is deliberately scheduled later. A named constant rather than a silent
 * `exit(0)`, so flipping it is a one-line, reviewable change.
 */
export const MUTATION_RULE_BLOCKING = false;

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

      if (
        rel.startsWith("packages/mcp-connectors/") &&
        rel.includes("/src/") &&
        (MUTATING_RE.test(src) || connectorDeclaresWrite(root, rel)) &&
        !src.includes("registerWriteTool")
      ) {
        out.push({
          rule: "mutation-declared",
          file: rel,
          reason:
            "exposes mutating tools but registers no write tool — write status must be DECLARED, " +
            "since it cannot be inferred (a GraphQL connector POSTs its reads too, and ten " +
            "connectors mutate through a CLI or the filesystem with no verb in source)",
        });
      }
    }
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
