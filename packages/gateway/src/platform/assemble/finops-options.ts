// The per-sync FinOps and cost options the scheduler hands the cost syncables (Phase 7). Every getter reads the cost
// config at each run, so an edit takes effect on the next one. A cost config that could not be read gives `null` to
// the per-source getters: the sync then keeps its cursor whole instead of acting on defaults.
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
  };
}
