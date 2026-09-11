import type { Database } from "bun:sqlite";
import type { NimbusToolGenerationToml } from "../config/nimbus-toml.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { resolveRuntimeById } from "../exec/exec-runtimes.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { artifactDigest } from "./toolgen-artifact.ts";
import type { GeneratedToolHandle } from "./toolgen-client.ts";
import type { ToolgenApprovalInput } from "./toolgen-consent-broker.ts";
import type { DraftedTool } from "./toolgen-draft.ts";
import type { ToolgenRegistry } from "./toolgen-registry.ts";
import { assertSafeToolId } from "./toolgen-script-store.ts";
import { buildGeneratedManifest, emitToolScript } from "./toolgen-stub.ts";
import {
  type CreateGeneratedToolRequest,
  type DraftSubject,
  type GeneratedToolArtifact,
  type ToolCredentialParam,
  type ToolgenEnvelope,
  ToolgenError,
} from "./toolgen-types.ts";

const CAPABILITY = "tool_generation";
const APPROVAL_TTL_MS = 120_000;

/**
 * Reduce whatever the owner typed to the bare hostname the broker will compare against.
 *
 * The broker matches `url.hostname` EXACTLY (no suffix matching), so an approved entry of
 * `https://api.example.com/v1` would match nothing at all — a tool approved for a host it can
 * never reach. Normalising here rather than at the broker keeps the artifact the owner approved and
 * the value later compared identical.
 *
 * Rejects anything that does not parse as `https:` -- not just an unparseable string. Without this,
 * an input like `unix:///x` parses cleanly (its own scheme, an empty authority) and returns the
 * EMPTY STRING as `hostname`, which sails past the blank-string check above because that check runs
 * on the raw input, not the parsed result. The broker only ever dials `https:`, so any other scheme
 * -- and a parse that yields no hostname at all -- is refused here rather than silently approved for
 * a host it can never reach.
 */
export function normalizeHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") throw new ToolgenError("ERR_TOOLGEN_HOST_NOT_ALLOWED", "empty host");
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new ToolgenError("ERR_TOOLGEN_HOST_NOT_ALLOWED", `unparseable host: ${raw}`);
  }
  if (url.protocol !== "https:" || url.hostname === "") {
    throw new ToolgenError("ERR_TOOLGEN_HOST_NOT_ALLOWED", `only an https host is allowed: ${raw}`);
  }
  return url.hostname;
}

export type { CreateGeneratedToolRequest } from "./toolgen-types.ts";

