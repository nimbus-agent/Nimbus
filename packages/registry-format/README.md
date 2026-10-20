# @nimbus-dev/registry-format

Pure, runtime-neutral rules for the Nimbus extension registry (manifest, signing, tarball and index
formats). One source of truth shared by the gateway, the CLI and the registry CI action.

This package must stay free of Bun APIs and must not import from `packages/gateway`, `packages/cli`
or `packages/ui` (enforced by the `registry-format-is-pure` dependency-cruiser rule).
