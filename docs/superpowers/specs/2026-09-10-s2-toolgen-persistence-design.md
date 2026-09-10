# S2 — Runtime Tool Generation, PR 3: persistence + signing

- **Date:** 2026-09-10
- **Spine slot:** S2 — Local Compute Fleet, the runtime-tool-generation row
- **Parent spec:** [`2026-09-09-s2-runtime-tool-generation-design.md`](./2026-09-09-s2-runtime-tool-generation-design.md)
- **Sibling spec:** [`2026-09-09-s2-toolgen-drafting-design.md`](./2026-09-09-s2-toolgen-drafting-design.md)
- **Status:** designed, not implemented
- **Reserves:** invariant **I40**, static rule **D29(d)**, schema **V61**, HITL action type `tool.save`

---

## 0. Reading note: this spec corrects its parent

The parent spec recorded a direction for PR 3 and flagged one premise as unverified. That premise
was checked before this design was written, and **it does not hold**. Two of the parent's PR 3
paragraphs are superseded here — § 2 corrects the stated reason for signing, and § 3 corrects the
storage shape. Where this document and the parent disagree, this one is current.

The parent also assigned agent-initiated tool proposal to PR 2. **It did not ship.** § 12 re-ledgers
the delivery split rather than letting the gap close silently.

---

## 1. Goal

`nimbus tool save <tool-id>` promotes a live, session-scoped generated tool to a durable one: the
approved body, its input schema and its approved destinations survive a gateway restart, and the
tool is available in later sessions without the owner re-approving it.

That last clause is the whole point and the whole risk. It is the first **standing approval** in the
codebase — I33's exec gate says in terms that standing approvals are unsupported — so this design
spends most of its length on what bounds it.

**Two properties bound it, and they are separable:**

1. **The artifact is bound to bytes the owner saw.** A standing approval is only safe if the thing
   still standing is the thing approved. An Ed25519 signature over the canonical artifact, verified
   against a Vault-held public key, is what makes that checkable across time.
2. **Nothing standing holds a secret.** The approval persists; the credential does not. A saved tool
   wakes up with its code and its destinations intact and its credentials gone.

Property 2 was a deliberate choice over the more convenient alternative, and § 8 records why.

---

## 2. Why sign — the parent's reason was wrong

The parent spec justified signing like this:

> Either it installs unsigned like a local dev extension — meaning nothing detects on-disk tampering
> between sessions — or the owner gets a signing key and saved tools are signed locally.

**The first horn is false.** `extensions/verify-extensions.ts`'s `runHashVerification` runs on
*every* enabled extension, publisher or not: it re-reads the on-disk manifest and entry bytes,
compares them constant-time (I10) against `manifest_hash` / `entry_hash` on the `extension` row, and
disables the extension on mismatch. Only the *signature* pass skips unsigned installs —
`computeRowSignatureReason` returns `"skip"` when `manifest.publisher` is undefined. On-disk
tampering between sessions is already detected for unsigned extensions today.

So "nothing detects tampering" is not the gap. **The real gap is narrower, and it is the one worth
stating:**

> Hash verification trusts the database. A signature trusts only the Vault.

The expected hash lives in `nimbus.db`. An attacker with filesystem write access holds both the
extension body and the database, so they rewrite the body and its expected hash in one move and the
hash pass reports green. Forging an Ed25519 signature instead requires the private seed, which lives
in DPAPI / Keychain / libsecret and not on the filesystem.

**Residual, stated in the invariant rather than a footnote: this defends the filesystem-write
attacker, not the Vault-read attacker.** An attacker who can read the Vault has already won, and
I40 must not be written as though it says otherwise. This distinction is the entire value of the
mechanism, and a docs entry that overstates it would be the same failure the air-gap claim was.

---

## 3. Storage — its own store, not the extension system

The parent recorded: write under `<configDir>/extensions/local.<toolId>/` and teach
`verify-extensions.ts` to verify `local.*` against a local pubkey. **Rejected**, on two facts in the
tree:

1. `sweepOrphanActiveDirsBestEffort` deletes any directory under the extensions root that has no
   `extension` row. A saved tool living there needs a real row — which enlists it in the entire
   extension lifecycle: the `extension_dependency` graph and `completenessGuard`,
   `hardDisablePreT2Extensions`, auto-update `_prev` crash recovery, the registry client, and the
   mesh client. A generated tool uses none of it.
2. `toolgen/toolgen-script-store.ts` is already namespaced `toolgen/ephemeral/<toolId>`, and
   `removeAllToolScripts` clears only `ephemeral`. The store was built with a sibling in mind.

**Shape:**

```text
<configDir>/toolgen/
  ephemeral/<toolId>/index.ts        # unchanged, wiped at shutdown
  saved/<toolId>/
    index.ts        # the approved body, 0o600
    artifact.json   # the canonical artifact
    artifact.sig    # base64 Ed25519 over canonicalArtifactBytes(artifact)
```

New file `toolgen/toolgen-saved-store.ts`. `assertSafeToolId` is shared from the existing store — a
saved tool id is interpolated into a path exactly as an ephemeral one is.

