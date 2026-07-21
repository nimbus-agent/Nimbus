/**
 * Preflight gate: the manifest's Nimbus-scoped entries and this repo's workflow
 * `secrets.*` references must agree.
 *
 * Monorepo-only by design. Extending it across the other 17 repos would require
 * reading their workflow files, i.e. `contents: read` — the permission
 * deliberately withheld so the auditor App cannot read code. Paying for
 * validation of a documentation field with a code-read grant is a bad trade.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_REGISTRY } from "../release/credential-registry";

const WORKFLOWS = join(process.cwd(), ".github", "workflows");

/** Secrets GitHub injects itself; never declared in the manifest. */
const BUILTIN = new Set(["GITHUB_TOKEN"]);

function referencedSecrets(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"))) {
    const text = readFileSync(join(WORKFLOWS, file), "utf8");
    for (const m of text.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
      const name = m[1];
      if (!name || BUILTIN.has(name)) continue;
      const list = found.get(name) ?? [];
      if (!list.includes(file)) list.push(file);
      found.set(name, list);
    }
  }
  return found;
}

function main(): void {
  const referenced = referencedSecrets();
  const declared = new Map(
    CREDENTIAL_REGISTRY.filter(
      (e) =>
        e.product === "actions" && (e.location.scope === "org" || e.location.repo === "Nimbus"),
    ).map((e) => [e.name, e]),
  );

  const problems: string[] = [];

  for (const [name, files] of referenced) {
    if (!declared.has(name)) {
      problems.push(
        `${name} is referenced by ${files.join(", ")} but is not in credential-registry.ts`,
      );
    }
  }

  for (const [name, entry] of declared) {
    if (entry.state === "forbidden") continue;
    if (entry.consumedBy.length === 0) continue;
    // Only assert this direction for entries consumed by THIS repo. Org-scoped
    // secrets legitimately list satellite paths (e.g.
    // "nimbus-sdk/.github/workflows/release.yml"), and those files are not in
    // this checkout — flagging them would be a guaranteed false positive on
    // RELEASE_PLEASE_PAT, whose three consumers all live in other repos.
    // Local paths start with ".github/"; anything else is another repo's.
    const localPaths = entry.consumedBy.filter((p) => p.startsWith(".github/"));
    if (localPaths.length === 0) continue;
    if (!referenced.has(name)) {
      problems.push(
        `${name} declares consumedBy ${entry.consumedBy.join(", ")} but no workflow in this repo references it`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("audit:consumed-by: FAILED");
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`audit:consumed-by: OK (${declared.size} declared, ${referenced.size} referenced)`);
}

main();
