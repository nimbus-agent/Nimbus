// Single source of truth for the CLI's reported version: the monorepo root
// package.json, which release-please bumps on every release (the per-package
// package.json files are intentionally left at 0.1.0). Bun inlines this JSON
// import into the compiled `nimbus` binary at build time, so `nimbus --version`
// reports the released version with no runtime file access.
import rootPkg from "../../../package.json";

export const NIMBUS_VERSION: string = rootPkg.version;
