#!/usr/bin/env bun

/**
 * audit:secret-inventory — every secret this repo's workflows consume must be
 * documented in docs/ci-secrets.md.
 *
 * Row 3 of the infrastructure roadmap's opening table names this exact drift:
 * `ci-secrets.md`'s completeness claim was written before `secret-health.yml`
 * existed, and never grew to cover the probe's OWN credentials. A doc that
 * claims completeness and is not complete is worse than no doc, because it is
 * consulted during an incident.
 *
 * Unlike the release-train gates this one is LOCAL and deterministic — it reads
 * only checked-in files, mints no token, and touches no network — so it runs on
 * every PR from the preflight fast tier rather than the scheduled sweep.
 *
 * See docs/superpowers/specs/2026-07-26-p5-p3-infra-batch-design.md.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CREDENTIAL_REGISTRY } from "../release/credential-registry.ts";

/**
 * Secrets that cannot meaningfully appear in an inventory of things an operator
 * must provision. `GITHUB_TOKEN` is minted by Actions for every run.
 *
 * Kept deliberately tiny: every past instance of this drift pattern hid inside a
 * plausible-looking exemption, so anything absent from the doc is a finding
 * unless it is literally impossible to provision.
 */
export const UNDOCUMENTABLE_SECRETS: readonly string[] = ["GITHUB_TOKEN"];

export interface WorkflowFile {
  path: string;
  text: string;
}

export interface InventoryFinding {
  secret: string;
  workflows: string[];
  /**
   * Which of the two inventories is missing it. The registry is authoritative
   * (rotation policy, ownership, the health probe's watch-list); the prose doc
   * is the narrative consulted during an incident. They fail differently, so
   * the finding says which — "add a row to a table" and "this credential is
   * unmanaged" are not the same repair.
   */
  missingFrom: "doc" | "registry" | "both";
}

/**
 * Every `secrets.NAME` a workflow references, mapped to the workflows naming it.
 * Matches the dotted form and both bracket forms, since all three appear in real
 * workflows and a reference missed here reads as "documented" — the silent
 * direction of failure.
 */
export function collectWorkflowSecrets(files: readonly WorkflowFile[]): Map<string, string[]> {
  const re = /secrets\.([A-Z][A-Z0-9_]*)|secrets\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g;
  const out = new Map<string, string[]>();
  for (const f of files) {
    for (const m of f.text.matchAll(re)) {
      const name = m[1] ?? m[2];
      if (!name) continue;
      const list = out.get(name) ?? [];
      if (!list.includes(f.path)) list.push(f.path);
      out.set(name, list);
    }
  }
  return out;
}

/**
 * Every secret name documented in ci-secrets.md, read as any backtick-quoted
 * UPPER_SNAKE token of 3+ chars.
 *
 * Deliberately loose rather than table-aware: the doc is prose *plus* a table,
 * and a parser bound to the table's shape would silently start reporting
 * findings the moment someone documented a secret in a paragraph. A retired
 * entry (`~~`CODECOV_TOKEN`~~`) still counts — that is a deliberate record.
 */
export function documentedSecrets(doc: string): Set<string> {
  const out = new Set<string>();
  for (const m of doc.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

/**
 * One-directional on purpose: workflow -> doc only.
 *
 * `ci-secrets.md` is an ORG-WIDE inventory — it documents `VSCE_PAT`,
 * `OVSX_PAT` and `NPM_TOKEN`, consumed by workflows in nimbus-vscode and the
 * npm repos, not here. Gating the reverse direction would red on entries that
 * are correct, and the only way to satisfy it would be to delete true
 * information from the inventory.
 */
export function evaluateInventory(
  used: ReadonlyMap<string, readonly string[]>,
  documented: ReadonlySet<string>,
  registered: ReadonlySet<string>,
  exclusions: readonly string[],
): InventoryFinding[] {
  const findings: InventoryFinding[] = [];
  for (const [secret, workflows] of used) {
    if (exclusions.includes(secret)) continue;
    const inDoc = documented.has(secret);
    const inRegistry = registered.has(secret);
    if (inDoc && inRegistry) continue;
    const missingFrom = !inDoc && !inRegistry ? "both" : inDoc ? "registry" : "doc";
    findings.push({ secret, workflows: [...workflows], missingFrom });
  }
  findings.sort((a, b) => a.secret.localeCompare(b.secret));
  return findings;
}

/** Workflow files as {path, text}, path relative for readable messages. */
function readWorkflows(repoRoot: string): WorkflowFile[] {
  const dir = join(repoRoot, ".github", "workflows");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => ({ path: f, text: readFileSync(join(dir, f), "utf8") }));
}

if (import.meta.main) {
  const label = "audit:secret-inventory";
  const root = join(import.meta.dir, "..", "..");

  const used = collectWorkflowSecrets(readWorkflows(root));
  const documented = documentedSecrets(readFileSync(join(root, "docs", "ci-secrets.md"), "utf8"));
  const registered = new Set(CREDENTIAL_REGISTRY.map((c) => c.name));
  const findings = evaluateInventory(used, documented, registered, UNDOCUMENTABLE_SECRETS);

  // Informational only — the doc is org-wide, so an entry with no local
  // consumer is expected, not a defect. Printed so the inventory's shape stays
  // visible without ever failing the gate.
  const unused = [...documented].filter((s) => !used.has(s)).sort();
  if (unused.length > 0) {
    console.log(`${label}: ${unused.length} documented secret(s) with no workflow in THIS repo`);
  }

  for (const f of findings) {
    const where =
      f.missingFrom === "both"
        ? "neither docs/ci-secrets.md nor scripts/release/credential-registry.ts"
        : f.missingFrom === "registry"
          ? "scripts/release/credential-registry.ts (unmanaged: no owner, no rotation policy, not watched by secret-health)"
          : "docs/ci-secrets.md";
    console.error(
      `::error file=docs/ci-secrets.md::${f.secret} is used by ${f.workflows.join(", ")} but is absent from ${where}`,
    );
  }
  if (findings.length > 0) {
    console.error(`${label}: FAILED — ${findings.length} undocumented secret(s)`);
    process.exit(1);
  }
  console.log(`${label}: OK (${used.size} secrets referenced, all documented)`);
}