Shutdown needs **no change** to leave saved tools alone: `removeAllToolScripts` already targets
`ephemeral` specifically. That is worth asserting in a test rather than relying on, because a later
"simplification" to wipe `toolgen/` wholesale would delete every saved tool with no error.

Saved tools inherit I16's **property** and none of its **machinery**.

### 3.1 The signed manifest cannot contain machine-derived paths

**A blocker the first draft missed, and the reason its obvious fix is also wrong.**

`buildGeneratedManifest` writes `opts.scriptDir` into `permissions.filesystem.read`, and
`canonicalArtifactBytes` covers `artifact.manifest`. So an artifact signed at save time carries a
read grant naming `toolgen/ephemeral/<toolId>` — a directory that is wiped at shutdown. A saved tool
spawning from `saved/<toolId>` would be granted read on the empty ephemeral path and **denied read
on its own body**: an immediate failure under Windows AppContainer, and a path simply not mounted
into the namespace under Linux `bwrap`.

The obvious fix is to rebuild the manifest against the saved directory before signing. **That fails
too, for a reason that only shows up one level down.** `requiredReadPaths()` returns
`dirname(process.execPath)` — the *Bun binary's* directory — and on macOS its parent as well. So a
signed manifest is not merely session-specific, it is **machine- and platform-specific**, and it
breaks on events that are not attacks at all:

- a Bun upgrade that installs to a versioned or relocated path,
- moving the config directory, or running the compiled binary rather than dev Bun,
- the same artifact evaluated on macOS versus Linux (two read paths versus one).

Signing that would mean a routine runtime upgrade silently disables every saved tool, reporting a
signature mismatch — a **tampering warning for an event that is not tampering**. § 4 already argues
that conflating those two destroys the owner's trust in the next real warning; this would be the
same error with a much more common trigger.

**Resolution: machine-derived absolute paths are not signed. The manifest is reconstructed at spawn
and checked against the signed shape.**

- The canonical artifact carries the manifest's **portable security shape**: `network` is empty, and
  the filesystem read set is expressible as *own script directory ∪ runtime read paths*. No resolved
  absolute string enters the signature.
- At spawn, `buildGeneratedManifest` builds the concrete manifest from the tool id, the store
  directory actually in use (`ephemeral` or `saved`), and the live `runtime.requiredReadPaths()`.
- The spawn path then **asserts the reconstructed manifest satisfies the signed shape** — network
  empty, read set a subset of own-dir ∪ runtime paths — and refuses otherwise.

This is *stronger* than signing the concrete manifest, not a relaxation. A reconstructed manifest is
built from code and is not attacker-influenceable at all; a signed one is a value read back from
disk, which is the thing an attacker touches. The signature's job is to bind the **body, the schema
and the destinations** — the things a human actually evaluated. It was never able to bind an
absolute path to anything meaningful.

**This is the last cheap moment to change `canonicalArtifactBytes`.** Ephemeral tools do not survive
a restart, so no stored artifact exists to invalidate and no migration is owed; the only digests
affected are historical audit rows, which are records of past events and are not re-verified. Once
PR 3 ships, signed artifacts exist on disk and this function's output is frozen by compatibility.
Make the change here or accept it permanently.

---

## 4. Schema V61 — `generated_tool`

```sql
CREATE TABLE generated_tool (
  tool_id          TEXT PRIMARY KEY,
  tool_name        TEXT NOT NULL,
  description      TEXT NOT NULL,
  artifact_json    TEXT NOT NULL,
  artifact_digest  TEXT NOT NULL,
  signature        TEXT NOT NULL,
  pubkey           TEXT NOT NULL,
  approved_at      INTEGER NOT NULL,
  saved_at         INTEGER NOT NULL,
  last_loaded_at   INTEGER,
  disabled_reason  TEXT
);
```

**Authority splits on two axes, and conflating them is what the first draft got wrong.**

- **Existence — the row governs.** A `generated_tool` row *is* the record that an owner approved
  persistence. A directory under `saved/` with no row is an orphan and is **swept**, exactly as
  `sweepOrphanActiveDirsBestEffort` sweeps an extensions-root directory with no `extension` row. It
  is never adopted.
- **Content — disk plus signature governs.** For a tool that does have a row, the verified on-disk
  artifact is the truth about what the tool *is*. If the row's cached digest disagrees with the
  verified artifact, the disk wins and the row's cached fields are repaired — never the reverse. The
  convenient direction is the wrong one, and whoever later optimises a slow `tool list` is exactly
  the reader who would invert it.

**Why existence is not disk-governed**, though adopting a validly-signed orphan directory looks
harmless: a signature proves the artifact was approved *once*, never that it is approved *now*.
Adopting orphans would let a restored backup, or a directory an owner deliberately revoked and an
attacker kept a copy of, silently re-register a standing execution capability. Revocation deletes the
row and the directory together; if only the directory comes back, the correct reading is that it
should not be there.

