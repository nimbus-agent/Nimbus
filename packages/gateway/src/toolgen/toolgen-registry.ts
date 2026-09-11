import type { GeneratedToolArtifact, ToolgenEnvelope } from "./toolgen-types.ts";

interface Entry {
  readonly envelope: ToolgenEnvelope;
  readonly close: () => Promise<void>;
  terminated: boolean;
}

/**
 * A saved (persisted) generated tool as it lives in the registry's `#saved` collection (spec
 * § 7.2, PR 3 of runtime tool generation).
 *
 * Deliberately NOT a `ToolgenEnvelope`: a saved tool has no live session (it is visible to every
 * session, not scoped to one), no live `scriptPath` (nothing has spawned it yet in this process —
 * `index.ts` is re-derived fresh at spawn time from the verified body, never trusted from a prior
 * write), and no meaningful `approvedAt` on THIS object (that value lives on the `generated_tool`
 * DB row, per `spawnSavedTool`'s docstring — inventing one here to satisfy a shape neither needs
 * nor should have is exactly the "stamp a fake value into a real field" anti-pattern this feature's
 * design review rejected for `sessionId`). Keeping the shape genuinely narrower than
 * `ToolgenEnvelope`, rather than padding it with placeholder fields to reuse that type, is what
 * keeps every field on this object honest.
 *
 * `needsCredentials` is `artifact.credentialHosts.length > 0`, computed by the caller that builds
 * this object (`toolgen-saved-spawn.ts`'s `loadSavedToolsIntoRegistry`) — never by the registry
 * itself, which has no way to know whether a Vault binding exists. It is TRUE for any saved tool
 * with a non-empty `credentialHosts`, unconditionally: spec § 8.2's boot/shutdown Vault sweep is
 * TOTAL, so no saved tool can ever carry a bound credential across a restart, which makes this a
 * static property of the artifact rather than something that needs a live Vault check.
 */
export interface SavedToolEnvelope {
  readonly artifact: GeneratedToolArtifact;
  readonly toolId: string;
  readonly needsCredentials: boolean;
}

/**
 * Ephemeral, session-keyed registry of live generated tools, PLUS the saved (persisted) collection
 * every session can see (spec § 7.2).
 *
 * The ephemeral half (`#byId`) is IN-MEMORY ONLY, and that is the feature: a gateway restart drops
 * every ephemeral generated tool, so "ephemeral for the session" is true by construction rather
 * than by a cleanup job. Same shape as I30's in-memory pairing window. PR 1 adds no schema
 * migration precisely because of this.
 *
 * The saved half (`#saved`) is the OPPOSITE by design: a saved tool survives a restart (it is
 * loaded back in at boot from the signed `saved/<toolId>` store — `loadSavedToolsIntoRegistry`),
 * is visible from EVERY session rather than the one that created it, and does not consume the
 * per-session creation budget (`countForSession` reads `#byId` alone — see its docstring). The two
 * collections are kept SEPARATE rather than merged into one map with an optional discriminator:
 * an optional `sessionId` invites `undefined` to mean "global" to one reader and "unknown" to
 * another, and `ToolgenEnvelope.sessionId` stays required throughout for exactly that reason.
 */
export class ToolgenRegistry {
  readonly #byId = new Map<string, Entry>();
  readonly #saved = new Map<string, SavedToolEnvelope>();

  register(envelope: ToolgenEnvelope, close: () => Promise<void>): void {
    this.#byId.set(envelope.artifact.toolId, { envelope, close, terminated: false });
  }

  get(toolId: string): ToolgenEnvelope | undefined {
    return this.#byId.get(toolId)?.envelope;
  }

  /**
   * The artifact for `toolId`, resolved across BOTH collections — the live ephemeral one first,
   * then the saved one. Deliberately session-independent and shape-independent, unlike `get`
   * (ephemeral only) and `forSession` (session-filtered, and returns the whole envelope union
   * rather than just the artifact): a per-request broker check has no session of its own and does
   * not care which collection currently holds the tool, only what the OWNER signed for it
   * (`toolgen-broker.ts`'s `approvedHostsFor`/`credentialHostsFor`, wired in `platform/assemble.ts`
   * — a live request from a spawned SAVED tool must resolve its approved/credential hosts exactly
   * as reliably as a live ephemeral one does, or every such request is silently refused as though
   * no host were ever approved). `get()` stays ephemeral-only on purpose — see its own docstring —
   * this is the union view a caller that must not care which collection wins should use instead.
   */
  findArtifact(toolId: string): GeneratedToolArtifact | undefined {
    return this.#byId.get(toolId)?.envelope.artifact ?? this.#saved.get(toolId)?.artifact;
  }

