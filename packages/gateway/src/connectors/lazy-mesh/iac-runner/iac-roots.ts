// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-roots.ts
// Where the IaC runner keeps its run directories, the folders no approved Terraform directory may
// overlap, and which change sets a discard may name. Moved out of `iac-runner.ts` unchanged
// (file-size baseline); the two roots are re-exported from there.
import { dirname, join } from "node:path";
import type { PlatformPaths } from "../../../platform/paths.ts";
import { isPlainStackName } from "../../connector-writes/iac-limits.ts";

/**
 * The folders no approved Terraform directory may overlap (is, contain or sit inside): Nimbus's data,
 * config and sandbox directories, the extensions directory, the WHOLE cache root the sandbox and the
 * iac root live under, the temp directory Nimbus uses (`$TMP/nimbus`), the iac root itself and, on
 * Linux, the runtime directory (`XDG_RUNTIME_DIR`, which holds the gateway's socket).
 */
export function iacProtectedRootsFor(
  paths: Pick<PlatformPaths, "dataDir" | "configDir" | "sandboxDir" | "extensionsDir" | "tempDir">,
  platform: NodeJS.Platform,
  runtimeDir: string | undefined,
): readonly string[] {
  return [
    paths.dataDir,
    paths.configDir,
    paths.sandboxDir,
    paths.extensionsDir,
    paths.tempDir,
    dirname(paths.sandboxDir),
    iacRootFor(paths),
    ...(platform === "linux" && runtimeDir !== undefined && runtimeDir !== "" ? [runtimeDir] : []),
  ];
}

/** `<cache>/iac-runs`, a sibling of the sandbox root: never `dataDir` (the filesystem MCP writes there). */
export function iacRootFor(paths: Pick<PlatformPaths, "sandboxDir">): string {
  return join(dirname(paths.sandboxDir), "iac-runs");
}

const OUR_CHANGE_SET_ARN =
  /^arn:aws[a-z-]*:cloudformation:([a-z0-9-]+):\d{12}:changeSet\/nimbus-[0-9a-f]{64}-[0-9a-f]{12}\/[0-9a-f-]{36}$/;

/**
 * A discard may only name a change set this gateway could have created: a plain stack name, an ARN
 * whose name has the `nimbus-<template sha256>-<12 hex>` form the prepare step gives, in the region
 * this run's credential uses. Anything else (another region, someone else's change set) never
 * reaches a child, whoever asked.
 */
export function isOurChangeSet(args: Record<string, unknown>, region: string): boolean {
  const id = args["changeSetId"];
  if (region === "" || !isPlainStackName(args["stackName"]) || typeof id !== "string") return false;
  return OUR_CHANGE_SET_ARN.exec(id)?.[1] === region;
}