The cost is stated: **if the database is lost, every saved tool is swept.** That is data loss and it
is the right posture — the record of approval is what was lost, so the approval is gone with it, and
the owner re-saves. Fail-closed beats resurrecting standing capabilities from files.

`pubkey` is stored per row so a Vault key rotation is reported as its own `disabled_reason`
(`pubkey_rotated`) rather than presenting as tampering. Those are different events, and an owner
told "your tool was tampered with" when their keychain was actually reset will not trust the next
warning.

`disabled_reason` NULL means healthy. Values: `signature_mismatch`, `signature_missing`,
`artifact_missing`, `body_missing`, `pubkey_rotated`, `pubkey_unavailable`.

---

## 5. Keypair

`toolgen/toolgen-keypair.ts`, following `share/share-keypair.ts` closely enough that the differences
are the interesting part and nothing else:

```ts
export const TOOLGEN_SIGNING_PRIVKEY = "toolgen.signing.privkey";
export const TOOLGEN_SIGNING_PUBKEY  = "toolgen.signing.pubkey";
export async function ensureToolgenKeypair(vault: NimbusVault):
  Promise<{ privkeyB64: string; pubkeyB64: string }>;
```

Generate-on-first-use, with `share-keypair.ts`'s `isMatchingKeypair` consistency guard: a
partially-rotated Vault holding a privkey from one keypair beside a pubkey from another would sign
artifacts that verification then rejects, which reads as tampering on a machine where nothing was
tampered with. Both keys join `PLATFORM_VAULT_KEYS`.

**D29(c) interaction.** That rule confines composition of the `toolgen.` Vault prefix to
`toolgen-credentials.ts`. `toolgen-keypair.ts` needs an allow-list entry, and the entry is *stronger*
than the one it sits beside: the credential keys are composed dynamically
(`toolgen.<toolId>.<hostSlug>`) so the literal scan cannot see them and capability confinement is
the real defense, whereas these two are static literals the scan genuinely covers. The allow-list
comment should say so rather than implying the two entries mean the same thing.

**The private seed never leaves the Vault**, is never returned over IPC or HTTP, never written to a
DB column, and never logged — the `share-keypair.ts` contract verbatim.

---

## 6. The save gate — ordered, refusals before consent

`toolgen/toolgen-save-gate.ts`'s `saveGeneratedTool()`, in this order:

1. **Refuse when the capability is off** — `[tool_generation] enabled` false, or `tool_generation`
   in the resolved org policy's `capabilitiesDisabled` (I22, read through `EnforcedPolicy` and never
   raw policy TOML). **Before consent**, so a disabled capability never advertises itself by
   prompting. Refuse fail-closed when the accessor is absent, matching `media.understand`.
2. **Refuse when the id does not name a live, non-terminated session tool.** Saving a terminated
   tool would resurrect code the owner may reasonably believe stopped — the property
   `ToolgenRegistry.markTerminated`'s docstring already protects, extended one hop.
3. **Take the artifact from the registry envelope, never re-derived from disk.** I33's read-once
   rule one hop on: re-reading at save time is a TOCTOU that defeats the gate, since the human is
   the boundary here.
4. **Derive the portable artifact** (§ 3.1) — strip machine-derived absolute paths, retaining the
   manifest's security shape. This happens *before* the prompt, so the bytes the owner approves are
   the bytes that get signed, with no step in between.
5. **Obtain the owner's approval** of the verbatim artifact plus the persistence fact, via a new
   `tool.save` HITL action type joining `HITL_REQUIRED_BACKING` (I2's frozen set,
   `engine/executor.ts`). Fail-closed on TTL.
6. **Sign, write, insert** — `ensureToolgenKeypair`, sign `canonicalArtifactBytes(artifact)`, write
   the three files, insert the row.
7. **Audit** one `tool.save` row carrying the digest, on every outcome.

**Already saved?** `saveGeneratedTool` is idempotent when the derived artifact's digest matches the
stored one: it returns `already_saved` and does **not** re-prompt, since nothing new is being
consented to. When the digest differs — the owner revised the tool in this session — it is a fresh
save and **does** prompt, because the standing approval would otherwise widen to bytes nobody
approved.

**The running child is left alone.** Promoting a live tool does not kill or restart its process: it
keeps running from `ephemeral/<toolId>` for the rest of the session, and `saved/<toolId>` is what
subsequent sessions spawn from. Killing a working tool as a side effect of saving it would be a
surprising cost for an action the owner framed as preservation.

A denied or timed-out approval writes nothing: no files, no row.

### 6.1 Why the save needs its own approval

This is the design's main friction cost and it is not negotiable.

At create time the owner approved **"run this now"** — a specific body, against specific hosts,
inside one session, with the gateway they are sitting in front of. Persistence is a *new fact about
the same bytes*: **"run this in every future session, without being asked again."** Nobody consented
to that at create time, because at create time it was not on offer.

Re-using the create approval would make `nimbus tool save` a privilege escalation that requires no
privilege — the owner's earlier yes, silently re-scoped. The prompt therefore states the persistence
explicitly, and carries forward I39's residual (1), which becomes materially more important once the
grant is standing:

