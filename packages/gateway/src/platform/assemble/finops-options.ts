// The FinOps syncables' per-run config readers (Phase 7), kept out of `scheduler-mesh.ts` so that file stays under
// the 500-line cap. Each reader loads the layered cost config at every run, so an edit takes effect on the next
// sync; a refused cost config reads as null, which each cost sync treats as "keep the cursor unchanged".
import { loadNimbusCostFromConfigDir } from "../../config/cost-toml.ts";
import { loadNimbusFinopsFromConfigDir } from "../../config/finops-toml.ts";
import type { FinopsSyncOptions } from "../../connectors/finops-syncables.ts";

export function finopsSyncOptions(configDir: string): Required<FinopsSyncOptions> {
  const cost = () => {
    const c = loadNimbusCostFromConfigDir(configDir);
    return c.error === null ? c : null;
  };
  return {
    maxSeries: (): number => loadNimbusFinopsFromConfigDir(configDir).maxSeries,
    githubOrgs: (): readonly string[] => loadNimbusCostFromConfigDir(configDir).githubOrgs,
    gitlab: () => cost()?.gitlab ?? null,
    bitbucket: () => cost()?.bitbucket ?? null,
    aws: () => cost()?.aws ?? null,
    gcp: () => cost()?.gcp ?? null,
  };
}
