import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A mutating HTTP method as a quoted literal, in any of the three quote styles.
 *
 * Bounded by design: it cannot see a method held in a variable, nor tell a GraphQL read POST from
 * a write POST. It is a net for the obvious cases, paired with the manifest signal — not a
 * substitute for the write declaration itself.
 */
const MUTATING_VERB_RE = /(["'`])(POST|PUT|PATCH|DELETE)\1/;

/** Connector ids are directory names: lowercase letters, digits and hyphens only. */
const ID_RE = /^[a-z0-9-]+$/;

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
 * `hitlRequired` is the primary signal because it is authored per connector and transport
 * independent: ten connectors mutate through a CLI, the filesystem or a mail protocol, where no
 * scan of the source for an HTTP verb can see them.
 *
 * An unreadable manifest is treated as declaring a write. The cost is refusing one connector that
 * might have been fine; the alternative is starting one that is not.
 */
export function standaloneEligibility(id: string): Eligibility {
  const dir = join(connectorsDir(), id);
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
  let src = "";
  try {
    src = readFileSync(join(dir, "src", "server.ts"), "utf8");
  } catch {
    /* an unreadable entrypoint falls through to the refusal below */
  }

  // SECOND signal, and it is not redundant. Seven connectors — dagster, google-photos, prefect,
  // ramp, snyk, superset, wiz — issue mutating HTTP requests while declaring `hitlRequired: []`,
  // so trusting the manifest alone would admit them as write-free. The manifest catches the ten
  // that mutate through a CLI, the filesystem or a mail protocol, where no verb appears in source;
  // the verb catches these seven. Each covers the other's blind spot.
  const carriesMutatingVerb = MUTATING_VERB_RE.test(src);

  if (!declaresWrite && !carriesMutatingVerb) return { eligible: true, reason: "no-writes" };

  if (src.includes("registerWriteTool")) return { eligible: true, reason: "hardened" };

  return {
    eligible: false,
    reason:
      `${id} exposes mutating tools (declared in its manifest, or visible in its source) that ` +
      "have not been routed through the consent kit, " +
      "so running it standalone would expose ungated mutations. Run it through the Nimbus " +
      "gateway, which gates them, until this connector is migrated.",
  };
}

/**
 * Start one connector standalone.
 *
 * Deliberately does NOT call `setConnectorMode("standalone")`. Standalone is the DEFAULT, so
 * asserting it here would add a second production caller — which the `audit:connector-consent`
 * gate forbids — while changing nothing. Do not "fix" this omission.
 */
export async function runStandalone(argv: readonly string[]): Promise<number> {
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

  const mod = (await import(entry)) as { startConnector?: () => Promise<void> };
  // Mirrors run-bundled-connector.ts: most connectors connect their transport at module scope, ten
  // guard on import.meta.main and export startConnector() instead.
  await mod.startConnector?.();
  return 0;
}

if (import.meta.main) {
  process.exit(await runStandalone(process.argv.slice(2)));
}
