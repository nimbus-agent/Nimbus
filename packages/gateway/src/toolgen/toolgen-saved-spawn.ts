import type { Database } from "bun:sqlite";
import type { ExtensionManifest } from "../extensions/manifest.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { isToolgenCapabilityEnabled, type ToolgenCapabilityState } from "./toolgen-capability.ts";
import type { GeneratedToolHandle } from "./toolgen-client.ts";
import { TOOLGEN_SIGNING_PUBKEY } from "./toolgen-keypair.ts";
import { assertConcreteManifestMatches } from "./toolgen-portable-manifest.ts";
import type { SavedToolEnvelope, ToolgenRegistry } from "./toolgen-registry.ts";
import { listSavedTools } from "./toolgen-saved-repo.ts";
import {
  readVerifiedSavedTool,
  type rewriteSavedToolScript,
  type SavedArtifactFields,
  savedToolDir,
} from "./toolgen-saved-store.ts";
import { buildGeneratedManifest, emitToolScript } from "./toolgen-stub.ts";
import {
  ERR_TOOLGEN_SIGNATURE_INVALID,
  type GeneratedToolArtifact,
  type ToolgenEnvelope,
  ToolgenError,
} from "./toolgen-types.ts";

/**
 * Load — verify, don't spawn (spec § 7, § 7.1) — plus spawn — verify AGAIN, then rebuild (spec
 * § 7's own "spawn re-verifies" clause) — for saved (persisted) generated tools.
 *
 * These two entry points share one property and nothing else: neither ever trusts a value read
 * back from disk without re-verifying it against the Vault's CURRENT signing pubkey first, via
 * `readVerifiedSavedTool` — the ONE accessor for a saved artifact's body/fields (D29(d)). Boot
 * reconciliation (`toolgen-boot-reconcile.ts`, Task 8) ALSO calls that same function, over the same
 * files, and this module calls it again rather than trusting reconciliation's cached
 * `disabled_reason` column — that column is a health-report CACHE for `nimbus tool list`, never an
 * authority a loader or a spawn may rely on, because a gateway that has been running for a week
 * (or has been loaded once at boot) must not treat a signature checked back then as still good now.
 */

/** Rebuild the CONCRETE manifest from code and assert it against the signed portable shape, the
 * one step both `loadSavedToolsIntoRegistry` and `spawnSavedTool` need identically. Rebuilding from
 * code (never reading a manifest back from disk) is what makes this safe: a reconstructed manifest
 * is not attacker-influenceable, and this assertion proves the rebuild did not widen anything the
 * signature covers. Returns `null` on any failure (signature-valid-but-mismatched shape) rather
 * than throwing, for `loadSavedToolsIntoRegistry`'s caller, which must skip such a tool rather than
 * abort loading every other one; `spawnSavedTool` re-throws the failure instead, since a single
 * spawn attempt has no "skip and continue" — the caller asked for THIS tool. */
function rebuildManifestOrNull(
  toolId: string,
  savedDir: string,
  fields: SavedArtifactFields,
  runtimeReadPaths: readonly string[],
): ExtensionManifest | null {
  const manifest = buildGeneratedManifest(toolId, { scriptDir: savedDir, runtimeReadPaths });
  try {
    assertConcreteManifestMatches(manifest, fields.manifest, [savedDir, ...runtimeReadPaths]);
  } catch {
    return null;
  }
  return manifest;
}

function toArtifact(
  fields: SavedArtifactFields,
  manifest: ExtensionManifest,
): GeneratedToolArtifact {
  return {
    toolId: fields.toolId,
    toolName: fields.toolName,
    description: fields.description,
    body: fields.body,
    approvedHosts: fields.approvedHosts,
    credentialHosts: fields.credentialHosts,
    manifest,
    inputSchema: fields.inputSchema,
  };
}

export interface LoadSavedToolsDeps extends ToolgenCapabilityState {
  readonly db: Database;
  /** Where `saved/<toolId>` lives — the same root `toolgen-saved-store.ts`'s `savedToolDir` uses. */
  readonly configDir: string;
  readonly vault: Pick<NimbusVault, "get">;
  /** Paths the sandbox must grant READ for the interpreter to load at all — see
   * `buildGeneratedManifest`'s docstring. Resolved ONCE and reused for every row, exactly like
   * `reconcileSavedTools` resolves the Vault pubkey once for its whole pass. */
  readonly runtime: { readonly requiredReadPaths: () => readonly string[] };
}