export interface ToolgenGateDeps {
  readonly db: Database;
  readonly config: NimbusToolGenerationToml;
  readonly enforced?: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined;
  readonly registry: ToolgenRegistry;
  /**
   * `subject` carries the NORMALISED approved hosts and the subset that will hold a credential --
   * names only. It is a second parameter rather than a field of `req` because `req` is the object
   * the drafting prompt is built from, and a `credentials` field there would place raw tokens in a
   * model's context (spec § 9.1).
   */
  readonly draftTool: (
    req: CreateGeneratedToolRequest,
    subject: DraftSubject,
  ) => Promise<DraftedTool>;
  readonly assertConfinement: (
    manifest: ReturnType<typeof buildGeneratedManifest>,
  ) => Promise<void>;
  /** Pure path derivation (Task 11's `toolScriptDir`, bound to the config dir). Touches no disk. */
  readonly scriptDir: (toolId: string) => string;
  readonly writeScript: (toolId: string, source: string) => Promise<string>;
  /** Bound closure over the PAL runner + cwd (Task 12's `spawnGeneratedTool`). */
  readonly spawn: (envelope: ToolgenEnvelope) => Promise<GeneratedToolHandle>;
  readonly requestApproval: (input: ToolgenApprovalInput, ttlMs: number) => Promise<boolean>;
  /**
   * Persist the caller-supplied credentials under the NEW toolId and return the hosts that now have
   * one. Called BEFORE the approval prompt, so `credentialHosts` in the artifact is a real answer to
   * "what will be sent, and where" rather than an always-empty list.
   *
   * This is why credentials are supplied to `nimbus tool create` rather than added afterwards: the
   * toolId does not exist until create runs, so a credential could never be in the Vault at
   * approval time — and adding one to a LIVE tool would change the artifact the owner approved
   * (§ 4.5 puts `credentialHosts` inside the signed/hashed object precisely so that a change
   * invalidates the approval). `nimbus tool credential set` therefore REFUSES a live tool.
   *
   * The RETURN VALUE feeds the artifact and the approval prompt ONLY -- what was actually bound, to
   * disclose "what will be sent". It is NOT what the gate uses to decide what to clean up on a
   * non-registering exit: a real implementation is not required to be atomic (Task 11's is a
   * sequential per-host write loop), so a throw partway through can leave a real Vault write behind
   * with no return value to report it. The gate therefore tracks its own ATTEMPTED host list, set
   * before this is even called, and revokes THAT on cleanup -- see {@link CredentialCleanup}.
   */
  readonly bindCredentials: (
    toolId: string,
    credentials: readonly ToolCredentialParam[],
  ) => Promise<string[]>;
  /**
   * Undo `bindCredentials` for a toolId that will never register.
   *
   * Takes `hosts` rather than looking them up: this runs on paths where the tool was NEVER
   * registered -- an owner denial, or a failure between approval and `registry.register` -- so
   * `registry.get(toolId)` returns `undefined` on exactly the calls that matter, and a lookup would
   * silently delete nothing, leaving the secret in the Vault forever. MUST be idempotent -- called
   * only when `bindCredentials` is known to have been CALLED (not necessarily to have SUCCEEDED --
   * see `bindCredentials`'s docstring), and a real implementation must tolerate being asked to
   * remove a host that was never actually written, since the gate always passes the ATTEMPTED set
   * rather than a confirmed-written one.
   */
  readonly revokeCredentials: (toolId: string, hosts: readonly string[]) => Promise<void>;
  readonly now: () => number;
  readonly newId: () => string;
}

export type ToolgenOutcome =
  | { readonly status: "registered"; readonly toolId: string }
  | { readonly status: "denied" }
  | {
      readonly status: "refused";
      readonly code: string;
      /**
       * The locality of the drafting route that FAILED, present only when the refusal is
       * draft-related (`ERR_TOOLGEN_DRAFT_INVALID`) and a model actually answered. OPTIONAL, not
       * defaulted -- most refusals (disabled/policy/budget/bad host/confinement) are decided
       * before a draft is even attempted and genuinely have no locality to report; forcing a value
       * there would invent one. Diagnostic only -- never part of the artifact the owner approves.
       */
      readonly locality?: "local" | "remote";
    };

type OutcomeTag =
  | "denied_by_owner"
  | "refused_before_consent"
  | "registered"
  | "failed_after_approval";

/**
 * `audit_log.hitl_status` is CHECK-constrained to approved/rejected/not_required, so this
 * capability's outcomes do not map one-to-one. A refusal-before-consent and an owner denial both
 * record `rejected`, told apart by `outcome`. `not_required` is deliberately NEVER used here: on a
 * `tool.generate` row it would read as "a tool was generated without needing approval", the single
 * most dangerous thing an auditor could wrongly conclude.
 */
function audit(
  deps: ToolgenGateDeps,
  hitlStatus: "approved" | "rejected",
  outcome: OutcomeTag,
  payload: Record<string, unknown>,
): void {
  appendAuditEntry(deps.db, {
    actionType: "tool.generate",
    hitlStatus,
    actionJson: JSON.stringify({ outcome, ...payload }),
    timestamp: deps.now(),
  });
}

