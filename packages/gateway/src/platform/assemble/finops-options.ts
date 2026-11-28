// The FinOps syncables' per-run config readers (Phase 7), kept out of `scheduler-mesh.ts` so that file stays under
// the 500-line cap. Each reader loads the layered cost config at every run, so an edit takes effect on the next
// sync; a refused cost config reads as null, which each cost sync treats as "keep the cursor unchanged".
import { loadNimbusCostFromConfigDir, type NimbusCostConfig } from "../../config/cost-toml.ts";
import { loadNimbusFinopsFromConfigDir } from "../../config/finops-toml.ts";
import type { FinopsSyncOptions } from "../../connectors/finops-syncables.ts";

export function finopsSyncOptions(configDir: string): Required<FinopsSyncOptions> {
  /** One section of the cost config, or null when the cost config is refused. */
  const section =
    <K extends "gitlab" | "bitbucket" | "jenkins" | "aws" | "gcp">(key: K) =>
    (): NimbusCostConfig[K] | null => {
      const c = loadNimbusCostFromConfigDir(configDir);
      return c.error === null ? c[key] : null;
    };
  return {
    maxSeries: (): number => loadNimbusFinopsFromConfigDir(configDir).maxSeries,
    githubOrgs: (): readonly string[] => loadNimbusCostFromConfigDir(configDir).githubOrgs,
    gitlab: section("gitlab"),
    bitbucket: section("bitbucket"),
    jenkins: section("jenkins"),
    aws: section("aws"),
    gcp: section("gcp"),
  };
}
