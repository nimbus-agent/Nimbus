# Review Feedback: Installer Slice 1 — Homebrew Tap + Scoop Bucket

This document outlines improvements, suggestions, and open questions for the [installer-slice1-brew-scoop.md](./2026-06-12-installer-slice1-brew-scoop.md) implementation plan.

---

## Improvements

### 1. Add `workflow_dispatch` support to the publish workflow

If a release is published but the external repository push fails due to a transient GitHub outage or an expired/misconfigured `PACKAGE_MANAGER_PAT`, there is currently no way to trigger a retry without modifying the release or manually pushing files.

- **Suggestion**: Add a `workflow_dispatch` trigger to `.github/workflows/publish-package-managers.yml` allowing maintainers to run the workflow manually by inputting the tag name (e.g., `v0.5.0`).
- **Proposed Trigger Design**:

  ```yaml
  on:
    release:
      types: [released]
    workflow_dispatch:
      inputs:
        tag_name:
          description: 'The tag name to publish (e.g. v0.5.0)'
          required: true
          type: string
  ```

- **Proposed Script Update**: Update the step variables to fall back to the input:

  ```bash
  TAG="${{ github.event.release.tag_name || github.event.inputs.tag_name }}"
  ```

### 2. Graceful skip or error messaging for missing secrets on forks

If the workflow is triggered on a fork, the `secrets.PACKAGE_MANAGER_PAT` will not be present, causing the workflow run to fail.

- **Suggestion**: Add a pre-flight step or condition to check if `secrets.PACKAGE_MANAGER_PAT` is defined before executing the clone and push steps:

  ```yaml
  if: ${{ env.GH_TOKEN != '' }}
  ```

---

## Suggestions

### 1. Confirm Scoop's `$version` literal behavior

In `renderScoopManifest`:

```ts
url: `https://github.com/${repo}/releases/download/v$version/nimbus-headless-windows-x64.zip`
```

Ensure that the template literal evaluates `v$version` as the literal string `"v$version"` (since TypeScript/JavaScript uses `${var}` for template interpolation, not `$var`). Scoop expects the literal `$version` text to perform its own client-side substitution. The proposed string is correct, but the implementer must be careful not to accidentally write `v${version}` in the `autoupdate` template configuration.

---

## Open Questions

### 1. CLI Execution Loop after Nudge

In `packages/cli/src/commands/update.ts`, when the update is channel-managed:

```ts
if (channel !== null) {
  console.log(channelUpgradeHint(channel));
  process.exitCode = 0;
  return;
}
```

Does the main CLI entrypoint exit cleanly when `runUpdate` returns, or are there any background connections/event-loop registrations (like IPC listener setup) initiated prior to this that would keep the Node/Bun process alive?

- *Check*: Ensure that the channel check is placed before any long-running asynchronous setup in the CLI command handler.
