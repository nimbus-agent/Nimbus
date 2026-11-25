import { type ReactNode, type SubmitEvent, useState } from "react";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import { createIpcClient } from "../../ipc/client";
import type { RegistryInfoResult, RegistrySearchHit, RegistrySearchResult } from "../../ipc/types";
import { safeText } from "../incidents/safe";
import { asRegistryInfo, asRegistryList, asRegistrySearch } from "./guards";
import { RegistryTile } from "./RegistryTile";

function errorText(e: unknown): string {
  return safeText(e instanceof Error ? e.message : String(e), 300);
}

function HitRow({
  hit,
  onOpen,
}: {
  readonly hit: RegistrySearchHit;
  readonly onOpen: (hit: RegistrySearchHit) => void;
}): ReactNode {
  const version = hit.latestStable ?? hit.latestBeta ?? "";
  return (
    <li className="flex items-center gap-2 text-sm">
      <button
        type="button"
        className="underline text-left"
        aria-label={`Show ${safeText(hit.id, 128)} from ${safeText(hit.registry, 40)}`}
        onClick={() => onOpen(hit)}
      >
        {safeText(hit.name, 120)}
      </button>
      <span className="font-mono text-xs">{`${safeText(hit.id, 128)} ${safeText(version, 40)}`}</span>
      <span className="text-xs text-[var(--color-fg-muted)]">{safeText(hit.registry, 40)}</span>
      {hit.verifiedPublisher !== null && <span className="text-xs">verified</span>}
      {hit.blocked && <span className="text-xs text-red-700">blocked</span>}
      <span className="text-xs">
        {hit.quality === null ? "not scored" : `${String(hit.quality.score)}/100`}
      </span>
    </li>
  );
}

/**
 * Browse the registries: the owner's added ones and the built-in official one. Search and info each
 * fetch and verify a signed index, so they run only when the owner submits or selects, never on a
 * timer. Nothing here can install, add a registry or open a link.
 */
export function RegistryBrowse({ offline }: { readonly offline: boolean }): ReactNode {
  const list = useIpcQuery<unknown>("registry.list", 60_000);
  const registries = asRegistryList(list.data)?.registries ?? [];
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<RegistrySearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tile, setTile] = useState<{ info: RegistryInfoResult; name: string } | null>(null);
  const [tileError, setTileError] = useState<string | null>(null);

  async function onSubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const q = query.trim();
    if (q === "" || busy) return;
    setBusy(true);
    setSearchError(null);
    setTile(null);
    try {
      const res = await createIpcClient().call<unknown>("registry.search", {
        query: q,
        includeBuiltin: true,
      });
      const parsed = asRegistrySearch(res);
      setSearch(parsed);
      if (parsed === null) setSearchError("The registry search returned an unexpected reply.");
    } catch (err) {
      setSearch(null);
      setSearchError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function open(hit: RegistrySearchHit): Promise<void> {
    if (busy) return;
    setBusy(true);
    setTileError(null);
    try {
      const res = await createIpcClient().call<unknown>("registry.info", {
        id: hit.id,
        registry: hit.registry,
      });
      const parsed = asRegistryInfo(res);
      setTile(parsed === null ? null : { info: parsed, name: hit.name });
      if (parsed === null) setTileError("The registry returned an unexpected reply.");
    } catch (err) {
      setTile(null);
      setTileError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="registry-browse" className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Browse registries</h2>
      <p className="text-xs text-[var(--color-fg-muted)]">
        {registries.length === 0
          ? "Searching the built-in official registry. Add another with: nimbus registry add <name> <url>"
          : `Searching the built-in official registry and ${registries.map((r) => safeText(r.name, 40)).join(", ")}.`}
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          onSubmit(e).catch(() => undefined);
        }}
      >
        <input
          aria-label="Search registries"
          className="border rounded px-2 py-1 text-sm flex-1"
          value={query}
          maxLength={100}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="submit"
          disabled={offline || busy || query.trim() === ""}
          className="px-3 py-1 rounded bg-blue-600 text-white text-sm disabled:opacity-40"
        >
          Search
        </button>
      </form>
      {searchError !== null && <p className="text-red-600 text-sm">{searchError}</p>}
      {search?.builtinSkippedForAirGap === true && (
        <p className="text-sm text-amber-700">
          Air gap is on, so the built-in official registry was not searched.
        </p>
      )}
      {search?.errors.map((e) => (
        <p key={e.registry} className="text-sm text-amber-700">
          {`${safeText(e.registry, 40)}: ${safeText(e.error, 300)}`}
        </p>
      ))}
      {search !== null &&
        (search.results.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)]">No extension matches.</p>
        ) : (
          <ul data-testid="registry-results" className="flex flex-col gap-1">
            {search.results.map((hit) => (
              <HitRow
                key={`${hit.registry}/${hit.id}`}
                hit={hit}
                onOpen={(h) => {
                  open(h).catch(() => undefined);
                }}
              />
            ))}
          </ul>
        ))}
      {tileError !== null && <p className="text-red-600 text-sm">{tileError}</p>}
      {tile !== null && <RegistryTile info={tile.info} name={tile.name} />}
    </section>
  );
}
