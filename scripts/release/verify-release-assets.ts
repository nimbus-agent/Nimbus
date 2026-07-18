import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createGitHubApi, type GitHubApi, type ReleaseAsset } from "./gh-api.ts";

export interface LocalFile {
  readonly name: string;
  readonly size: number;
}
export interface AssetGap {
  readonly name: string;
  readonly reason: "missing" | "zero-byte";
}

export function diffReleaseAssets(
  local: readonly LocalFile[],
  remote: readonly ReleaseAsset[],
): AssetGap[] {
  const bySize = new Map(remote.map((a) => [a.name, a.size]));
  const gaps: AssetGap[] = [];
  for (const f of local) {
    if (!bySize.has(f.name)) gaps.push({ name: f.name, reason: "missing" });
    else if (bySize.get(f.name) === 0) gaps.push({ name: f.name, reason: "zero-byte" });
  }
  return gaps;
}

const REQUIRED = ["SHA256SUMS", "SHA256SUMS.asc"] as const;

export async function runVerify(deps: {
  api: GitHubApi;
  tag: string;
  local: readonly LocalFile[];
  requireSums?: boolean;
}): Promise<{ ok: boolean; gaps: AssetGap[]; summary: string }> {
  const release = await deps.api.getReleaseByTag(deps.tag);
  if (release === null) {
    return {
      ok: false,
      gaps: [],
      summary: `❌ ${deps.tag}: no release found for tag — nothing was published.`,
    };
  }
  const gaps = diffReleaseAssets(deps.local, release.assets);
  const names = new Set(release.assets.map((a) => a.name));
  const missingRequired = (deps.requireSums ?? true) ? REQUIRED.filter((r) => !names.has(r)) : [];
  const ok = gaps.length === 0 && missingRequired.length === 0;
  const lines = [
    `Release ${deps.tag}: ${release.assets.length} asset(s), ${deps.local.length} expected.`,
  ];
  for (const g of gaps) lines.push(`- ${g.reason.toUpperCase()}: ${g.name}`);
  for (const r of missingRequired) lines.push(`- REQUIRED MISSING: ${r}`);
  lines.push(ok ? "✅ all expected assets present." : "❌ release is incomplete.");
  return { ok, gaps, summary: lines.join("\n") };
}

function listStage(stageDir: string): LocalFile[] {
  return readdirSync(stageDir).map((name) => ({ name, size: statSync(join(stageDir, name)).size }));
}

if (import.meta.main) {
  const tag = process.env["GITHUB_REF_NAME"];
  const repo = process.env["GITHUB_REPOSITORY"];
  const token = process.env["GITHUB_TOKEN"];
  const stageDir = process.env["STAGE_DIR"] ?? "dist/stage";
  if (!tag || !repo || !token) {
    console.error(
      "verify-release-assets: GITHUB_REF_NAME, GITHUB_REPOSITORY, GITHUB_TOKEN required",
    );
    process.exit(2);
  }
  const api = createGitHubApi({ token, repo });
  const result = await runVerify({ api, tag, local: listStage(stageDir) });
  console.log(result.summary);
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath)
    await Bun.write(
      summaryPath,
      `## Release asset verification — ${tag}\n\n\`\`\`\n${result.summary}\n\`\`\`\n`,
    );
  process.exit(result.ok ? 0 : 1);
}