/**
 * `deps.revokeCredentials` called and its failure swallowed, never propagated.
 *
 * There are two call sites below -- the denial path (inside the main `try`) and the outer `catch`
 * -- and both must go through this rather than calling `deps.revokeCredentials` directly. An
 * unguarded revoke on the denial path that throws would escape into the outer `catch`, which would
 * then see `credentialsBound` still `true` and call `revokeCredentials` again, unguarded -- and if
 * THAT throws too, the exception escapes `createGeneratedTool` entirely and NEITHER `audit()` call
 * ever runs, so the denial (or the post-approval failure) that triggered the revoke in the first
 * place is never recorded at all. A revoke that fails to clean up a Vault entry is a leftover
 * secret worth fixing on its own -- never worth losing the audit row for the outcome that caused
 * it.
 */
async function safeRevokeCredentials(
  deps: ToolgenGateDeps,
  toolId: string,
  hosts: readonly string[],
): Promise<boolean> {
  try {
    await deps.revokeCredentials(toolId, hosts);
    return true;
  } catch {
    // Still swallowed -- see the docstring above: letting this escape would take out the `audit()`
    // call that records the outcome, which is strictly worse than a failed cleanup.
    //
    // But swallowing it SILENTLY meant a bearer token could stay in the Vault under a toolId that
    // never registers with nothing anywhere saying so. The caller now records the failure on the
    // audit row instead, which is what makes it actionable: an operator can find the tool id and
    // remove the key by hand. A durable retry queue would be the fuller answer and is deliberately
    // not built here -- it is a store with its own lifecycle, and this is a leaf cleanup path.
    return false;
  }
}

/**
 * Steps 1-3 of the gate's order: every refusal decidable WITHOUT the owner, and therefore BEFORE
 * the consent prompt, so a capability disabled by config or org policy never advertises its own
 * existence by prompting. Throws; returns nothing.
 *
 * Extracted as one named phase rather than inlined, and invoked first at the call site, so the
 * gate's ordering rule stays readable as an ordered list — never by moving a check somewhere a
 * reader has to go and find.
 */
function assertCreateAllowedBeforeConsent(
  req: CreateGeneratedToolRequest,
  deps: ToolgenGateDeps,
): void {
  // 1. Local kill-switch.
  if (!deps.config.enabled) {
    throw new ToolgenError("ERR_TOOLGEN_DISABLED", "tool generation is disabled");
  }
  // 2. Org policy (I22). An ABSENT accessor refuses fail-closed rather than defaulting to
  //    enabled -- the gap multimodal PR 1 left open and PR 2 closed.
  if (deps.enforced === undefined) {
    throw new ToolgenError("ERR_TOOLGEN_POLICY_DISABLED", "org policy unavailable; refusing");
  }
  if (deps.enforced.capabilitiesDisabled.has(CAPABILITY)) {
    throw new ToolgenError("ERR_TOOLGEN_POLICY_DISABLED", "disabled by org policy");
  }
  // 3. Session budget.
  if (deps.registry.countForSession(req.sessionId) >= deps.config.maxToolsPerSession) {
    throw new ToolgenError(
      "ERR_TOOLGEN_SESSION_BUDGET_EXCEEDED",
      `session already holds ${deps.config.maxToolsPerSession} generated tools`,
    );
  }
}

/** The envelope's host list plus the credential bindings that survive filtering against it. */
type ResolvedEnvelope = {
  readonly hosts: readonly string[];
  readonly forApprovedHosts: readonly ToolCredentialParam[];
  readonly forApprovedHostNames: readonly string[];
};

/**
 * Step 4 of the gate's order, still pre-consent: normalise the requested hosts and filter the
 * supplied credentials down to them.
 *
 * Runs ABOVE the draft: the drafting prompt must name the hosts the broker will actually match,
 * and refusing a malformed host before a model call is even attempted beats refusing after.
 */