> An approved host may receive anything this tool can compute, including data it legitimately read.
> This approval proves you saw the body and the destinations. It does not prove the body is honest
> about what it does with what it reads.

---

## 7. Load — lazy, verify-first

**Startup verifies; it does not spawn.** `verifySavedToolsAtStartup` walks the rows, re-reads each
artifact from disk, recomputes `canonicalArtifactBytes`, verifies the signature against the Vault
pubkey, and writes `disabled_reason` on failure. N saved tools must never mean N child processes at
login — that is a resource cost the owner did not approve either, and a crash loop in one tool would
become a boot problem.

**Spawn re-verifies.** On first use in a session the tool spawns through PR 1's existing path
(`toolgen-confinement`, `buildGeneratedManifest` with `permissions.network: []` by construction, the
broker envelope), and the signature is checked **again** at that moment rather than trusted from the
boot pass. The boot pass is a health report for `nimbus tool list`; the spawn check is the gate. A
gateway that has been running for a week must not be spawning a body that was verified a week ago.

**Spawn re-checks the manifest shape too** (§ 3.1): the reconstructed manifest must have empty
`network` and a read set within own-dir ∪ runtime paths, or the spawn refuses. That check is what
makes reconstruction safe rather than merely convenient.

A saved tool that fails verification is **not offered to the model at all** — the `{}` shape
`buildGeneratedTools` already uses for an empty session, not a registered tool that errors when
called.

### 7.1 Boot reconciliation is one-directional, plus an orphan sweep

Per § 4's split:

1. **Row pass.** For every `generated_tool` row, check the three files, verify, and write
   `disabled_reason` on failure. This is the health report.
2. **Orphan sweep.** Every directory under `saved/` with no row is removed. It is **not** adopted,
   for the reason § 4 gives: a valid signature proves the artifact was approved once, never that it
   is approved now.

There is deliberately no disk-to-database adoption pass. `cu-boot-reconcile.ts` is the shape to
follow — it closes rows orphaned by a previous process; it does not invent rows from residue.

### 7.2 Saved tools are visible to every session, and cost no session budget

`ToolgenRegistry` is session-scoped today: `forSession` filters on `sessionId`, and
`countForSession` feeds the `maxToolsPerSession` check in `createGeneratedTool`. Both need care.

- **Visibility.** A saved tool must be reachable from every session — a later CLI run
  (`CLI_TOOLGEN_SESSION_ID`), an agent session with a fresh UUID, a fleet job. `forSession` returns
  the session's ephemeral tools **∪** the saved set.
- **Budget.** Saved tools **do not** count toward `maxToolsPerSession`. That cap exists to bound how
  many tools one session may *create*; a saved tool was created — and individually approved — in
  some earlier session. Letting saved tools consume the cap would mean saving three tools
  permanently disables tool creation.

**Not by making `sessionId` optional.** The reviewer's sketch weakens a currently-required field, and
an optional discriminator invites `undefined` to mean "global" in one reader and "unknown" in
another. The saved set is a **separate collection** on the registry with its own accessors; the
union happens in `forSession`, and `countForSession` keeps reading the ephemeral map alone. Ephemeral
tools keep their required `sessionId` and their existing type.

---

## 8. Credentials — the leak, and the line this design draws

### 8.1 A pre-existing leak, found while designing this

**An ephemeral tool's credential is durable.** `toolgen.revoke` drops two halves — the live child and
the on-disk body — and its comment says "BOTH halves, always." The Vault binding is a third half
nobody drops: `revokeCredentials` is reached only on the gate's *failure* path, before registration.
Shutdown (`gateway-main.ts`) drains the registry and wipes `toolgen/ephemeral/`, and sweeps no Vault
key at all.

So today: create a session-scoped tool, give it a bearer token, then revoke it or restart — the tool
is gone and `toolgen.<toolId>.<hostSlug>` remains in the keychain indefinitely, keyed to a tool id
nothing will ever call again. **The capability is ephemeral by construction; the secret it was
handed is not.** That is a shipped defect in PR 1/2, not a new risk introduced here.

It is fixed in this PR rather than filed, because PR 3 *inverts* the requirement — a persisted tool
is the case where keeping a credential would be intentional — and the two lifecycles must be
distinguishable in the Vault rather than accidentally identical.

### 8.2 The fix

`VaultLister.listKeys(prefix?)` exists, so the sweep is exhaustive rather than derived from live
registry state, and it therefore also clears orphans left by an earlier crash:

- `toolgen.revoke` deletes every `toolgen.<toolId>.<host>` binding for that tool.
- Shutdown sweeps `listKeys("toolgen.")`, retaining only `toolgen.signing.*`.
- Boot sweeps the same way before anything loads, catching what a crash left behind.

**The sweep is total, and § 8.3 is why.** Because no saved tool carries a credential across
sessions, there is no "keep the saved ones" set to compute — every `toolgen.<toolId>.<host>` key is
deleted at shutdown and again at boot, with `toolgen.signing.*` the only retained prefix. Implement
it as the unconditional sweep it is: a selective version would need to join Vault keys against
`generated_tool` rows, which is both more code and a place for a saved tool's credential to survive
a restart in contradiction of the invariant.

