# Signing Key Lifecycle

Operational runbooks for the two signing keys Nimbus depends on: the **updater signing key** (Ed25519, gates auto-update) and the **release signing key** (GPG, signs release artifacts). The security *model* and reporting policy live in [`../SECURITY.md`](../SECURITY.md); this file is the maintainer-facing procedure for rotation and compromise response. The full inventory of every CI/release secret (PATs, signing certs, publish tokens) and how to mint each one is in [`../ci-secrets.md`](../ci-secrets.md).

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
7. **Remove the old public key** from `public-key.ts` in the next release. Document the rotation in this file's change history.

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

`v0.1.0` ships with **Linux binaries GPG-signed** and **macOS + Windows binaries unsigned**. The integrity guarantee for non-Linux platforms therefore comes from the GPG-signed `SHA256SUMS.asc` manifest, **not** from platform-native code-signing — macOS users do not get a notarized `.pkg`, Windows users do not get an Authenticode-signed installer, and both platforms require a documented one-time bypass on first install ([`../install-macos-unsigned.md`](../install-macos-unsigned.md), [`../install-windows-unsigned.md`](../install-windows-unsigned.md)).

This is an explicit project decision, not a temporary regression: native code-signing requires recurring spend on an Apple Developer Program membership ($99/yr) and a Windows EV certificate (~$470–$840/yr including signing-service fees). Both are **deferred to a later point release** — *not* `v0.1.1` — gated on an explicit maintainer decision to fund the procurement once the product is stable enough to justify it. Until that decision is made, the GPG manifest remains the canonical integrity boundary on macOS and Windows.

Verifying a release on any platform follows the same `SHA256SUMS.asc` workflow described in [`../verify-release-integrity.md`](../verify-release-integrity.md); the platform OS may additionally raise a Gatekeeper / SmartScreen prompt, which the unsigned-install docs walk through.

**Project GPG fingerprint (v0.1.0 and later):**

```text
5A20 457C CD8B 53FF AA94 5240 886A DA6B 487C AB6E
```

**Cross-check this fingerprint against four sources** — if any two disagree, **do not install**; open a private security issue per "Reporting a Vulnerability" in [`../SECURITY.md`](../SECURITY.md):

1. This file (`docs/release/signing-keys.md`).
2. The repository landing page ([`../README.md`](../README.md), "Verifying what you downloaded" in the Quick Start section).
3. The public key ASCII-armored block at [`SIGNING-KEY.asc`](./SIGNING-KEY.asc).
4. Either keyserver — `keys.openpgp.org` or `keyserver.ubuntu.com`.

**To import the key from a keyserver:**

```bash
gpg --keyserver keys.openpgp.org --recv-keys 5A20457CCD8B53FFAA945240886ADA6B487CAB6E
# or
gpg --keyserver keyserver.ubuntu.com --recv-keys 5A20457CCD8B53FFAA945240886ADA6B487CAB6E
```

**First-time users:** the `nimbus-verify.sh` / `nimbus-verify.ps1` helper scripts print the fingerprint they imported before running `gpg --verify`. Match that printed value against this file, the README, and a keyserver lookup before allowing the script to touch your keyring. See [`../verify-release-integrity.md`](../verify-release-integrity.md) for the full walkthrough.

**Key rotation.** When the project rotates its signing key, the transition runs over two releases: one signed by the old key but carrying the new fingerprint in the scripts' `TRUSTED_FINGERPRINTS` array, and a subsequent release signed by the new key only. See [`../verify-release-integrity.md#key-rotation`](../verify-release-integrity.md#key-rotation) for the worked example.
