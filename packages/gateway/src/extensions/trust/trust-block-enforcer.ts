/**
 * When newly recorded trust statements block an installed extension (I48, spec § 6.5 items 3 and
 * 5): its running client is stopped at once — the next spawn is refused by the pre-spawn check on
 * its own — and the owner gets ONE OS notification per newly blocked extension. "Newly" is decided
 * by the statement ids just inserted, so a statement already stored never notifies twice, and a
 * block the run grant already acknowledged stops and notifies nothing.
 */
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";

import { listExtensions } from "../../automation/extension-store.ts";
import { readVerifiedManifest } from "../approve-run.ts";
import { getRunGrant } from "../run-grant-store.ts";
import { blocksForInstalled, type TrustBlock, unacknowledged } from "./trust-blocks.ts";

export interface TrustBlockEnforcerDeps {
  readonly db: Database;
  readonly stop: (extensionId: string) => Promise<void>;
  /** The notification service's never-throwing `showIgnoringFailure`. */
  readonly notify: (title: string, body: string) => void;
  readonly logger: Pick<Logger, "warn">;
}

export interface TrustBlockEnforcer {
  /** Never rejects. */
  onRecorded(insertedIds: readonly string[]): Promise<void>;
}

/** The toast text for one newly blocked extension. Exported for its test. */
export function notificationBody(id: string, b: TrustBlock): string {
  const what = b.kind === "key.revoke" ? "its publisher key was revoked" : "it was taken down";
  let by = "by its publisher";
  if (b.issuer === "nimbus") by = "by Nimbus";
  else if (b.issuer === "registry") by = `by the maintainer of registry "${b.registry ?? "?"}"`;
  return `${id}: ${what} ${by} (${b.reason}). It will not run until you re-approve it.`;
}

function newBlocksFor(
  db: Database,
  row: ReturnType<typeof listExtensions>[number],
  inserted: ReadonlySet<string>,
): TrustBlock[] {
  let manifest: ReturnType<typeof readVerifiedManifest>;
  try {
    manifest = readVerifiedManifest(row);
  } catch {
    return []; // the spawn path refuses an unreadable manifest on its own
  }
  const blocks = blocksForInstalled(db, row, manifest).filter((b) => inserted.has(b.statementId));
  return unacknowledged(blocks, getRunGrant(db, row.id)?.trust_ack_json);
}

export function createTrustBlockEnforcer(deps: TrustBlockEnforcerDeps): TrustBlockEnforcer {
  return {
    async onRecorded(insertedIds) {
      if (insertedIds.length === 0) return;
      const inserted = new Set(insertedIds);
      let rows: ReturnType<typeof listExtensions>;
      try {
        rows = listExtensions(deps.db).filter((r) => r.enabled === 1);
      } catch (e) {
        deps.logger.warn({ err: e }, "trust block enforcement could not list extensions");
        return;
      }
      for (const row of rows) {
        let fresh: TrustBlock[];
        try {
          fresh = newBlocksFor(deps.db, row, inserted);
        } catch (e) {
          deps.logger.warn({ err: e, extensionId: row.id }, "trust block evaluation failed");
          continue;
        }
        const first = fresh[0];
        if (first === undefined) continue;
        try {
          // Sequential: stopping one client at a time keeps each stop's failure its own.
          await deps.stop(row.id); // NOSONAR S9382: one extension's client at a time
        } catch (e) {
          deps.logger.warn({ err: e, extensionId: row.id }, "could not stop a blocked extension");
        }
        deps.notify("Extension blocked", notificationBody(row.id, first));
      }
    },
  };
}
