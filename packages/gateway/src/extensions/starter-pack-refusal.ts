import type { Database } from "bun:sqlite";
import { type ExtensionRow, getExtensionKind } from "../automation/extension-store.ts";
import { forwardDeps } from "./dependency-store.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";

/**
 * A starter pack's code-bearing members: walks its recorded dependency edges through every
 * sub-pack, keeping the installed packages whose kind is `extension`. Each id appears once, in
 * walk order (each package's dependencies sorted by id); a cycle cannot loop.
 */
export function starterPackCodeMembers(db: Database, packId: string): string[] {
  const seen = new Set<string>([packId]);
  const members: string[] = [];
  const visit = (id: string): void => {
    const deps = forwardDeps(db, id)
      .map((d) => d.id)
      .sort((a, b) => a.localeCompare(b));
    for (const dep of deps) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const kind = getExtensionKind(db, dep);
      if (kind === "starter-pack") visit(dep);
      else if (kind === "extension") members.push(dep);
    }
  };
  visit(packId);
  return members;
}

/** The refusal copy: the pack has no code, and how to approve the members it brings instead. */
export function starterPackRefusalMessage(db: Database, packId: string): string {
  const base = `${packId} is a starter pack: it has no code to run.`;
  const members = starterPackCodeMembers(db, packId);
  if (members.length === 0) return base;
  const commands = members.map((m) => `nimbus extension approve ${m}`).join(" && ");
  return `${base} Approve its members instead: ${commands}`;
}

/**
 * A starter pack has no code, so it is never granted `extension.run` and never spawned (I43). Both
 * the approval path and the spawn verifier call this on the row they read, before anything else
 * about the row is resolved.
 */
export function refuseStarterPack(db: Database, row: Pick<ExtensionRow, "id" | "kind">): void {
  if (row.kind === "starter-pack") {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_STARTER_PACK",
      starterPackRefusalMessage(db, row.id),
    );
  }
}