function resolveEnvelope(
  req: CreateGeneratedToolRequest,
  credentials: readonly ToolCredentialParam[],
): ResolvedEnvelope {
  // Normalised, not trusted as typed: a user will paste `https://api.example.com/v1` or
  // `api.example.com:443`, and an unnormalised entry would never match the broker's
  // `url.hostname` comparison — silently producing a tool that can reach nothing.
  // Sorted with an EXPLICIT code-point comparator, deliberately not `localeCompare`. This list
  // is rendered verbatim in the owner's approval prompt and stored in the artifact they approve,
  // so the ordering has to be identical on every machine; `localeCompare` is locale-dependent by
  // definition and would let two installs show the same envelope in two different orders. Host
  // names are already lowercased ASCII by `normalizeHost`, so code-point order IS alphabetical
  // here — the comparator makes that a property of the code rather than of the default sort.
  const hosts = [...new Set(req.hosts.map(normalizeHost))].sort(codeUnitCompare);
  if (hosts.length === 0) {
    throw new ToolgenError("ERR_TOOLGEN_HOST_NOT_ALLOWED", "at least one --host is required");
  }
  // Only hosts the owner also granted via --host. The CLI already enforces this, but the gate is
  // the boundary: the prompt and the artifact must never name a host the tool cannot reach.
  //
  // The `host` is REWRITTEN to its normalised form, not merely tested against one. Filtering on
  // `normalizeHost(c.host)` while forwarding `c.host` untouched split one host into two names and
  // broke three things at once, because `normalizeHost` accepts what a user actually types
  // (`https://API.example.com/v1`, `api.example.com:443`) while the Vault key, the approval
  // prompt and the broker each saw a different one of them:
  //   * `bindCredentials` wrote `toolgen.<id>.https://api_pexample_pcom` while
  //     `ToolgenBroker.handleFetch` reads under `url.hostname.toLowerCase()` — the lookup missed
  //     and the tool made UNAUTHENTICATED requests at runtime, after the owner had approved it;
  //   * `credentialHosts` in the artifact and the prompt disagreed with `approvedHosts`, so the
  //     owner approved an envelope that contradicted itself;
  //   * on a DENIAL the revoke targeted a key that was never written, leaving the bearer token in
  //     the Vault under a toolId that will never register — the exact property this gate
  //     otherwise guarantees (a credential bound before consent is revoked on every path that
  //     does not end in registration).
  // One normalised name, everywhere.
  //
  // DE-DUPLICATED by host at the same time, keeping the LAST entry for a repeated host. Two
  // `--credential` entries can name one host after normalisation (`api.example.com=a` and
  // `API.example.com:443=b`), and without this the tool would take two Vault writes for one key
  // and name that host TWICE in the artifact and the approval prompt. LAST rather than first
  // because that is what the Vault would end up holding anyway: `bindCredentials` is a sequential
  // per-host write loop, so the later token overwrites the earlier one. De-duplicating here makes
  // the disclosed list agree with the stored value instead of merely being shorter.
  const byHost = new Map<string, ToolCredentialParam>();
  for (const c of credentials) {
    const host = normalizeHost(c.host);
    if (!hosts.includes(host)) continue;
    byHost.set(host, { host, binding: c.binding });
  }
  const forApprovedHosts = [...byHost.values()];
  // NAMES ONLY -- computed once and reused below both to tell the draft what will be sent, and
  // (after `bindCredentials` is about to be called) as the ATTEMPTED cleanup set. See
  // `CredentialCleanup` for why cleanup needs this rather than `bindCredentials`'s return value.
  // Already unique — `forApprovedHosts` is keyed by host above.
  return { hosts, forApprovedHosts, forApprovedHostNames: forApprovedHosts.map((c) => c.host) };
}

