/**
 * Every `releases/latest/download/<name>` URL we publish must name an asset the
 * release workflow actually stages.
 *
 * Why this exists: six documented download URLs were dead at once — `install.ps1`
 * and `uninstall.ps1` (never staged as standalone assets, only bundled inside the
 * Windows .zip, so the README's entire Windows quickstart 404'd), plus
 * `Nimbus-x86_64.AppImage{,.asc}` and `nimbus_amd64.deb{,.asc}` (the docs use
 * unversioned names, the workflow emits versioned ones, and
 * `latest/download/<name>` resolves an EXACT name rather than globbing).
 *
 * Nothing caught it. `audit:links` checks that URLs are well-formed and reachable
 * as pages, and `verify-release-assets` compares a release against what was staged
 * for it — neither can see an asset that was never staged in the first place. The
 * gap is between what the DOCS promise and what the WORKFLOW produces, so that is
 * what this compares.
 */

/** A `cp <src> dist/stage/<dest>` in the workflow's staging step. */
const STAGE_CP = /^\s*cp\s+"?([^"\s]+)"?\s+"?dist\/stage\/([^"\s]*)"?\s*$/gm;

/** A wholesale `cp dist/<dir>/* dist/stage/`, which promotes everything in <dir>. */
const WHOLESALE_CP = /^\s*cp\s+dist\/([A-Za-z0-9_-]+)\/\*\s+dist\/stage\/\s*$/gm;

/**
 * A literal filename written into one of those directories.
 *
 * Both path forms appear: `tar -czf dist/archives/x.tar.gz` (repo-root-relative)
 * and `(cd dist/stage-windows-x64 && zip -r ../archives/x.zip .)` (relative to a
 * subdirectory). Matching only the first form silently missed the Windows .zip.
 */
function literalsInDir(yaml: string, dir: string): string[] {
  const re = new RegExp(`(?:\\.\\./|dist/)${dir}/([A-Za-z0-9][A-Za-z0-9._-]*\\.[A-Za-z0-9]+)`, "g");
  return [...yaml.matchAll(re)].map((m) => m[1] ?? "");
}

/**
 * Asset names the release workflow stages under a literal, predictable filename.
 *
 * Only literal destinations count. `cp dist/installers/* dist/stage/` expands at
 * run time to names this cannot know, so globs are deliberately NOT treated as
 * satisfying a documented URL — that permissiveness is exactly what let the
 * versioned-vs-unversioned AppImage mismatch survive.
 */
export function stagedAssetNames(releaseWorkflowYaml: string): Set<string> {
  const names = new Set<string>();

  const add = (name: string): void => {
    // Globs expand at run time and `${VAR}` interpolates — neither is a name we
    // can promise in a doc, so neither counts.
    if (name === "" || name.includes("*") || name.includes("$")) return;
    names.add(name);
  };

  for (const m of releaseWorkflowYaml.matchAll(STAGE_CP)) {
    const src = m[1] ?? "";
    const dest = m[2] ?? "";
    // `cp <src> dist/stage/` keeps the source basename; `cp <src> dist/stage/<x>` renames.
    add(dest === "" ? (src.split("/").pop() ?? "") : dest);
  }

  // A directory copied wholesale into dist/stage promotes every literal filename
  // the workflow writes into it — e.g. `tar -czf dist/archives/foo.tar.gz` is a
  // real release asset even though nothing ever names it next to `dist/stage/`.
  const wholesale = new Set<string>();
  for (const m of releaseWorkflowYaml.matchAll(WHOLESALE_CP)) {
    if (m[1] !== undefined) wholesale.add(m[1]);
  }
  for (const dir of wholesale) {
    for (const file of literalsInDir(releaseWorkflowYaml, dir)) add(file);
  }

  return names;
}

/** This repository, as it appears in a `github.com/<owner>/<repo>/` download URL. */
const OWN_REPO = "nimbus-agent/nimbus";

/**
 * Every distinct `releases/latest/download/<name>` filename referenced in docs.
 *
 * The owner/repo prefix is captured when present so a URL naming a DIFFERENT
 * repository can be skipped. This checker is about assets *we* stage, and a doc
 * that tells a reader to fetch a third-party CLI from its own GitHub release is
 * not a dead Nimbus asset — it is noise, and noise in a release gate gets the
 * gate ignored. (Found by exactly that: a plan doc quoting the MCP registry's
 * `mcp-publisher` install command failed the suite.)
 *
 * A missing prefix still counts as ours. Bare (`releases/latest/download/x`, how
 * `docs/CHANGELOG.md` writes it in prose) and elided (`.../releases/...`) forms
 * carry no repo to check, and unqualified in this repo's docs they mean Nimbus —
 * so the permissive default is the safe one. The consequence, accepted
 * deliberately: a foreign URL written WITHOUT its `github.com/owner/repo/`
 * prefix is still treated as ours. That is a false positive rather than a false
 * negative, which is the direction this gate should err in.
 */
export function documentedAssetNames(
  docs: readonly { path: string; text: string }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re =
    /(?:github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/)?releases\/latest\/download\/([A-Za-z0-9._-]+)/g;
  for (const d of docs) {
    for (const m of d.text.matchAll(re)) {
      const repo = m[1];
      const name = m[2];
      if (name === undefined) continue;
      if (repo !== undefined && repo.toLowerCase() !== OWN_REPO) continue;
      const where = out.get(name) ?? [];
      if (!where.includes(d.path)) where.push(d.path);
      out.set(name, where);
    }
  }
  return out;
}

export interface DeadUrl {
  name: string;
  referencedIn: string[];
}

/**
 * Documented names with no literal staging destination.
 *
 * `SHA256SUMS` / `SHA256SUMS.asc` are generated by later workflow steps rather
 * than copied, so they are known-good and excluded rather than special-cased at
 * the regex level.
 */
const GENERATED_NOT_COPIED = new Set(["SHA256SUMS", "SHA256SUMS.asc"]);

export function findDeadDocumentedUrls(
  documented: Map<string, string[]>,
  staged: Set<string>,
): DeadUrl[] {
  const dead: DeadUrl[] = [];
  for (const [name, referencedIn] of documented) {
    if (GENERATED_NOT_COPIED.has(name)) continue;
    if (!staged.has(name)) dead.push({ name, referencedIn });
  }
  return dead.sort((a, b) => a.name.localeCompare(b.name));
}