/**
 * Populate `registry`'s saved collection from durable storage (spec § 7.2) — the step that makes
 * "visible to every session" true in a real gateway process, not only in a unit test that calls
 * `registerSaved` by hand.
 *
 * **This is a LOAD, not the security gate.** It re-verifies every row (never trusting boot
 * reconciliation's cached `disabled_reason`, for the reason given in this file's docstring), but a
 * tool that verifies HERE is still re-verified a THIRD time by `spawnSavedTool` before it actually
 * runs — the boot pass and this load are both a "is it currently healthy" READ, the spawn is the
 * GATE. A saved tool that fails verification (or whose reconstructed manifest no longer matches
 * the signed shape) is simply skipped — absent from the registry entirely, never registered as a
 * tool that then errors when the model tries to call it (spec § 7's own wording, one level up from
 * `buildGeneratedTools`'s existing `{}`-for-empty-session shape).
 *
 * **Spawns nothing**, mirroring `reconcileSavedTools`'s own guarantee: N saved tools loaded here
 * must never mean N child processes at login.
 *
 * An absent Vault pubkey (a fresh machine, a cleared keychain) means NOTHING can verify, so nothing
 * is loaded — not an error, since `reconcileSavedToolsOrWarn` already logged this condition for
 * every affected row at boot moments earlier.
 */
export async function loadSavedToolsIntoRegistry(
  deps: LoadSavedToolsDeps,
  registry: ToolgenRegistry,
): Promise<void> {
  // The kill switch, checked before anything is read. A saved tool loaded here becomes visible to
  // `ToolgenRegistry.forSession` and therefore to `buildGeneratedTools` — i.e. it is OFFERED to the
  // model — so `[tool_generation] enabled = false` and an org-policy lock-off have to stop it here
  // or they do not stop it at all. Fail-closed on an absent policy accessor (I22), matching
  // `assertSaveEnabled`. Nothing durable is touched: the rows and directories stay, and
  // re-enabling restores visibility at the next boot.
  if (!isToolgenCapabilityEnabled(deps)) return;

  const pubkeyB64 = await deps.vault.get(TOOLGEN_SIGNING_PUBKEY);
  if (pubkeyB64 === null) return;

  const runtimeReadPaths = deps.runtime.requiredReadPaths();
  for (const row of listSavedTools(deps.db)) {
    const verified = await readVerifiedSavedTool(deps.configDir, row.toolId, pubkeyB64);
    if (!verified.ok) continue;

    const fields = verified.artifact;
    const dir = savedToolDir(deps.configDir, row.toolId);
    const manifest = rebuildManifestOrNull(row.toolId, dir, fields, runtimeReadPaths);
    if (manifest === null) continue;

    const envelope: SavedToolEnvelope = {
      toolId: row.toolId,
      needsCredentials: fields.credentialHosts.length > 0,
      artifact: toArtifact(fields, manifest),
    };
    registry.registerSaved(envelope);
  }
}

export interface SavedSpawnDeps {
  /** Where `saved/<toolId>` lives. */
  readonly configDir: string;
  /** The Vault's CURRENT toolgen signing pubkey, read by the caller immediately before this call —
   * never cached across spawns, so a Vault key rotation is reflected on the very next spawn. */
  readonly pubkeyB64: string;
  /** The SPAWNING CALLER's session — never a `"saved"` sentinel. A saved tool's global visibility
   * comes from the registry's separate `#saved` collection, not from a value smuggled into this
   * field; smuggling one in here would collide with `forSession`'s ephemeral filter and make the
   * spawned tool's own envelope claim it belongs to exactly one (fictional) session. */
  readonly sessionId: string;
  /** The `generated_tool` row's OWN `approved_at` — never re-derived from `now()` and never read
   * off the artifact, which does not carry it (`approvedAt` is not part of the signed/canonical
   * JSON; see `toolgen-types.ts`'s `ToolgenEnvelope` docstring). A `?? now()`-style fallback here
   * would silently stamp every spawn with the current time and destroy the record of when the
   * owner actually approved persisting this tool. */
  readonly row: { readonly approvedAt: number };
  readonly runtime: { readonly requiredReadPaths: () => readonly string[] };
  /** Injected, not imported, so a test can drive this against the exact same production functions
   * while still tampering with real on-disk bytes between calls — see
   * `toolgen-saved-spawn.test.ts`'s "spawn re-verifies" test, which needs the REAL verifier to
   * prove a boot-time pass and a spawn-time pass are two independent checks. */
  readonly readVerifiedSavedTool: typeof readVerifiedSavedTool;
  readonly savedToolDir: typeof savedToolDir;
  readonly rewriteSavedToolScript: typeof rewriteSavedToolScript;
  /** The PAL-backed launch (`spawnGeneratedTool`, bound to broker + cwd), exactly as
   * `ToolgenGateDeps.spawn` is for the ephemeral create path — injected so a unit test never
   * actually launches a `bun` subprocess. */
  readonly spawn: (envelope: ToolgenEnvelope) => Promise<GeneratedToolHandle>;
}