  /**
   * Register a saved tool as visible to every session. Idempotent by `toolId` (a re-register, e.g.
   * a resave in a later session, simply replaces the prior entry) — never merged field-by-field,
   * since the artifact is signed as one whole object and a partial merge could mix fields from two
   * different approvals.
   */
  registerSaved(envelope: SavedToolEnvelope): void {
    this.#saved.set(envelope.toolId, envelope);
  }

  /**
   * Evict a saved tool from the in-memory saved collection — the IN-PROCESS half of
   * `toolgen.revoke` for a persisted tool, paired with deleting its `generated_tool` row and its
   * `saved/<toolId>` directory (`ipc/toolgen-rpc.ts`).
   *
   * Deliberately NOT folded into `revoke` below, which closes a live CHILD PROCESS and is async
   * for exactly that reason. A saved tool has no live child to close here: `#saved` holds an
   * approved artifact, not a running thing (`SavedToolEnvelope`'s docstring — no `scriptPath`, no
   * handle). Merging the two would make `revoke` claim to have stopped something it never started,
   * and would give one method two different meanings of "the tool is gone".
   *
   * Returns whether an entry was actually present, so a caller can disclose whether a revoke
   * touched the saved half — never used as a precondition, since revoke must stay idempotent: a
   * tool that is saved-on-disk but absent from this map (it failed verification at load and was
   * skipped, per `loadSavedToolsIntoRegistry`) must still be revocable.
   */
  unregisterSaved(toolId: string): boolean {
    return this.#saved.delete(toolId);
  }

  /** Every saved tool currently loaded, regardless of session. */
  savedTools(): SavedToolEnvelope[] {
    return [...this.#saved.values()];
  }

  /** Ephemeral tools live in THIS session and not terminated — the shared filter both public
   * session-scoped methods below build on. Named for what it excludes as much as what it includes:
   * a terminated tool is not offered to the model as though it still worked, and a tool created in
   * a different session is invisible here (unlike a SAVED tool, which is deliberately global). */
  #liveEphemeralForSession(sessionId: string): ToolgenEnvelope[] {
    return [...this.#byId.values()]
      .filter((e) => !e.terminated && e.envelope.sessionId === sessionId)
      .map((e) => e.envelope);
  }

  /**
   * Every tool visible to `sessionId`: this session's own live ephemeral tools, UNION the saved
   * set (spec § 7.2 — a saved tool is reachable from every session, not just the one that created
   * it). The saved half is appended, never merged by `toolId`, so an ephemeral and a saved tool
   * sharing an id (a resave while the original session is still live) both appear rather than one
   * silently shadowing the other — a real possibility today's assemble.ts wiring does not create,
   * but not one this method should have to assume away.
   */
  forSession(sessionId: string): Array<ToolgenEnvelope | SavedToolEnvelope> {
    return [...this.#liveEphemeralForSession(sessionId), ...this.savedTools()];
  }

  /**
   * Counts LIVE EPHEMERAL tools only — deliberately NOT `forSession(sessionId).length`. That cap
   * (`maxToolsPerSession` in `createGeneratedTool`) bounds how many tools one session may CREATE; a
   * saved tool was created, and individually approved, in some earlier session already. Letting a
   * saved tool consume this budget would mean saving three tools permanently disables tool
   * creation for every future session — the exact bug spec § 7.2 calls out by name.
   */
  countForSession(sessionId: string): number {
    return this.#liveEphemeralForSession(sessionId).length;
  }

  /**
   * The child process exited. The tool is NOT silently restarted: a restart re-runs approved code
   * the owner may reasonably believe stopped, and "it came back on its own" is not a property
   * anyone approved.
   */
  markTerminated(toolId: string): void {
    const entry = this.#byId.get(toolId);
    if (entry !== undefined) entry.terminated = true;
  }

  isTerminated(toolId: string): boolean {
    return this.#byId.get(toolId)?.terminated ?? false;
  }

  async revoke(toolId: string): Promise<void> {
    const entry = this.#byId.get(toolId);
    if (entry === undefined) return;
    this.#byId.delete(toolId);
    await entry.close();
  }

  /** Shutdown drain. One failing close must not strand the remaining child processes. */
  async revokeAll(): Promise<void> {
    const entries = [...this.#byId.values()];
    this.#byId.clear();
    await Promise.allSettled(entries.map((e) => e.close()));
  }
}