### 8.3 A saved tool carries no credential

The decision, and it is the stronger of the two available:

> The approval persists. The secret does not.

A saved tool's `credentialHosts` — already inside the signed artifact — records which hosts *will*
carry a credential. On load with nothing bound, the tool lists as `needs-credentials`, and the broker
**refuses** requests to those hosts rather than sending them uncredentialed. Sending an
uncredentialed request "just in case" would leak the request itself to a host expecting
authentication and would make the failure mode a silent 401 instead of a stated refusal.

**That refusal does not exist today and must be built** — the first draft asserted it as though it
did. `ToolgenBroker.handleFetch` currently ends its credential step with
`if (binding !== null) applyCredential(headers, binding);`, so a `null` binding — an unbound host, or
one whose key the sweep removed — falls through to an **unauthenticated outbound request**. Under the
§ 8.3 rule that becomes reachable on every restart rather than being a corner case, so it is a
security fix this PR owes, not a nicety:

- `ToolgenBrokerDeps` gains `credentialHostsFor: (toolId: string) => readonly string[]`, resolved
  from the signed artifact rather than from anything the tool supplies.
- `handleFetch` refuses with `ERR_TOOLGEN_CREDENTIAL_REQUIRED` when the host is in that set and the
  binding is `null`, naming the `nimbus tool credential set` command that fixes it.
- The refusal appends a `blocked` `tool`-class egress row before returning, matching how I39 already
  treats a refused host — a refusal is an attempted egress and is recorded as one.

Note the asymmetry, which is deliberate: a host **not** in `credentialHosts` and with no binding is
uncredentialed *by design* and proceeds. The refusal covers hosts the owner was told would carry a
credential.

`nimbus tool credential set <toolId> <host> --bearer|--header|--basic` becomes real. It is currently
a permanent refusal stub whose argument parser already exists, so making it real also puts the
`header` and `basic` bindings on a user-facing path for the first time and closes that stated
roadmap gap in the same change.

**Binding a credential for a host not in the signed `credentialHosts` is refused.** That host set is
covered by `artifactDigest`, so admitting a new one would change what the owner approved while the
signature still verified against the old set — the standing approval quietly widening. The correct
path for a tool that needs a new credentialed host is a fresh create and a fresh approval.

### 8.4 What this costs, stated plainly

A saved tool with credentialed hosts is **inert after every restart** until the owner re-binds. For
the credentialed case this removes much of the convenience that motivates saving at all. That cost
was accepted deliberately over the alternative — a standing approval that also holds a standing
secret, i.e. a durable, unattended capability to spend a real credential against a real host with no
human in the loop at any point after the first. The uncredentialed case (a public API, an internal
service on an approved host) keeps the full benefit.

---

## 9. Surface

**IPC** — `toolgen.save`; `toolgen.list` widened to include saved tools with their state. The
`toolgen` namespace stays **LAN-forbidden** and **absent from the Tauri allowlist**, unchanged from
PR 1. Neither addition changes that, and the `ALLOWED_METHODS` count assertion must not move.

**CLI** —

```text
nimbus tool save <tool-id>
nimbus tool list [--json]              # saved | ephemeral, plus health / needs-credentials
nimbus tool revoke <tool-id>           # now drops all three halves, saved or ephemeral
nimbus tool credential set <tool-id> <host> --bearer <t> | --header <n>=<v> | --basic <u>:<p>
```

**Config** — no new keys. `[tool_generation] enabled` continues to gate the whole capability, and a
saved tool does not load when it is false. Deliberately no `[tool_generation] max_saved_tools`: a cap
whose only enforcement is a refusal at save time adds a knob without adding a property, and every
saved tool has passed an individual HITL approval already.

**Error codes** —

| Code | Raised when |
| --- | --- |
| `ERR_TOOLGEN_SAVE_DISABLED` | capability off by config or org policy |
| `ERR_TOOLGEN_SAVE_NOT_LIVE` | the id is not an active, non-terminated tool |
| `ERR_TOOLGEN_SAVE_DENIED` | the owner rejected the `tool.save` prompt |
| `ERR_TOOLGEN_SIGNATURE_INVALID` | signature mismatch at load or spawn |
| `ERR_TOOLGEN_MANIFEST_SHAPE_INVALID` | reconstructed manifest violates the signed shape (§ 3.1) |
| `ERR_TOOLGEN_CREDENTIAL_REQUIRED` | fetch to a `credentialHosts` host with no binding (§ 8.3) |
| `ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN` | binding attempted for a host outside `credentialHosts` |

---

## 10. Invariant I40 and static rule D29(d)