/**
 * What the two non-registering exits (the denial arm and the outer `catch`) need in order to undo
 * a credential bound before consent. ONE mutable record rather than two loose locals, because both
 * arms must read exactly the same state and a per-arm copy is how one of them stops being updated.
 *
 * `bound` means "`bindCredentials` is ABOUT TO BE called", set together with `attemptedHosts`
 * immediately BEFORE the await — not after it resolves. `bindCredentials` is a sequential per-host
 * write loop, so a throw on host B can follow a successful write for host A; unless the flag is
 * already true and `attemptedHosts` already names host A, that secret survives in the Vault
 * forever under a toolId that will never register.
 *
 * `attemptedHosts` is deliberately NOT `bindCredentials`'s return value, which is only observable
 * if the call resolves. `revokeCredentials` is idempotent by its own contract, so revoking a host
 * that was never written — or revoking it twice — is a safe no-op, which makes the ATTEMPTED
 * superset the safe choice for cleanup. The RETURN value stays authoritative for the artifact and
 * the approval prompt, which answer a different question: what will actually be sent.
 */
type CredentialCleanup = {
  bound: boolean;
  attemptedHosts: readonly string[];
};

/** Undo a pre-consent credential bind, if one was attempted. Returns whether the revoke FAILED. */
async function revokeIfBound(
  deps: ToolgenGateDeps,
  toolId: string,
  cleanup: CredentialCleanup,
): Promise<boolean> {
  if (!cleanup.bound) return false;
  return !(await safeRevokeCredentials(deps, toolId, cleanup.attemptedHosts));
}

/**
 * The ONE path from a model-authored body to a registered, callable tool (invariant I39).
 *
 * The ORDER is load-bearing and mirrors `runExecution`: every refusal decidable WITHOUT the owner
 * happens before the consent prompt, so a capability disabled by config or org policy never
 * advertises its own existence by prompting, and the sandbox posture is proven before the owner is
 * asked to approve something that could not have been confined.
 */
