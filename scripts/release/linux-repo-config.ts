#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseSha256Sums } from "./package-manager-manifests.ts";

/** apt distribution coordinates. `stable` tracks the latest stable release. */
export const APT_CODENAME = "stable";
export const APT_COMPONENT = "main";
export const APT_ARCH = "amd64";

/** The shared package name for both the .deb and the .rpm. */
const PACKAGE_NAME = "nimbus-headless";

function stripV(version: string): string {
  return version.replace(/^v/, "");
}

/** Released `.deb` filename for a version, e.g. `nimbus-headless_1.2.3_amd64.deb`. */
export function debAssetName(version: string): string {
  return `${PACKAGE_NAME}_${stripV(version)}_${APT_ARCH}.deb`;
}

/** Released `.rpm` filename for a version, e.g. `nimbus-headless-1.2.3-x86_64.rpm`. */
export function rpmAssetName(version: string): string {
  return `${PACKAGE_NAME}-${stripV(version)}-x86_64.rpm`;
}

/**
 * The sha256 of a named asset, read from a SHA256SUMS string. Throws (fail
 * loud) if the asset is absent — we never publish an artifact we couldn't
 * verify against the release manifest.
 */
export function assetSha256(sha256SumsText: string, filename: string): string {
  const hash = parseSha256Sums(sha256SumsText).get(filename);
  if (!hash) {
    throw new Error(
      `linux-repo-config: required release asset not found in SHA256SUMS: ${filename}`,
    );
  }
  return hash;
}

export interface RepreproOptions {
  origin?: string;
  label?: string;
  description?: string;
}

/**
 * Render reprepro's `conf/distributions`. No `SignWith`: the workflow signs
 * the generated `Release` itself (detached `Release.gpg` + clearsigned
 * `InRelease`) with loopback gpg, mirroring `sign-linux-gpg.sh`.
 */
export function renderRepreproDistributions(opts: RepreproOptions = {}): string {
  const origin = opts.origin ?? "Nimbus";
  const label = opts.label ?? "Nimbus";
  const description = opts.description ?? "Nimbus headless apt repository";
  return [
    `Origin: ${origin}`,
    `Label: ${label}`,
    `Codename: ${APT_CODENAME}`,
    `Architectures: ${APT_ARCH}`,
    `Components: ${APT_COMPONENT}`,
    `Description: ${description}`,
    "",
  ].join("\n");
}

export interface YumRepoOptions {
  /** Repo root, e.g. `https://nimbus-agent.github.io/linux-repo` (trailing slash tolerated). */
  baseUrl: string;
}

/**
 * Render the yum client `.repo` file (`baseurl` -> /yum, `gpgkey` -> /gpg.key).
 *
 * `repo_gpgcheck=1` (verify the GPG-signed `repomd.xml`) is the trust anchor —
 * the same repo-metadata-signing model as the apt `[signed-by=...]` setup, and
 * it chains to per-package integrity via the checksums inside the signed
 * metadata. `gpgcheck=0` because the `.rpm` packages themselves are NOT
 * header-signed (`rpm --addsign`) — nfpm doesn't header-sign and the release
 * pipeline emits only a detached `.asc`, so `gpgcheck=1` would make `dnf` reject
 * every install with "package is not signed". Flip to `1` only once the build
 * header-signs the RPM.
 */
export function renderYumRepoFile(opts: YumRepoOptions): string {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return [
    "[nimbus]",
    "name=Nimbus headless",
    `baseurl=${base}/yum`,
    "enabled=1",
    "gpgcheck=0",
    "repo_gpgcheck=1",
    `gpgkey=${base}/gpg.key`,
    "",
  ].join("\n");
}

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

if (import.meta.main) {
  const version = parseArg("--version") ?? process.env["NIMBUS_RELEASE_VERSION"];
  const sha256SumsPath = parseArg("--sha256sums");
  const baseUrl = parseArg("--base-url") ?? "https://nimbus-agent.github.io/linux-repo";
  const distributionsPath = parseArg("--distributions-out");
  const repoFilePath = parseArg("--repo-file-out");
  if (!version || !sha256SumsPath) {
    console.error(
      "Usage: bun scripts/release/linux-repo-config.ts --version <v> --sha256sums <path> [--base-url <url>] [--distributions-out <path>] [--repo-file-out <path>]",
    );
    process.exit(1);
  }
  const sums = readFileSync(sha256SumsPath, "utf8");
  const deb = debAssetName(version);
  const rpm = rpmAssetName(version);
  const debSha = assetSha256(sums, deb);
  const rpmSha = assetSha256(sums, rpm);

  if (distributionsPath) {
    mkdirSync(dirname(distributionsPath), { recursive: true });
    writeFileSync(distributionsPath, renderRepreproDistributions(), "utf8");
  }
  if (repoFilePath) {
    mkdirSync(dirname(repoFilePath), { recursive: true });
    writeFileSync(repoFilePath, renderYumRepoFile({ baseUrl }), "utf8");
  }

  const lines = [`deb=${deb}`, `deb_sha256=${debSha}`, `rpm=${rpm}`, `rpm_sha256=${rpmSha}`];
  for (const line of lines) console.log(line);
  const ghOut = process.env["GITHUB_OUTPUT"];
  if (ghOut) appendFileSync(ghOut, `${lines.join("\n")}\n`);
}