/**
 * Spawn a saved tool, re-verifying its signature at THIS moment rather than trusting boot
 * reconciliation or `loadSavedToolsIntoRegistry`'s own earlier verify (spec § 7: "the boot pass is
 * a health report for `nimbus tool list`; the spawn check is the gate. A gateway that has been
 * running for a week must not be spawning a body that was verified a week ago.").
 *
 * Order, and why it is this order:
 *
 * 1. Re-verify from disk against the Vault's current pubkey. A failure here refuses with
 *    `ERR_TOOLGEN_SIGNATURE_INVALID` — this is the one gate a saved tool must pass every single
 *    time it runs, unlike boot reconciliation's "health report" pass.
 * 2. Rebuild the CONCRETE manifest from code and assert it against the signed portable shape.
 *    `buildToolSpawnSpec` (`toolgen-client.ts`) passes `envelope.artifact.manifest` straight into
 *    `wrapServerSpec`, and a `PortableToolManifest` (what `readVerifiedSavedTool` returns) has no
 *    `permissions` at all — spawning with THAT would configure the sandbox from `undefined`. A
 *    manifest reconstructed from code is not attacker-influenceable; the assertion proves the
 *    rebuild did not widen anything the owner's signature covers.
 * 3. Re-emit `index.ts` from the VERIFIED body. `index.ts` on disk is never read, hashed or trusted
 *    by this function (or by `readVerifiedSavedTool`, which does not touch it either) — tampering
 *    with it on disk is therefore IRRELEVANT rather than merely detected, because the approved
 *    bytes overwrite it before the tool ever executes.
 * 4. Only now does anything spawn.
 */
export async function spawnSavedTool(
  toolId: string,
  deps: SavedSpawnDeps,
): Promise<GeneratedToolHandle> {
  const verified = await deps.readVerifiedSavedTool(deps.configDir, toolId, deps.pubkeyB64);
  if (!verified.ok) {
    throw new ToolgenError(
      ERR_TOOLGEN_SIGNATURE_INVALID,
      `saved tool "${toolId}" failed verification at spawn: ${verified.reason}`,
    );
  }
  const fields = verified.artifact;

  const dir = deps.savedToolDir(deps.configDir, toolId);
  const runtimeReadPaths = deps.runtime.requiredReadPaths();

  // Rebuild the CONCRETE manifest from code, then prove it still satisfies what was signed.
  // Deliberately NOT `rebuildManifestOrNull` here: a spawn attempt on a NAMED tool has no "skip and
  // continue" fallback the way loading a whole list does, so the shape-mismatch failure must
  // propagate as `ERR_TOOLGEN_MANIFEST_SHAPE_INVALID` rather than resolve to `null`.
  const manifest = buildGeneratedManifest(toolId, { scriptDir: dir, runtimeReadPaths });
  assertConcreteManifestMatches(manifest, fields.manifest, [dir, ...runtimeReadPaths]);

  // Re-emit the derived script from the VERIFIED body — never read index.ts back and trust it.
  const scriptPath = await deps.rewriteSavedToolScript(
    deps.configDir,
    toolId,
    emitToolScript({
      toolId,
      toolName: fields.toolName,
      description: fields.description,
      body: fields.body,
      inputSchema: fields.inputSchema,
    }),
  );

  return deps.spawn({
    artifact: toArtifact(fields, manifest), // concrete manifest, for wrapServerSpec
    sessionId: deps.sessionId, // the CALLER's session — see SavedSpawnDeps's docstring
    scriptPath,
    approvedAt: deps.row.approvedAt, // from generated_tool, never invented
  });
}