**I40 (draft).** *A saved generated tool loads in a later session only when its on-disk artifact
verifies by Ed25519 against a Vault-held public key this gateway minted; a mismatch, a missing
signature or a rotated key refuses fail-closed — the tool does not load and is never offered to the
model. The signature covers the canonical artifact (`toolgen-artifact.ts`'s `canonicalArtifactBytes`
— body, input schema, approved hosts, credential hosts), so any change to what the owner approved
invalidates the standing approval and forces a fresh one; verification happens at boot as a health
report AND again at spawn as the gate, so a long-running gateway never spawns a body it verified long
ago. Persistence itself is consented to separately from execution, via the `tool.save` HITL action
type (I2 frozen set) — the create-time approval covers running the tool now, never running it in
every future session. A saved tool carries no credential across sessions: bindings are
session-scoped, swept exhaustively at revoke, shutdown and boot, and a saved tool whose hosts want
credentials refuses those hosts until the owner re-binds; a credential may never be bound to a host
outside the signed `credentialHosts`.*

***Residual, stated here rather than discovered later: this defends the filesystem-write attacker,
not the Vault-read attacker.*** *Signing improves on hash verification precisely because the expected
hash lives in a database an attacker with filesystem access already controls, while the signing key
does not. An attacker who can read the Vault can forge a signature, and I40 claims nothing against
them.*

**Why new rather than an extension of I39.** I39 governs *where a generated tool may send* — a
network property, enforced at the broker, exercised per request. I40 governs *whether the code that
runs is the code the owner approved, across time* — an integrity property, enforced at load,
exercised per session. Different threat, different mechanism, different failure mode. Folding the
second into the first would produce an invariant with two unrelated halves, where a reader checking
one would reasonably believe they had checked both. I39 is new and already exercised; its wording
does not move.

**D29(d).** *There is no unverified read accessor for a saved artifact.* The body and artifact may be
obtained only through `toolgen-saved-store.ts`'s verifying loader, confined to that file — a second
reader elsewhere is a build failure rather than a review comment. Capability confinement is primary
(only that module is handed the store path); the rule makes the shape non-recurring, in the manner
of D27(a).

**How it must NOT be implemented.** The review proposed scanning file contents for a
`/toolgen[\\/]saved/` path literal. **That rule matches nothing and would pass vacuously** — checked:
there are zero such occurrences in the tree, because the existing store composes its paths from
constants (`const STORE_DIR = "toolgen"; const EPHEMERAL_DIR = "ephemeral";` then
`join(configDir, STORE_DIR, EPHEMERAL_DIR, toolId)`), and the saved store will do the same. A guard
that cannot fire is worse than no guard: it reports green forever and is read as coverage.

The rule therefore keys on **identifiers, not path text** — the exported loader's name and the
saved-directory constant, each nameable only by its defining module plus the wiring site — and
carries the same stated bound D27(b) carries: a dynamically assembled path still evades a text scan,
so capability confinement is the real defense and the rule prevents the shape from recurring rather
than proving it absent. The bound is written into the rule's own comment, not just here.

**Triple rule:** wiring, the `docs/SECURITY-INVARIANTS.md` I40 section, and the
`security-invariants.test.ts` enforcement test land in the same commit.

---

## 11. Testing

**Every tamper case is red-proved by reverting the fix**, not by watching a new test go green.

- **Positive control first.** A valid saved tool actually loads, spawns and answers. Without it,
  every "refuses" assertion below passes for any reason at all — including the store being broken.
- Byte flip in `saved/<id>/index.ts` → refuses, `signature_mismatch`.
- Byte flip in `artifact.json` → refuses.
- Signature replaced with another tool's valid signature → refuses.
- Signature file removed → refuses, `signature_missing`, distinct from a mismatch.
- Vault keypair regenerated → `pubkey_rotated`, **distinguishable** from tampering. Asserted on the
  reason, not merely on the refusal.
- Row says healthy, disk says tampered → disk wins, the row's cached fields are repaired (§ 4,
  content axis).
- **Orphan: valid signed directory under `saved/` with no row → swept, NOT adopted** (§ 4, existence
  axis). The signature verifying is precisely what makes this test meaningful — it proves the sweep
  is driven by the missing row and not by a failed check.
- Spawn-time re-verification: a tool that passed boot verification and was tampered with afterwards
  refuses at spawn. This is the assertion that proves boot and spawn are two checks and not one.

**Manifest portability (§ 3.1)** — the case the first draft would have shipped broken:

- A saved tool **spawns and answers on all three platforms**, from `saved/<toolId>`, in a process
  whose gateway never saw the create. This is the test the ephemeral-path bug would have failed, and
  it must run per-platform rather than being asserted from unit fakes: the failure was an OS-level
  access denial, which no fake reproduces.
- `requiredReadPaths()` changes between save and load (simulating a Bun upgrade) → the tool still
  loads and spawns. This is the regression test for signing machine-derived paths; it fails against
  the rejected design and passes against this one.
- A reconstructed manifest that violates the signed shape — non-empty `network`, or a read path
  outside own-dir ∪ runtime paths → refuses with `ERR_TOOLGEN_MANIFEST_SHAPE_INVALID`. Red-proved by
  removing the assertion.