export async function createGeneratedTool(
  req: CreateGeneratedToolRequest,
  deps: ToolgenGateDeps,
  // A SEPARATE parameter, never a field of `req`: the gate hands `req` straight to `draftTool`, so
  // a `credentials` field there would place raw tokens on the drafting prompt's input, and a secret
  // in a remote model's context has left the machine (spec § 9.1).
  credentials: readonly ToolCredentialParam[] = [],
): Promise<ToolgenOutcome> {
  const toolId = deps.newId();
  let approved = false;
  // Function-scoped, not `const` inside the `try`, so BOTH non-registering exits below can read it
  // (Task 9 controller ruling 3 -- never looked up from `registry.get(toolId)`, which returns
  // `undefined` on exactly the calls that matter). See {@link CredentialCleanup}.
  const cleanup: CredentialCleanup = { bound: false, attemptedHosts: [] };
  // The hosts `bindCredentials` actually reports as bound -- its own return value. Authoritative
  // for the ARTIFACT and the approval prompt (disclosing what will actually be sent), which is a
  // DIFFERENT question from what needs cleaning up on a non-registering exit.
  let credentialHosts: readonly string[] = [];
  try {
    // The id is minted by the gateway, never supplied by a caller -- but it is validated anyway,
    // because it is interpolated into a filesystem path AND into a `//` comment in the emitted
    // script (`toolgen-stub.ts`). Asserted here rather than left to depend on `scriptDir` happening
    // to run first, so a bad `newId` is refused before anything -- including approval -- happens.
    assertSafeToolId(toolId);

    // 1-3. Every refusal decidable without the owner, before the consent prompt.
    assertCreateAllowedBeforeConsent(req, deps);

    // 4. Normalise the requested hosts and filter the credentials down to them. Still pre-consent,
    //    so the gate's ordering rule is untouched.
    const { hosts, forApprovedHosts, forApprovedHostNames } = resolveEnvelope(req, credentials);

    // 5. Draft, then build the manifest -- network EMPTY by construction.
    const draft = await deps.draftTool(req, {
      hosts,
      // NAMES the credentials will be bound under, derived from `forApprovedHosts` rather than
      // from the Vault -- nothing has been written there yet at this point, since `bindCredentials`
      // runs after drafting.
      credentialHosts: forApprovedHostNames,
    });
    const body = draft.body;
    // The script DIRECTORY is derived before the manifest so the manifest can grant read to it.
    // Deriving the path touches no disk; the CONFINEMENT step at 6 then does — `mkdir`ing this
    // directory EMPTY (and the runtime read paths), because the Windows AppContainer helper's ACL
    // grant fails closed on a path that does not exist yet. What still holds, and is the property
    // that matters, is that no CONTENT reaches disk before the owner approves: the tool BODY is
    // written at step 9 and nowhere earlier. See `assertToolConfinement`'s docstring.
    //
    // The interpreter's OWN read paths must be granted too, not just the script directory: on
    // Windows the AppContainer helper writes one ACE per granted path, so an interpreter outside
    // every grant is simply unreadable and the child dies at exit 68 -- no stdout, no stderr, before
    // running a line (`exec/exec-runtimes.ts`'s `requiredReadPaths` doc; `exec-gate.ts` grants the
    // same for the same reason). Every generated tool runs on bun (`toolgen-client.ts` always
    // launches via `process.execPath`), so the runtime is resolved by fixed id, not derived from the
    // request.
    const runtime = resolveRuntimeById("bun");
    const manifest = buildGeneratedManifest(toolId, {
      scriptDir: deps.scriptDir(toolId),
      runtimeReadPaths: runtime.requiredReadPaths(),
    });
    // 6. Prove confinement on THIS machine, still before consent.
    await deps.assertConfinement(manifest);

    // 7. Bind credentials, still before consent. `attemptedCredentialHosts`/`credentialsBound` are
    //    set BEFORE the await -- see their declarations above -- so a throw partway through this
    //    call (a real possibility once Task 11 wires a sequential write loop) still leaves an
    //    accurate cleanup set behind for the outer `catch`. `bindCredentials`'s RETURN stays
    //    authoritative for the artifact: it reports what a write actually succeeded for, which the
    //    pre-draft `forApprovedHosts` list cannot -- a different question from what to clean up.
    cleanup.attemptedHosts = forApprovedHostNames;
    cleanup.bound = true;
    credentialHosts = await deps.bindCredentials(toolId, forApprovedHosts);
    const artifact: GeneratedToolArtifact = {
      toolId,
      toolName: `generated_${toolId}`,
      description: req.description,
      body,
      approvedHosts: hosts,
      credentialHosts,
      manifest,
      inputSchema: draft.inputSchema,
    };

    // 8. Owner approves the VERBATIM artifact.
    approved = await deps.requestApproval(
      {
        toolId,
        toolName: artifact.toolName,
        description: artifact.description,
        body: artifact.body,
        approvedHosts: hosts,
        credentialHosts,
        inputSchema: artifact.inputSchema,
        grounding: draft.grounding,
        initiator: "owner",
      },
      APPROVAL_TTL_MS,
    );
    if (!approved) {
      // A denial must not leave a credential behind under a toolId nothing will ever call again.
      // Guarded via `safeRevokeCredentials` -- see its docstring for why an unguarded revoke here
      // could take out the `audit()` call below with it. Revokes the ATTEMPTED set, not
      // `bindCredentials`'s return value -- see {@link CredentialCleanup}.
      const revokeFailed = await revokeIfBound(deps, toolId, cleanup);
      audit(deps, "rejected", "denied_by_owner", {
        // Only present when TRUE, so its absence is not read as a claim that cleanup succeeded on
        // a run where nothing was bound. When present it means a bearer token may still sit in the
        // Vault under this toolId and wants removing by hand.
        ...(revokeFailed ? { credentialRevokeFailed: true } : {}),
        toolId,
        body,
        hosts,
        // Present on a DENIAL too, not only on `registered`. This is the row an auditor reads to
        // answer "was a secret written for a tool that never registered?" — and since
        // `bindCredentials` runs at step 7, BEFORE consent, the answer can be yes. The revoke above
        // is what undoes it; this field is what makes the attempt visible if the revoke failed
        // (it is swallowed by `safeRevokeCredentials` by design). Harmless to omit while binding
        // was a no-op stub; not harmless now.
        credentialHosts: cleanup.attemptedHosts,
        draftAttempts: draft.attempts,
        draftGrounding: draft.grounding,
        draftLocality: draft.locality,
      });
      return { status: "denied" };
    }

    // 9. Only now does anything reach the filesystem or spawn.
    const scriptPath = await deps.writeScript(toolId, emitToolScript(artifact));
    const envelope: ToolgenEnvelope = {
      artifact,
      sessionId: req.sessionId,
      scriptPath,
      approvedAt: deps.now(),
    };
    const handle = await deps.spawn(envelope);
    deps.registry.register(envelope, () => handle.close());

    audit(deps, "approved", "registered", {
      toolId,
      body,
      hosts,
      credentialHosts,
      artifactDigest: artifactDigest(artifact),
      draftAttempts: draft.attempts,
      draftGrounding: draft.grounding,
      draftLocality: draft.locality,
    });
    return { status: "registered", toolId };
  } catch (err) {
    // Reaches here on THREE kinds of failure, not just a post-approval one: a pre-consent refusal
    // (nothing bound, `credentialsBound` still `false`, nothing to revoke), a `bindCredentials`
    // throw itself (bound flag and attempted set were set BEFORE that await -- see their
    // declarations above -- so a partial write from a sequential bind loop is still revoked even
    // though this `catch` runs before `credentialHosts` -- the return value -- was ever assigned),
    // and a post-approval `writeScript`/`spawn` throw, whose toolId is dead the same way a denial's
    // is. All three clean up the same way, against the ATTEMPTED set. Guarded for the identical
    // reason as the denial path above: this IS the outer catch, so an unguarded revoke failure here
    // would escape `createGeneratedTool` outright and neither `audit()` call below would ever run.
    const revokeFailed = await revokeIfBound(deps, toolId, cleanup);
    const code = err instanceof ToolgenError ? err.code : "ERR_TOOLGEN_INTERNAL";
    // Present only when the caught error is a `ToolgenError` that actually carried one (today,
    // only `ERR_TOOLGEN_DRAFT_INVALID` does) -- diagnostic about which route FAILED, never part of
    // the artifact the owner approves. Omitted from the outcome entirely rather than sent as
    // `undefined`, matching every other optional field on `ToolgenOutcome`.
    const locality = err instanceof ToolgenError ? err.locality : undefined;
    // An owner-approved attempt that then failed is recorded as APPROVED, because it was: the owner
    // saw and consented to the verbatim body, and a process may already have spawned. Only a
    // pre-consent failure may claim the owner never saw it -- conflating the two would let an
    // auditor filtering `hitl_status='approved'` on `tool.generate` miss a run the owner actually
    // approved (mirrors `exec-gate.ts`'s `approvedAt` sentinel and its identical reasoning).
    if (approved) {
      audit(deps, "approved", "failed_after_approval", {
        // See the denial arm: present ONLY when a bound credential failed to revoke, so an
        // operator can find the toolId and remove the key by hand.
        ...(revokeFailed ? { credentialRevokeFailed: true } : {}),
        toolId,
        code,
        message: (err as Error).message,
      });
    } else {
      audit(deps, "rejected", "refused_before_consent", {
        // See the denial arm: present ONLY when a bound credential failed to revoke, so an
        // operator can find the toolId and remove the key by hand.
        ...(revokeFailed ? { credentialRevokeFailed: true } : {}),
        toolId,
        code,
        message: (err as Error).message,
      });
    }
    return locality === undefined
      ? { status: "refused", code }
      : { status: "refused", code, locality };
  }
}
