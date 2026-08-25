import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Connector ids are directory names: lowercase letters, digits and hyphens only. */
const ID_RE = /^[a-z0-9-]+$/;

/**
 * Does this source register a write tool?
 *
 * A registration CALL, or the registrar handed to a shared kit — not a bare substring, which the
 * registrar's own `const registerWriteTool = ...` would satisfy even with nothing registered.
 * Kept in step with the twin in check-connector-consent.ts.
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

function connectorsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Resolve a connector id to its server entrypoint.
 *
 * The id is validated against a strict allow-list BEFORE being joined into a path. A separator or
 * `..` would otherwise let the id escape the connectors directory and import an arbitrary module.
 */
export function resolveConnectorEntry(id: string): string {
  if (!ID_RE.test(id)) {
    throw new Error(
      `invalid connector id ${JSON.stringify(id)}: expected only lowercase letters, digits and hyphens`,
    );
  }
  return join(connectorsDir(), id, "src", "server.ts");
}

export type Eligibility =
  | { readonly eligible: true; readonly reason: "no-writes" | "hardened" }
  | { readonly eligible: false; readonly reason: string };

/**
 * Whether a connector may run STANDALONE.
 *
 * Derived, never curated. A connector qualifies when it declares no mutating capability at all, or
 * when its write tools have been routed through the consent kit. Anything else would expose
 * ungated destructive tools the moment it started outside the gateway — the exact outcome this
 * whole subsystem exists to prevent — so the launcher refuses to start it.
 *
 * `hitlRequired` is the AUTHORITATIVE signal, and deliberately the only one. It is authored per
 * connector and transport independent: ten connectors mutate through a CLI, the filesystem or a
 * mail protocol, where no scan of the source could see them.
 *
 * Scanning for a mutating HTTP verb was tried here and REMOVED. It cannot decide this question in
 * either direction: seven read-only connectors POST for GraphQL queries, filter endpoints, OAuth
 * token exchange and login (dagster, google-photos, prefect, ramp, snyk, superset, wiz), so the
 * verb wrongly refused all seven; and it is blind to the ten that never issue an HTTP request at
 * all. A connector that mutates without declaring it is a CONNECTOR BUG, caught at authoring time
 * by `registerWriteTool` and its audit — not by a runtime heuristic that provably cannot tell.
 *
 * An unreadable manifest is treated as declaring a write. The cost is refusing one connector that
 * might have been fine; the alternative is starting one that is not.
 */
export function standaloneEligibility(
  id: string,
  // Injectable root so a test can point at a fixture. Tests previously used a real connector as
  // their "unmigrated" example and broke the moment it was migrated — a test whose meaning depends
  // on unrelated work is a test that will lie eventually.
  root: string = connectorsDir(),
): Eligibility {
  const dir = join(root, id);
  let declaresWrite: boolean;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "nimbus.extension.json"), "utf8"));
    const hitl =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["hitlRequired"]
        : undefined;
    declaresWrite = Array.isArray(hitl) && hitl.some((h) => h === "write" || h === "delete");
  } catch {
    declaresWrite = true;
  }
  if (!declaresWrite) return { eligible: true, reason: "no-writes" };

  // BOTH entrypoint files. 16 connectors register their tools in `src/tools.ts` rather than
  // `src/server.ts` — apple, fastmail, imap, protonmail and the CLI-backed cloud ones among them —
  // so reading only server.ts would refuse a connector that IS hardened, in tools.ts.
  let src = "";
  for (const f of ["server.ts", "tools.ts"]) {
    try {
      src += readFileSync(join(dir, "src", f), "utf8");
    } catch {
      /* a connector need not have both; an unreadable pair falls through to the refusal below */
    }
  }

  if (registersWriteTool(src)) {
    return { eligible: true, reason: "hardened" };
  }

  return {
    eligible: false,
    reason:
      `${id} declares write or delete tools in its manifest that have not been routed through ` +
      "the consent kit, " +
      "so running it standalone would expose ungated mutations. Run it through the Nimbus " +
      "gateway, which gates them, until this connector is migrated.",
  };
}

/** How a connector entrypoint is loaded. Injectable so tests need not import a real stdio server. */
export type ConnectorImporter = (entry: string) => Promise<{
  startConnector?: (() => Promise<void>) | undefined;
}>;

/**
 * Start one connector standalone.
 *
 * Deliberately does NOT call `setConnectorMode("standalone")`. Standalone is the DEFAULT, so
 * asserting it here would add a second production caller — which the `audit:connector-consent`
 * gate forbids — while changing nothing. Do not "fix" this omission.
 */
export async function runStandalone(
  argv: readonly string[],
  importConnector: ConnectorImporter = (entry) => import(entry),
): Promise<number> {
  const id = argv[0];
  if (id === undefined) {
    process.stderr.write("usage: nimbus-mcp <connector-id>\n");
    return 2;
  }
  let entry: string;
  try {
    entry = resolveConnectorEntry(id);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  if (!existsSync(entry)) {
    process.stderr.write(`unknown connector ${JSON.stringify(id)}\n`);
    return 2;
  }

  const verdict = standaloneEligibility(id);
  if (!verdict.eligible) {
    process.stderr.write(`${verdict.reason}\n`);
    return 3;
  }

  const mod = await importConnector(entry);
  // Mirrors run-bundled-connector.ts: most connectors connect their transport at module scope, ten
  // guard on import.meta.main and export startConnector() instead.
  await mod.startConnector?.();
  return 0;
}
