import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { digestOfCanonicalBytes } from "./toolgen-artifact.ts";
import { TOOLGEN_SIGNING_PUBKEY } from "./toolgen-keypair.ts";
import {
  listSavedTools,
  repairSavedToolCache,
  setSavedToolDisabled,
} from "./toolgen-saved-repo.ts";
import {
  listSavedToolDirs,
  readVerifiedSavedTool,
  removeSavedTool,
} from "./toolgen-saved-store.ts";

/**
 * Boot reconciliation for saved generated tools (spec § 7.1).
 *
 * The `generated_tool` ROW is the root of existence: it is the durable record that an owner
 * approved persistence for this tool. Pass 2 therefore sweeps any `saved/<toolId>` directory with
 * no row, mirroring `extensions/verify-extensions.ts`'s `sweepOrphanActiveDirsBestEffort` — a
 * directory is never adopted, because a valid signature proves an artifact was approved ONCE, not
 * that it is approved NOW. Adopting orphans would let a restored backup, or a copy of a tool the
 * owner deliberately revoked, silently re-register a standing execution capability.
 *
 * STATED COST: losing the database sweeps every saved tool. That is correct rather than
 * unfortunate — what was lost is the record of approval, so the approval is gone with it and the
 * owner re-saves. Do not "fix" this by adopting signed directories.
 */

export interface ReconcileSavedToolsDeps {
  readonly db: Database;
  /** Where `saved/<toolId>` lives — the same root `toolgen-saved-store.ts`'s `savedToolDir` uses. */
  readonly configDir: string;
  readonly vault: NimbusVault;
  readonly logger: Pick<Logger, "warn" | "info">;
}

export interface ReconcileSavedToolsResult {
  readonly verified: number;
  readonly disabled: number;
  readonly sweptOrphans: number;
}

/**
 * Row pass + orphan sweep, in that order (spec § 7.1). **Reconciliation spawns NOTHING** — it only
 * reads `generated_tool` rows, re-verifies each saved artifact against the Vault's CURRENT signing
 * pubkey, and writes back `disabled_reason` / repaired cache columns. N saved tools must never mean
 * N child processes at login: that is a resource cost the owner never approved, and a crash loop in
 * one saved tool's body would become a boot problem rather than a spawn-time one. Loading a tool
 * for actual use re-verifies again at spawn time (a later task) — this pass is a health report for
 * `nimbus tool list`, never the gate.
 *
 * The Vault pubkey is read exactly ONCE for the whole pass via a plain `vault.get`, never
 * `ensureToolgenKeypair` — that helper MINTS a fresh keypair when the Vault holds none, and calling
 * it here would generate signing material during a read-only health check, making every existing
 * saved tool permanently unverifiable against a key that never signed anything. A `null` read means
 * the Vault has no toolgen pubkey at all (a fresh machine, a cleared keychain): every row is marked
 * `pubkey_unavailable` rather than silently skipped or misreported as tampered.
 *
 * `readVerifiedSavedTool` is pure and synchronous per artifact once the pubkey is in hand
 * (`toolgen-keypair.ts`'s `verifyArtifactSignature` docstring), so N rows cost one keychain read,
 * not N.
 */
export async function reconcileSavedTools(
  deps: ReconcileSavedToolsDeps,
): Promise<ReconcileSavedToolsResult> {
  const { db, configDir, vault, logger } = deps;

  const currentPubkeyB64 = await vault.get(TOOLGEN_SIGNING_PUBKEY);

  const rows = listSavedTools(db);
  let verified = 0;
  let disabled = 0;

  for (const row of rows) {
    if (currentPubkeyB64 === null) {
      setSavedToolDisabled(db, row.toolId, "pubkey_unavailable");
      disabled++;
      continue;
    }

    const result = await readVerifiedSavedTool(configDir, row.toolId, currentPubkeyB64);
    if (result.ok) {
      // Content axis: disk (once verified) wins over the cached row. This also RE-ENABLES a tool a
      // previous boot disabled — `disabled_reason` is a cache of a past verification, not a
      // terminal state, so a healthy verify here always clears it.
      setSavedToolDisabled(db, row.toolId, null);
      const digest = digestOfCanonicalBytes(result.canonicalJson);
      if (digest !== row.artifactDigest || result.canonicalJson !== row.artifactJson) {
        repairSavedToolCache(db, row.toolId, {
          artifactJson: result.canonicalJson,
          artifactDigest: digest,
        });
      }
      verified++;
    } else {
      // Cryptography alone cannot tell a key rotation from tampering — both verify as `false`, so
      // `readVerifiedSavedTool` always reports the conservative `signature_mismatch`. Only a
      // caller holding the ROW's stored pubkey alongside the Vault's CURRENT one can tell them
      // apart: when they differ, the artifact almost certainly verified fine under the key that
      // actually signed it, so report the disclosed, non-alarming `pubkey_rotated` instead. Every
      // other reason (`signature_missing`, `artifact_missing`, `schema_invalid`) passes through
      // unchanged — a rotated key cannot explain a missing file or an unparseable shape.
      const reason =
        result.reason === "signature_mismatch" && row.pubkey !== currentPubkeyB64
          ? "pubkey_rotated"
          : result.reason;
      setSavedToolDisabled(db, row.toolId, reason);
      disabled++;
    }
  }

  // Pass 2: orphan sweep. A directory the row pass above never saw (because no row named it) is
  // swept, never adopted — see the file-level docstring. `rows` (fetched before pass 1 ran) is
  // still the authoritative set of known tool ids: pass 1 only ever updates existing rows, it never
  // inserts or deletes one, so re-querying here would answer the identical question a second time.
  const knownToolIds = new Set(rows.map((r) => r.toolId));
  const dirs = await listSavedToolDirs(configDir);
  let sweptOrphans = 0;
  for (const dir of dirs) {
    if (!knownToolIds.has(dir)) {
      await removeSavedTool(configDir, dir);
      sweptOrphans++;
    }
  }

  if (disabled > 0) {
    logger.warn(
      { disabled },
      `toolgen: ${disabled} saved tool(s) failed boot verification and are disabled; see \`nimbus tool list\``,
    );
  }
  if (sweptOrphans > 0) {
    const noun = sweptOrphans === 1 ? "directory" : "directories";
    logger.info(
      { sweptOrphans },
      `toolgen: swept ${sweptOrphans} orphaned saved-tool ${noun} with no database row`,
    );
  }

  return { verified, disabled, sweptOrphans };
}

/**
 * Boot-time wrapper around `reconcileSavedTools`: mirrors `sweepToolgenCredentialsOrWarn` /
 * `reconcileOrphanedCuSessionsOrWarn` in `platform/assemble.ts` — a reconciliation failure (a
 * database error, an unreadable `saved/` root) must NOT abort gateway startup. This is bookkeeping:
 * nothing downstream depends on this pass having completed for a specific tool this boot, and a
 * tool simply keeps whatever `disabled_reason` it already had in the database until the next
 * successful boot picks the sweep back up. Denying the user their whole local index over a saved
 * generated tools health check would be a badly wrong trade.
 */
export async function reconcileSavedToolsOrWarn(deps: ReconcileSavedToolsDeps): Promise<void> {
  try {
    await reconcileSavedTools(deps);
  } catch (err) {
    deps.logger.warn(
      { err },
      "toolgen: could not reconcile saved tools at boot; a stale disabled_reason or an orphaned " +
        "saved/ directory may remain until the next successful boot",
    );
  }
}
