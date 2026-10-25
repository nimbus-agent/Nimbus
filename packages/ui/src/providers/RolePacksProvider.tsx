import { type ReactNode, useMemo } from "react";
import { packSections } from "../briefs/pack-sections";
import { useIpcQuery } from "../hooks/useIpcQuery";
import { RolePacksContext, type RolePacksState } from "../hooks/useRolePacks";
import type { CatalogListResult, PackListResult } from "../ipc/types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Shallow: an answer that is not this shape counts as "nothing usable yet". */
function asPackList(v: unknown): PackListResult | null {
  return isRecord(v) && Array.isArray(v["installed"]) && Array.isArray(v["skipped"])
    ? (v as unknown as PackListResult)
    : null;
}

function asCatalog(v: unknown): CatalogListResult | null {
  return isRecord(v) && Array.isArray(v["agents"]) ? (v as unknown as CatalogListResult) : null;
}

/**
 * Owns the ONE `pack.list` + `catalog.list` pair for the app, so the sidebar and the Briefs pages
 * agree on which agents are shown. The poll is the backstop; focus also refreshes, since a pack
 * is usually installed from a terminal while the window sits in the background.
 */
export function RolePacksProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const opts = { refetchOnFocus: true };
  const packsQ = useIpcQuery<PackListResult>("pack.list", 15_000, {}, opts);
  const catalogQ = useIpcQuery<CatalogListResult>("catalog.list", 15_000, {}, opts);
  const packs = asPackList(packsQ.data);
  const catalog = asCatalog(catalogQ.data);
  const catalogError = catalogQ.error;
  const value = useMemo<RolePacksState>(
    () => ({
      packs,
      catalog,
      catalogError,
      sections: packSections(packs, catalog),
      loaded: packs !== null && catalog !== null,
    }),
    [packs, catalog, catalogError],
  );
  return <RolePacksContext.Provider value={value}>{children}</RolePacksContext.Provider>;
}