**Idempotency (§ 6)** — saving an unchanged tool twice returns `already_saved` and prompts **once**;
saving after the artifact changed prompts **again**. Asserted on the prompt count, not just the
return value, since the whole point is that consent is not silently skipped.

**The D29(d) guard must be able to fail.** Add a fixture that *should* violate it and assert the
audit reports the violation — without that, the guard's green is indistinguishable from the guard
matching nothing, which is exactly what the rejected regex would have done.

**Credential lifecycle** — create → revoke → the Vault key is gone. Create → shutdown → gone. Save →
shutdown → the tool survives and the credential does not. A crash-orphaned key is swept at next boot.
`credential set` on a host outside `credentialHosts` refuses.

**The full post-restart cycle, end to end** — save a credentialed tool → restart → it loads
`needs-credentials` → a brokered fetch to the credentialed host refuses with
`ERR_TOOLGEN_CREDENTIAL_REQUIRED` **and appends a `blocked` egress row** → `nimbus tool credential
set` → the same fetch now succeeds and carries the header. Asserted on the outbound request's
headers, not on a return code: the defect being guarded is a request that *went out* without
authentication, and only inspecting what was sent can see it. The negative half must also assert
**no request was made at all**, since a refusal that still hits the network is the bug wearing a
different exit code.

**Shutdown non-interference** — `removeAllToolScripts` leaves `saved/` intact. Asserted, not assumed,
because the failure mode is silent deletion.

**Cross-platform** — the `0o600` / `0o700` modes are advisory on Windows and the store's existing
docstring says so; the test asserts what the platform can actually enforce rather than skipping.
`mkdir` carries `mode` forward on the `recursive: true` call — the Windows regression PR 2 already
paid for once.

---

## 12. Delivery re-ledger

The parent spec's § 10 split no longer describes what shipped, and this PR corrects the record rather
than closing the gap silently.

| Parent's plan | What actually shipped |
| --- | --- |
| PR 1 — substrate, drafting stubbed | ✅ #1475 — as specified |
| PR 2 — **agent-initiated** proposal | ❌ never landed. `allow_agent_initiated` and `allowed_hosts` are still absent from `config/nimbus-toml.ts`, whose comment still reads "deliberately ABSENT in PR 1" |
| — | ✅ #1481 shipped **drafting**, which the parent had assigned to PR 1 as a stub |
| PR 3 — persistence + signing | this spec |

**Corrections landing in this PR:** `docs/roadmap.md`'s toolgen row, the parent spec § 10, `CLAUDE.md`
and `GEMINI.md` (mirrors — both, or they drift). Agent-initiated proposal becomes a **named,
reason-recorded deferral** — the treatment fleet PR 2b and the computer-use screen lane received —
rather than a middle PR that quietly evaporated. S2's toolgen row closes on owner-initiated
persistence, and says so in those words.

---

## 13. What this spec asserts vs. what it assumes

**Asserted — verified in the tree on 2026-09-10:**

