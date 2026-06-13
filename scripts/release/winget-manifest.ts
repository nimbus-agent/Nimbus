#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { parseSha256Sums } from "./package-manager-manifests.ts";

/**
 * winget package identity. Confirmed with the maintainer before the first
 * microsoft/winget-pkgs submission — it becomes the public `winget install <id>`
 * id and is disruptive to change after a PR is accepted.
 */
export const WINGET_PACKAGE_IDENTIFIER = "NimbusAgent.Nimbus";

/** The Windows installer asset Slice 2 attaches to every stable release. */
export const WINGET_MSI_ASSET = "nimbus-headless-windows-x64.msi";

/** Public download URL for the released .msi (the URL winget's manifest points at). */
export function msiReleaseUrl(repo: string, version: string): string {
  const v = version.replace(/^v/, "");
  return `https://github.com/${repo}/releases/download/v${v}/${WINGET_MSI_ASSET}`;
}

/**
 * The expected sha256 of the released .msi, read from the release SHA256SUMS.
 * Throws (fail loud) if the asset is absent — we never submit a winget PR for a
 * hash we couldn't verify against the published manifest.
 */
export function msiAssetSha256(sha256SumsText: string): string {
  const hash = parseSha256Sums(sha256SumsText).get(WINGET_MSI_ASSET);
  if (!hash) {
    throw new Error(
      `winget-manifest: required release asset not found in SHA256SUMS: ${WINGET_MSI_ASSET}`,
    );
  }
  return hash;
}

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

if (import.meta.main) {
  const version = parseArg("--version") ?? process.env["NIMBUS_RELEASE_VERSION"];
  const repo = parseArg("--repo") ?? "nimbus-agent/Nimbus";
  const sha256SumsPath = parseArg("--sha256sums");
  if (!version || !sha256SumsPath) {
    console.error(
      "Usage: bun scripts/release/winget-manifest.ts --version <v> --sha256sums <path> [--repo owner/repo]",
    );
    process.exit(1);
  }
  const url = msiReleaseUrl(repo, version);
  const sha256 = msiAssetSha256(readFileSync(sha256SumsPath, "utf8"));
  const lines = [`url=${url}`, `sha256=${sha256}`, `identifier=${WINGET_PACKAGE_IDENTIFIER}`];
  for (const line of lines) console.log(line);
  // GitHub Actions step-output idiom: append key=value lines to $GITHUB_OUTPUT
  // so downstream steps can read steps.<id>.outputs.url / .sha256 / .identifier.
  const ghOut = process.env["GITHUB_OUTPUT"];
  if (ghOut) appendFileSync(ghOut, `${lines.join("\n")}\n`);
}
