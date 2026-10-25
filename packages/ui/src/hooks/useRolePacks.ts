import { createContext, useContext } from "react";
import type { PackSection } from "../briefs/pack-sections";
import type { CatalogListResult, PackListResult } from "../ipc/types";

export interface RolePacksState {
  readonly packs: PackListResult | null;
  readonly catalog: CatalogListResult | null;
  /** The message of a failed `catalog.list`; cleared by the next successful answer. */
  readonly catalogError: string | null;
  readonly sections: readonly PackSection[];
  /** True once both `pack.list` and `catalog.list` have returned data. */
  readonly loaded: boolean;
}

export const RolePacksContext = createContext<RolePacksState | null>(null);

export function useRolePacks(): RolePacksState {
  const v = useContext(RolePacksContext);
  if (v === null) throw new Error("useRolePacks must be used inside <RolePacksProvider>");
  return v;
}