- `runHashVerification` runs on every enabled extension regardless of publisher; only
  `computeRowSignatureReason` skips on `publisher === undefined`. (The parent's premise is false.)
- `sweepOrphanActiveDirsBestEffort` deletes extensions-root directories with no `extension` row.
- `toolgen-script-store.ts` namespaces `toolgen/ephemeral/`; `removeAllToolScripts` clears only that.
- `canonicalArtifactBytes` ships and already covers body, input schema, approved hosts and credential
  hosts.
- `share/share-keypair.ts` is a working precedent for a Vault-only local Ed25519 keypair.
- `VaultLister.listKeys(prefix?)` exists.
- `toolgen.revoke` does not delete Vault credentials; nothing sweeps them at shutdown or boot.
- `allow_agent_initiated` / `allowed_hosts` are absent from config.
- Schema head is V60 (`CURRENT_SCHEMA_VERSION` in `index/local-index.ts`), so V61 is next.

**Asserted — added during review response, 2026-09-10:**

- `buildGeneratedManifest` writes `opts.scriptDir` into `permissions.filesystem.read`, and
  `canonicalArtifactBytes` covers `manifest` — so an ephemeral path would be signed into a saved
  artifact (§ 3.1).
- `requiredReadPaths()` returns `dirname(process.execPath)`, plus its parent on macOS — machine- and
  platform-specific, which is what rules out signing the concrete manifest (§ 3.1).
- `ToolgenBroker.handleFetch` ends its credential step with
  `if (binding !== null) applyCredential(...)`: a null binding proceeds **unauthenticated** (§ 8.3).
- `ToolgenRegistry.forSession` filters on `sessionId`, and `countForSession` feeds the
  `maxToolsPerSession` check in `createGeneratedTool` (§ 7.2).
- `CLI_TOOLGEN_SESSION_ID` is the literal `"cli"`; agent sessions use UUIDs (§ 7.2).
- The tree contains **zero** occurrences of a `toolgen/saved` path literal, and the store composes
  paths from constants — which is why the reviewed regex form of D29(d) would match nothing (§ 10).

**Assumed — to confirm during implementation, not to build on blind:**

- That `tool.save` can join `HITL_REQUIRED_BACKING` without disturbing the I2 frozen-set membership
  test's count assertion. Expected to be a one-line addition plus the count, but the frozen set is
  frozen for a reason and the test is the authority.
- That the consent path can reuse PR 1's `ToolgenConsentBroker` unchanged. A save approval carries a
  different payload from a create approval and may need its own request shape.
- That signature verification against a base64 Vault pubkey can reuse `extensions/verify-signature.ts`
  rather than needing its own verifier. If it cannot — that module is shaped around a manifest object
  with an embedded signature field, and this artifact is a detached signature over canonical bytes —
  a small local verifier is correct and preferable to bending the shared one.

**Bound on this document itself:** `docs/superpowers/` is excluded from `audit:doc-refs`, so the file
references above are ungated and will rot silently. They were hand-verified on 2026-09-10. This spec
deliberately cites files rather than file:line for that reason — a moved line is the failure mode
that rot takes most often.

---

## 14. Review disposition (2026-09-10)

Against [`2026-09-10-s2-toolgen-persistence-design-review.md`](./2026-09-10-s2-toolgen-persistence-design-review.md).
Every item was checked against the tree before being accepted or refused; the checks are recorded in
§ 13.

| # | Item | Disposition | Note |
|---|---|---|---|
| 2.1 | Manifest path invalidation | **Accepted — blocker confirmed; both proposed fixes rejected** | Verified real. Neither fix survives: `requiredReadPaths()` is the Bun binary dir and is platform-conditional, so a rebuilt-and-signed manifest breaks on a Bun upgrade and differs across OSes. § 3.1 signs the portable shape and reconstructs at spawn — stronger, since a reconstructed manifest is not attacker-influenceable. |
| 2.2 | Broker sends uncredentialed | **Accepted in full** | Verified: `if (binding !== null) applyCredential(...)`. The first draft asserted a refusal that does not exist. § 8.3 now specifies `credentialHostsFor`, `ERR_TOOLGEN_CREDENTIAL_REQUIRED`, and a `blocked` egress row. |
| 2.3 | Two-way DB↔disk reconciliation | **Contradiction accepted; resolution rejected** | § 7 and the old § 11 did conflict. But adopting signed orphans lets a backup restore, or a kept copy of a revoked tool, silently re-register a standing capability. § 4 splits the axes: the row governs existence (orphans swept, per `sweepOrphanActiveDirsBestEffort`), disk+signature governs content. |
| 2.4 | Registry session scope | **Problem accepted; fix refined** | Both halves verified. Rejected making `sessionId` optional — it weakens a required field and lets `undefined` mean "global" to one reader and "unknown" to another. § 7.2 uses a separate saved collection; `countForSession` keeps reading the ephemeral map, so saved tools cost no budget. |
| 3.1 | Migration wiring | **Accepted** | `CURRENT_SCHEMA_VERSION = 60` confirmed in `index/local-index.ts`. D12 already binding. |
| 3.2 | Detached-signature sketch | **Accepted** | Matches § 5 and settles the § 13 open question — a small local detached verifier, not `extensions/verify-signature.ts`, whose shape is a manifest with an embedded signature field. |
| 3.3 | D29(d) as a path regex | **Rejected — the rule matches nothing** | Zero `toolgen/saved` literals exist; the store composes from constants. A guard that cannot fire reports green forever and reads as coverage. § 10 keys on identifiers and states the evasion bound; § 11 adds a must-fail fixture. |
| Q1 | pubkey recovery if the DB is lost | **Moot** | Under § 4, a lost database means saved tools are swept, so there is nothing left to verify. No pubkey copy in `artifact.json` is needed — and adding one would invite adopting orphans. |
| Q2 | Save an already-saved tool | **Accepted, refined** | Idempotent with no re-prompt when the digest matches; a **changed** artifact prompts again, or the standing approval widens to bytes nobody approved. |
| Q3 | Running child on promotion | **Accepted** | Recorded in § 6: the child keeps running from `ephemeral/`; `saved/` is what later sessions spawn. |
| Q4 | Error taxonomy | **Accepted** | § 9 is now a table, adding `ERR_TOOLGEN_CREDENTIAL_REQUIRED` and `ERR_TOOLGEN_MANIFEST_SHAPE_INVALID`. |
| 5 | Test additions | **Accepted, minus disk→DB reconciliation** | That test is replaced by its inverse (orphan swept, not adopted), following 2.3. Added: per-platform saved-tool spawn, the Bun-upgrade regression, prompt-count idempotency, and the guard's must-fail fixture. |

**One thing the review did not have, and it changed an answer:** `requiredReadPaths()`'s volatility is
what turned 2.1 from "rebuild the manifest before signing" into "do not sign machine-derived paths at
all". The review found the blocker; the fix is different because of a fact one level below where it
was looking.

**And a deadline the review surfaced without naming:** § 3.1's change to `canonicalArtifactBytes` is
free today and permanent after this PR, because ephemeral artifacts do not persist and signed ones
will. It has to be decided here.
