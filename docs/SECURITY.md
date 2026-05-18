# Security Policy

## Supported Versions

Nimbus is in active development (**Phase 5 — The Extended Surface**; Phase 4 Presence is complete). Security fixes land on `main` and are folded into the next `v0.1.x` patch release.

| Branch / Tag | Supported |
|---|---|
| `main` (HEAD) | ✅ Yes — tracks the upcoming version |
| `v0.1.x` (latest patch) | ✅ Yes — security fixes are backported when the delta is small |
| Older `v0.1.x` patches | ❌ No — upgrade to the latest patch |
| Pre-`v0.1.0` commits | ❌ No |

### Linux runtime support — glibc floor

Starting with releases built on or after 2026-04-24, Nimbus Linux binaries are compiled on Ubuntu 24.04 runners and require **glibc ≥ 2.39** at runtime. Supported distros (tested): Ubuntu 24.04+, Fedora 40+, Debian 13+, Arch and other current rolling releases. Older distros (Ubuntu 22.04 LTS, Debian 12, RHEL 9 and their derivatives) will emit a `GLIBC_2.39 not found` dynamic-linker error on launch; no workaround beyond upgrading the host OS.

macOS and Windows binaries are unaffected by this change.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via one of these channels:

1. **GitHub private vulnerability reporting** — use "Report a vulnerability" on the [Security tab](https://github.com/nimbus-agent/Nimbus/security/advisories/new) (preferred)
2. **Email** — contact the maintainers at the address listed in the repository profile

Include:

- A clear description of the vulnerability and its impact
- The affected component (Vault, HITL executor, IPC server, extension sandbox, etc.)
- Steps to reproduce or a partial proof-of-concept
- Your severity assessment (CVSS score if available)
- Whether you believe it is platform-specific

You will receive acknowledgement within **72 hours** and a status update within **7 days**.

---

## Security Model

Nimbus is built for engineers who run systems in production and security practitioners who need provable guarantees, not security theatre. The guarantees below are structural — enforced by code, not by policy or configuration. This section describes what Nimbus protects, what it does not, and why.

---

### Security Boundary

Nimbus owns and enforces security **within its process boundary**. What sits below that boundary — the operating system, the disk, the physical machine — is outside Nimbus's control.

**Nimbus's side of the boundary:**

- Credential storage (OS-native keystore only, zero plaintext)
- HITL enforcement (structural, executor-level)
- Extension sandboxing (child process isolation, manifest integrity)
- IPC access control (owner-only socket/pipe)
- Prompt injection defence (typed data blocks, never instructions)
- Audit logging (every action and HITL decision, before execution)

**Your side of the boundary:**

- Strong OS login or biometric authentication
- Screen locking when unattended
- Disk encryption — BitLocker (Windows), FileVault (macOS), LUKS (Linux)
- Active endpoint protection (Antivirus/EDR) — the OS-native keystores protect against stolen-disk attacks; they do not protect against malware running with user-level privileges on a live machine
- Network integrity (Firewall, VPN, and DNS security)
- Timely OS security updates

This boundary is the reason certain issue classes are listed as out of scope below — they describe vulnerabilities in your half of the model, not in Nimbus's.

---

### Security Audits

| Audit | Date | Scope | Outcome |
|---|---|---|---|
| **B1 — Phase 4 internal audit** | 2026-04-25 | 8 trust surfaces (HITL, Vault, LAN, Tauri allowlist, raw SQL, Updater, Extension sandbox, MCP boundary) + cross-surface chains | 78 unique findings filed (0 Critical / 16 High / 28 Medium / 34 Low). All High and Medium findings closed by PRs `#112` / `#113` / commit `806453a`. Three Low items remain scoped to Phase 4 as pre-`v0.1.0` blockers (S4-F6, S4-F8, S6-F1). The two Phase 5 items have shipped — S8-F10 closed by T6 PR 2 (2026-05-15, V29 `tool_call_log`) and S5-F4 closed by T6 PR 4 (2026-05-16, typed `dbRun` / `dbExec` migration + invariant `I14`). One item remains tracked under Phase 10 (S3-F8 LAN forward secrecy). |

The B1 audit also surfaced three orphaned defenses (`extensionProcessEnv`, `checkLanMethodAllowed`, the `<tool_output>` envelope) that were defined but never wired in production. To prevent recurrence, every structural defense Nimbus relies on is now paired with a production wiring site and a regression test in `packages/gateway/src/security-invariants.test.ts`. The full list lives in [`SECURITY-INVARIANTS.md`](./SECURITY-INVARIANTS.md). The audit's durable conclusions — Vault threat surface, LAN trust model, acknowledged residual risks — have been folded into this document; the original per-surface design specs were archived once their substantive content was migrated.

A formal third-party penetration test is planned for Phase 12 (Enterprise readiness).

---

### Credentials

OAuth tokens and all secrets are stored exclusively in the OS-native keystore:

| Platform | Backend |
|---|---|
| Windows | DPAPI (`CryptProtectData`) — key derived from user account; fails on other accounts and machines |
| macOS | Keychain Services — locked on screen lock; requires app entitlement |
| Linux | Secret Service API via `libsecret` — GNOME Keyring / KWallet integration |

There is no code path that writes credentials to disk in plaintext, includes them in log output, or returns them in IPC responses. The structured logger's `redact` configuration automatically censors any field matching `*.token`, `*.secret`, or `oauth.*` patterns.

#### DPAPI optional entropy (Windows)

On Windows, every `CryptProtectData` / `CryptUnprotectData` call passes a per-installation entropy value loaded (or generated on first use) from `<configDir>/vault/.entropy`. The entropy raises the bar for an attacker who already has access to the user's DPAPI master key (e.g. via a same-user malware foothold) — without the entropy, even a copied vault blob cannot be decrypted off-host.

**Backup contract.** The `.entropy` file is bundled inside `nimbus data export` archives (passphrase-wrapped, alongside the credential manifest). Re-importing on the same or a fresh Windows machine restores it before any vault entry is decrypted. Deleting `.entropy` outside of an export round-trip is destructive — it invalidates every existing vault entry on that machine. The file is created with restrictive ACLs so it cannot be read by other users on a shared host.

#### Data export / import (passphrase-wrapped portability)

`nimbus data export` produces a `.tar.gz` archive that contains a re-encrypted credential manifest (Argon2id KDF + XChaCha20-Poly1305), an optional SQLite snapshot, and the Windows DPAPI entropy file when present. The wrapping passphrase is the only secret a user must remember; a 12-word BIP-39 recovery seed is also generated as a backup credential. Both are accepted by `nimbus data import`.

**KDF allowlist procedure.** The importer validates the manifest's KDF parameters against a hardcoded `ACCEPTED_KDF_PROFILES` allowlist before decryption. When tightening the KDF (e.g. raising Argon2id memory or iterations), the **new** profile must be added to the allowlist and shipped in a release **before** any client begins generating exports under it — otherwise older clients fail to import their own backups. Removing an old profile follows the same migration window: ship a release that accepts both, wait one release, then drop the old profile.

#### Vault threat model

The OS-native keystore is **not a barrier against malware running at the user's UID** — it is a barrier against off-host attackers, separate user accounts on a shared machine, and stolen-disk scenarios. Concretely, what each attacker class can do:

| Attacker | Vault access |
|---|---|
| Off-host (stolen disk, copied `<configDir>` directory) | None. Linux libsecret blobs are unreadable without the user session; macOS Keychain blobs require the user account; Windows DPAPI blobs are bound to the user-SID + machine-key (the per-installation entropy at `<configDir>/vault/.entropy` raises the bar further — see DPAPI subsection above). |
| Other UID on the same machine | Cannot read libsecret entries (D-Bus per-session isolation), cannot read macOS Keychain entries (ACL-protected), cannot read DPAPI blobs (key bound to the originating user). |
| Same UID, separate process (malware, untrusted CLI tool) | Can call `secret-tool lookup` (Linux) or `security find-generic-password` (macOS) directly, bypassing the gateway entirely. The vault is a **soft barrier** at this level. |
| Frontend renderer (Tauri webview) | Cannot reach the vault — `vault.*` IPC methods are absent from the compile-time `ALLOWED_METHODS` allowlist (invariant `I7`). |
| Paired LAN peer | Cannot reach the vault — `vault.*` is in the LAN forbidden-method set (invariant `I5`). |

**Acknowledged residual risks within the boundary:**

- Decrypted vault values transit JavaScript strings on the way to the connector subprocess. JS string immutability and the V8 GC schedule mean plaintext lingers in the heap for an unspecified window after use; out of Nimbus's control.
- A connector child process reads its OAuth access-token from its `process.env` at startup. After Nimbus refreshes the token and writes the new value back to the vault, the **child's** copy in memory is stale until it next re-reads. This is a library-level concern and not unique to Nimbus, but it does mean that token rotation has a per-connector lag.

---

### Human-in-the-Loop (HITL) Consent Gate

Every destructive, outgoing, or irreversible action — delete, send, move, merge, deploy, apply — is blocked at the executor by a **compile-time constant set** (`HITL_REQUIRED` in `packages/gateway/src/engine/executor.ts`). Key properties:

- **Not a prompt instruction.** The gate is a function call in the executor. A model that generates a plan to "skip confirmation" produces a plan that does not execute — there is no code path to bypass.
- **Not runtime-configurable.** The set is declared as a module-level constant and is not writable via configuration files, IPC calls, or extension APIs.
- **No timeout.** The executor awaits the consent channel unconditionally. There is no timer that auto-approves.
- **Audit-first.** The HITL decision (approved, rejected, or not required) is written to the audit log **before** the connector is called.

Every action Nimbus takes under a HITL approval is recorded with the action type, payload, decision, and timestamp. The audit log is append-only and locally stored in SQLite.

> **Current state of the HITL whitelist:** The set covers cloud storage, email, calendar, source control (merge, push, branch delete), CI/CD (trigger, cancel), infrastructure (apply, destroy, scale), Kubernetes, and monitoring/incident actions. See the constant in `executor.ts` for the full list. Extensions that declare `hitlRequired` in their manifest have their write tools added to the gate automatically.

---

### Extension Sandbox

Third-party extensions run as child processes. They:

- Have their manifest SHA-256 hash verified on every Gateway startup — a tampered manifest causes the extension to be disabled before it runs
- Are also re-hashed via `verifyOneExtensionStrict` immediately before any pre-spawn check to catch mutations between startup verify and child spawn (S7-F3 fix)
- Are installed only from non-symlinked source trees (`scanForSymlinks` rejects any symlink in the source) and tar archives are extracted with explicit safety flags (`--no-overwrite-dir`, `--no-same-owner`, `--no-same-permissions`) plus a post-extract path-traversal sweep (`assertNoEntryEscapes`) that refuses any entry whose final-path resolve falls outside the install root (S7-F4, S7-F5 fixes)

**Extension isolation.** Extensions run inside a per-OS sandbox enforced by invariant `I15` (shipped in Phase 5 T2 PR 1, 2026-05-17): bwrap user/PID/IPC/mount/network namespaces + seccomp BPF + per-host iptables (via `nimbus-sandbox-helper` with `cap_net_admin+ep`) on Linux; `sandbox-exec` SBPL profile on macOS; AppContainer with `internetClient` capability gating on Windows. Every lazy-mesh `ServerSpec` is routed through `wrapServerSpec(...)` → `sandbox-wrapper.ts` → `runner.spawn(...)`; the wiring is enforced statically by audit rule `D10` and at runtime by `security-invariants.test.ts`. In addition, `extensionProcessEnv()` filters parent-process environment variables (blocking propagation of OAuth client secrets and LLM provider API keys), and the manifest SHA-256 is re-checked immediately before each spawn (S7-F3 fix). Manifest-declared `permissions.{network,filesystem}` define the allowed surface — anything not declared is kernel-denied. See [`docs/sandbox.md`](./sandbox.md) for the full schema, per-OS depth, and the **platform asymmetry caveat**: per-host network filtering is full on Linux/macOS but all-or-nothing on Windows until WFP callout support lands. Pre-T2 extensions are hard-disabled until reinstalled with a T2-shape manifest.

#### Extension disable and descendant subprocesses

When an extension's hash check fails (`verifyExtensionsBestEffort` at startup) or the user invokes `extension.disable`, the gateway terminates the extension's MCP wrapper process via `LazyConnectorMesh.stopExtensionClient`. On Linux the bwrap PID namespace makes the wrapper PID 1 of its own namespace, so the entire descendant tree is reaped when the wrapper exits. On macOS, `sandbox-exec` inherits to spawned children but descendant cleanup still depends on the wrapper's process-group handling. On Windows, AppContainer enforces capability boundaries on live processes and `reapOrphanedAppContainers` (in `platform/sandbox/orphan-reap.ts`) cleans leftover AppContainer **profiles** at Gateway startup; tightening live-descendant termination on Windows is tracked alongside the WFP per-host filtering work in Phase 10.

---

### IPC Surface

The Gateway listens only on a local domain socket (Unix) or named pipe (Windows), created with owner-only permissions (`chmod 0600` on Unix; DACL owner-only on Windows). There is no TCP listener. No Nimbus Gateway port is opened on any network interface.

The optional LAN server (`nimbus lan enable`) and auto-updater (`nimbus update`) are guarded by the structural defenses listed in [`SECURITY-INVARIANTS.md`](./SECURITY-INVARIANTS.md) — the LAN method allowlist (`I5`), loopback bind default (`I6`), and updater signature/version checks. The B1 audit closed the High and Medium findings on these subsystems; remaining Low items are tracked in the [Phase 4 / Phase 10 roadmap entries](./roadmap.md). Production wiring of both features lands once GA prerequisites (signing certs, manifest server, LAN forward-secrecy redesign) are signed off.

The opt-in read-only HTTP API (`nimbus serve`) gained a narrow write surface in Phase 5 T4 for post-deploy annotation (`POST /v1/deployments`). The surface is protected by a compile-time allowlist (`WRITE_ROUTE_ALLOWLIST` — invariant `I13`), bearer-token auth keyed on the `http_api.deployment_token` vault entry, and per-token rate limiting; every rejected request emits a `deployment.annotation_rejected` audit row so brute-force probes are tamper-evident on the BLAKE3 chain. The read-only `Database` handle still runs in `SQLITE_OPEN_READONLY` mode — writes go through a second, dedicated handle bound only to the allowlisted route. All SQLite writes anywhere in the gateway also pass through the `dbRun` / `dbExec` / `dbStmtRun` wrappers (invariant `I14`), which translate `SQLITE_FULL` into a typed `DiskFullError` so a full-disk event surfaces as a typed exception rather than a silently swallowed write.

#### LAN remote access — trust model

When `nimbus lan enable` is on, the LAN server accepts length-framed TCP connections protected by NaCl box (X25519 ECDH + XSalsa20-Poly1305). The trust establishment model is **explicit pairing**, not transparent discovery:

- Pairing opens a **5-minute window**, gated by a 120-bit base58 pairing code (`randomBytes(15)` → 20 chars). The code is single-use and constant-time-compared. After the window closes, only previously-paired peers can connect.
- Per-IP rate limiter (`lan-rate-limit.ts`) tracks failed pairing attempts in a sliding window; lockout is automatic after the configured threshold. The limiter is in-memory only — restarting the gateway clears lockouts. Plan a one-time grace if you cycle the gateway during an active attack.
- A peer's identity is its X25519 public key, persisted in `lan_peers` after successful pairing. **There is no out-of-band binding to the host's identity** beyond the pairing code; a network attacker between peer and gateway during pairing could substitute their own keypair. Mitigation: transmit the pairing code out-of-band (read it aloud, send via SMS, etc.) — never in the same network channel that's being paired.
- The X25519 keypairs are **long-term per host** with no per-session ephemeral DH layer. There is no forward secrecy: a future compromise of the host's secret key allows decryption of all past LAN sessions captured on the wire. Closing this gap is on the Phase 10 roadmap.

**Attacker capabilities:**

| Attacker | LAN capability |
|---|---|
| Network observer (passive) | Cannot decrypt sealed frames; sees only TCP framing and ciphertext sizes. |
| Network attacker (active, mid-pairing) | Can intercept the pairing handshake and substitute their own pubkey if the pairing code is delivered through the same channel. Out-of-band code transmission is required. |
| Paired peer without write grant | Read-side methods only (`engine.ask`, `connector.list`, `index.queryItems`, etc.). The forbidden namespaces — `vault.*`, `updater.*`, `lan.*`, `profile.*` — remain blocked regardless of grant. |
| Paired peer with write grant (`nimbus lan grant-write`) | Can additionally call HITL-gated write methods. The HITL gate still fires on the **host**, so the host user remains the consent authority. |
| Host running behind NAT / proxy | The rate limiter sees the proxy IP, not the originating peer. A single misbehaving peer behind a shared egress can lock out other legitimate peers. |

**Acknowledged residual risks:**

- No forward secrecy across sessions (Phase 10 redesign).
- Cross-network pairing relies on out-of-band code transmission.
- The host identity is implicit (host pubkey is announced post-handshake) — peer-side host pinning is the user's responsibility for now.

#### Updater temp directory cleanup

`Updater.applyUpdate` writes the verified installer to a fresh temp directory created by `mkdtempSync(join(tmpdir(), "nimbus-update-"))`. The directory and its contents are deleted in a `finally` block after the platform installer returns (success or failure). The installer binary is written with mode `0o600` and is never readable by other users on a shared machine. The `lastError` field exposed via `updater.getStatus` is scrubbed of URL userinfo (`user:pass@`) before storage so a misconfigured `manifestUrl` cannot leak credentials through the diagnostic surface.

---

### Prompt Injection

**Tool output envelope.** Every tool result that flows into an LLM context — both gateway-internal read tools (`searchLocalIndex`, `getAuditLog`, etc.) and MCP-backed tools — is wrapped in a textual `<tool_output service="…" tool="…">…</tool_output>` envelope at the LLM-facing boundary. Literal `</tool_output>` substrings in the tool body are escaped to `<\/tool_output>` so an attacker-controlled tool result cannot terminate the envelope and re-enter "instruction mode". The agent's system prompt instructs the model to treat content inside this tag as data, not instructions.

The bare result still flows through the planner path (`ConnectorDispatcher` → `ToolExecutor`), where the structural HITL gate is the defense regardless of LLM compliance. This is a soft defense for the conversational read-tool surface (probabilistic LLM compliance); the HITL gate remains the structural defense for destructive actions.

The hard structural barrier is the **HITL consent gate** in `executor.ts`: every action type in `HITL_REQUIRED` requires explicit user approval before the connector executes, regardless of what the LLM or an injected tool result requests. A malicious tool result cannot remove an action type from `HITL_REQUIRED`.

In addition to the textual labeling, MCP tool results are returned to the agent via the LLM-provider SDK's typed message channel (`tool_result` for Anthropic, `function_call_response` for OpenAI). The provider SDK structurally labels these as tool output — not as system instructions — which is the primary soft barrier against prompt injection.

---

### Audit Log

Every action the agent takes — including every HITL decision — is recorded in a local SQLite `audit_log` table before the action executes. You can reconstruct exactly what Nimbus did on your behalf at any time via `nimbus audit` or the desktop audit log viewer.

**Single source of truth:** The audit log lives exclusively in SQLite — there is no separate `audit.jsonl` file. This is a deliberate architectural decision: a split store would require two separate tamper-evident chains and create reconciliation risk.

Migration V18 (`packages/gateway/src/index/audit-chain-v18-sql.ts`) added `row_hash` and `prev_hash` columns to `audit_log`, implementing a BLAKE3-chained tamper-evident log. Verify with `nimbus audit verify` (see `packages/cli/src/commands/audit.ts`).

---

### Standing Approvals (design for a future phase)

A future phase will introduce standing approvals: pre-authorized patterns that allow recurring write actions to execute without an interactive HITL prompt. The feature is not yet on the Phase 5 delivery list, but because standing approvals are functionally a scoped HITL bypass, the security boundaries are recorded here so the design constraints are settled before any implementation begins.

**Threat model:**

| Threat | Mitigation |
|---|---|
| Overly broad rule scope — user grants wider permissions than intended | Standing rules must specify an exact connector, action type, and target pattern. Wildcard targets require explicit opt-in at rule creation. |
| Malicious extension crafts tool calls to match a standing rule | Standing rules are matched against the tool's declared manifest name and connector id, not against the free-text action description. Extensions cannot self-declare as a built-in connector. |
| Privilege escalation via rule chaining | A standing approval covers exactly one tool call. The approval does not propagate to subsequent tool calls in the same session. |
| Audit trail gap | Standing-approved actions are written to `audit_log` with `hitl_status = 'standing_approved'` and the rule id before execution — the same audit-first guarantee as interactive HITL. |
| Rule revocation window | Revoked rules take effect immediately; any in-flight session that already passed the gate completes, but no new calls are approved. |

**Design constraints (enforced at implementation time):**

- Standing rules are stored in SQLite, not in config files — they are subject to the same integrity checks as the rest of the local index.
- No standing rule may cover `vault.*` or `db.*` tool calls.
- The rule editor in the UI must show a diff preview of the scope before saving.

---

## SecDevOps and Compliance Use

Nimbus is designed to support security-sensitive operational environments. The properties relevant to SecDevOps and compliance teams:

**Audit trail.** Every action the agent takes — including every HITL approval, rejection, and "not required" decision — is recorded in a local SQLite `audit_log` table before the action executes. The log is append-only and BLAKE3-chained (`row_hash`, `prev_hash` columns added by V18); verify integrity with `nimbus audit verify`. Phase 12 adds shipping to SIEM targets (Splunk, Elastic, Datadog Logs, S3/GCS/Azure Blob) with local retention as fallback.

**No data exfiltration surface.** The local index stores metadata only — names, timestamps, URLs, body previews. Full document content never enters the index or embedding pipeline unless explicitly configured (`[indexing.depth] = "full"`). The index is protected by OS file permissions; it is never transmitted to a Nimbus server because there is no Nimbus server.

**Consent-gated remediation.** Incident response actions (rollback, restart, IaC apply, alert acknowledge) go through the same structural HITL gate as all other write actions. An agent under incident pressure cannot bypass the gate — there is no code path to do so.

**Credential isolation.** Connector credentials are injected at MCP server spawn time via environment variables scoped to that child process. They are never present in IPC messages, in the local index, in log output, or in the Engine's context. The `redact` configuration on the structured logger automatically censors any field matching `*.token`, `*.secret`, or `oauth.*`.

**Compliance tooling roadmap.** `nimbus compliance check` (Phase 12) will produce a machine-readable JSON report covering: credential storage status, audit log integrity, plaintext credential scan, connector scope minimization, and data residency posture. Structured for auditor consumption.

---

## Scope

**In scope:**

- Vault / credential exposure through any interface
- HITL gate bypass — any path by which a destructive action executes without user consent
- Extension sandbox escape
- IPC authentication bypass or privilege escalation
- Prompt injection leading to unintended actions
- Dependency vulnerabilities with direct exploitability in the Nimbus runtime

**Out of scope:**

- Vulnerabilities in the OS keystore implementation (DPAPI, Keychain, libsecret) — these are platform-level, not Nimbus's
- Attacks requiring physical access to an unlocked or unencrypted machine — physical and OS security are your side of the boundary
- Theoretical attacks with no practical exploit path against a correctly configured machine
- Rate limiting or DoS on the local IPC socket (already local-only and owner-gated)

---

## OpenSSF Scorecard (supply chain)

Some Scorecard findings are enforced in-repo (workflows, CodeQL, dependency scanning). Others depend on **repository or organization settings** or **external programs**:

| Finding | What fixes it |
|--------|----------------|
| **Security-Policy** | This file (`docs/SECURITY.md`) on the default branch. |
| **Branch-Protection** / **Code-Review** | Branch protection **rulesets** (or classic rules): required PRs, approvals, required status checks; optional **code owner** review using [`.github/CODEOWNERS`](../.github/CODEOWNERS). Step-by-step: [`.github/BRANCH_PROTECTION.md`](../.github/BRANCH_PROTECTION.md). |
| **Maintained** | Ongoing commits, releases, and issue/PR handling (project activity). |
| **Fuzzing** | Typically [OSS-Fuzz](https://google.github.io/oss-fuzz/) (or another continuous fuzzing program) integrated with the project; not covered by this file alone. |
| **CII-Best-Practices** | [OpenSSF Best Practices badge](https://www.bestpractices.dev/) — self-certification questionnaire for the repository. |

For workflow and token hygiene used in CI, see [`security-hardening.md`](./security-hardening.md).

---

## Dependency Scanning

Automated vulnerability scans run on every PR and nightly:

- **`bun audit`** — npm dependency advisory checks
- **`cargo audit`** — Rust dependency advisory checks (Tauri shell)
- **`cargo deny`** — license compatibility (AGPL-3.0 inbound), unmaintained-crate bans, registry pinning
- **`trivy`** — filesystem vulnerability scanning, SARIF uploaded to GitHub Security tab
- **`CodeQL`** — static analysis for JS/TS *and* Rust (security-extended queries)
- **`gitleaks`** — committed-secret detection on PRs and nightly
- **`OpenSSF Scorecard`** — supply-chain posture, weekly + on default-branch push
- **`@nimbus-dev/client`** is published with **npm provenance** (sigstore signature backed by GitHub OIDC); verify with `npm audit signatures`

HIGH and CRITICAL findings block merges when branch protection checks are required. Dependabot opens update PRs automatically for outdated dependencies.

Release binaries (Gateway + CLI, all four platform builds) carry a **GitHub build provenance attestation** (`actions/attest-build-provenance`) and a **CycloneDX SBOM**, both attached to the GitHub Release. Verify with:

```bash
gh attestation verify nimbus-gateway-linux-x64 --owner nimbus-agent
```

---

## Updater Signing Key Lifecycle

Nimbus auto-updates are gated on an **Ed25519 signature over a canonical JSON envelope** of `{ version, target, sha256 }` (see `packages/gateway/src/updater/signature-verifier.ts:verifyManifestEnvelope`). The verifier reconstructs this envelope from the manifest's claimed fields before checking the signature, so an attacker who replays a legitimate signed binary into a fresh manifest cannot mismatch the version/target without invalidating the signature. A legacy bare-SHA mode is retained for the migration window of one release; once the next signed manifest ships, the fallback is removed.

Update binaries are downloaded only over HTTPS (with an `http://127.0.0.1` test escape that is disabled in production). The download is hard-capped at 500 MiB (`MAX_DOWNLOAD_BYTES`) — any Content-Length above the cap is rejected before the body is read, and a streaming accumulator aborts mid-download if the running total exceeds the cap. Every `applyUpdate` invocation emits four ordered audit phases (`system.update.start` / `system.update.verified` / `system.update.installed` / `system.update.failed`) via the optional `recordUpdateEvent` callback, so `nimbus audit verify` shows install history.

The public key is embedded in the binary at build time (`packages/gateway/src/updater/public-key.ts`); the private key lives only in the `UPDATER_SIGNING_KEY` repository secret and is never present on a developer machine.

### Rotation procedure

Plan a rotation at least once every 12 months, and immediately on any of these triggers:

- A maintainer with secret-read access leaves the project.
- A CI run is suspected of having leaked the key (e.g., a workflow added an unintended `echo "$UPDATER_SIGNING_KEY"`).
- A new key algorithm becomes the default for the project.

**Steps (must all happen in the same release cycle):**

1. **Reset the embedded public key.** `scripts/generate-updater-keypair.ts` refuses to run if `packages/gateway/src/updater/public-key.ts` already contains a non-dev key (an intentional safety against accidental rotation). On a feature branch, replace the body of `UPDATER_PUBLIC_KEY_BASE64` with `"<DEV-PLACEHOLDER>"` so the script will run.
2. **Generate the new keypair** locally on an air-gapped or hardened workstation:

   ```bash
   bun scripts/generate-updater-keypair.ts
   ```

   The script prints the new public key (base64 + hex) to stdout and writes the new private key to a freshly-created temp file under `<tmpdir>/nimbus-updater-key-*/updater-private.b64` (mode `0600`).
3. **Update the embedded public key** in `packages/gateway/src/updater/public-key.ts` (and the test override `NIMBUS_DEV_UPDATER_PUBLIC_KEY` if used) using the printed base64 value. Land via PR.
4. **Cut a transitional release** that ships *both* the old and new public key as trusted (the updater accepts either signature). This release must be signed with the **old** key.
5. **Rotate the secret**: upload the temp-file private key to repository secret `UPDATER_SIGNING_KEY` (`gh secret set UPDATER_SIGNING_KEY < <path>`), then shred and delete the temp file immediately.
6. **Cut a second release** signed with the new key. Verify clients on N-1, N, and N+1 all auto-update successfully.
7. **Remove the old public key** from `public-key.ts` in the next release. Document the rotation in `docs/SECURITY.md` change history.

### Compromise response

If the active signing key is suspected to be compromised:

1. **Disable auto-update server-side** by setting the `latest.json` manifest's `version` to a pinned safe value and the `forcedUpdate` flag to `false`.
2. Generate a new keypair and ship a transitional release within 24 hours. Notify users via the GitHub Security advisory channel.
3. Revoke the leaked key by removing it from `public-key.ts` in the immediate follow-up release.
4. Audit the GitHub Actions workflow run logs for the period the key was active — look for any step that read `UPDATER_SIGNING_KEY` outside `scripts/sign-ed25519.ts`.

**Long-term mitigation:** the project is tracking migration to **sigstore/cosign with GitHub OIDC** for keyless updater signing, eliminating the long-lived secret entirely. Tracked as Phase 5+ release-infra hardening.

---

## Release Signing Key

Nimbus release artifacts are distributed with a GPG-signed `SHA256SUMS.asc` integrity manifest (and per-artifact `.asc` sidecars on Linux). All release signing uses the single key whose fingerprint is published below.

### v0.1.0 signing cut-line

`v0.1.0` ships with **Linux binaries GPG-signed** and **macOS + Windows binaries unsigned**. The integrity guarantee for non-Linux platforms therefore comes from the GPG-signed `SHA256SUMS.asc` manifest, **not** from platform-native code-signing — macOS users do not get a notarized `.pkg`, Windows users do not get an Authenticode-signed installer, and both platforms require a documented one-time bypass on first install ([`install-macos-unsigned.md`](./install-macos-unsigned.md), [`install-windows-unsigned.md`](./install-windows-unsigned.md)).

This is an explicit project decision, not a temporary regression: native code-signing requires recurring spend on an Apple Developer Program membership ($99/yr) and a Windows EV certificate (~$470–$840/yr including signing-service fees). Both are **deferred to a later point release** — *not* `v0.1.1` — gated on an explicit maintainer decision to fund the procurement once the product is stable enough to justify it. Until that decision is made, the GPG manifest remains the canonical integrity boundary on macOS and Windows.

Verifying a release on any platform follows the same `SHA256SUMS.asc` workflow described in [`verify-release-integrity.md`](./verify-release-integrity.md); the platform OS may additionally raise a Gatekeeper / SmartScreen prompt, which the unsigned-install docs walk through.

**Project GPG fingerprint (v0.1.0 and later):**

```text
5A20 457C CD8B 53FF AA94 5240 886A DA6B 487C AB6E
```

**Cross-check this fingerprint against four sources** — if any two disagree, **do not install**; open a private security issue per "Reporting a Vulnerability" above:

1. This file (`docs/SECURITY.md`) — you're reading it now.
2. The repository README (`README.md`, "Install → Verify any download" section).
3. The public key ASCII-armored block at [`docs/release/SIGNING-KEY.asc`](release/SIGNING-KEY.asc).
4. Either keyserver — `keys.openpgp.org` or `keyserver.ubuntu.com`.

**To import the key from a keyserver:**

```bash
gpg --keyserver keys.openpgp.org --recv-keys 5A20457CCD8B53FFAA945240886ADA6B487CAB6E
# or
gpg --keyserver keyserver.ubuntu.com --recv-keys 5A20457CCD8B53FFAA945240886ADA6B487CAB6E
```

**First-time users:** the `nimbus-verify.sh` / `nimbus-verify.ps1` helper scripts print the fingerprint they imported before running `gpg --verify`. Match that printed value against this file, the README, and a keyserver lookup before allowing the script to touch your keyring. See [`docs/verify-release-integrity.md`](verify-release-integrity.md) for the full walkthrough.

**Key rotation.** When the project rotates its signing key, the transition runs over two releases: one signed by the old key but carrying the new fingerprint in the scripts' `TRUSTED_FINGERPRINTS` array, and a subsequent release signed by the new key only. See [`docs/verify-release-integrity.md#key-rotation`](verify-release-integrity.md#key-rotation) for the worked example.
