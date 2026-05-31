import type { RankedIndexItem } from "../index/ranked-item.ts";

export type SourceGroup = {
  service: string;
  type: string;
  count: number;
  oldestModifiedAt: number;
  newestModifiedAt: number;
};

export type ContextWindow = {
  items: RankedIndexItem[];
  sourceSummary: SourceGroup[];
  totalMatches: number;
};

function typeKey(it: RankedIndexItem): string {
  return it.indexedType;
}

function serviceTypeSortKey(it: RankedIndexItem): string {
  return `${it.service}\0${typeKey(it)}`;
}

export function buildContextWindow(
  results: readonly RankedIndexItem[],
  maxItems: number,
): ContextWindow {
  const cap = Math.min(200, Math.max(1, Math.floor(maxItems)));
  const totalMatches = results.length;
  if (totalMatches === 0) {
    return { items: [], sourceSummary: [], totalMatches: 0 };
  }
  const top = results.slice(0, cap);
  const rest = results.slice(cap);
  const restSorted = [...rest].sort((a, b) =>
    serviceTypeSortKey(a).localeCompare(serviceTypeSortKey(b)),
  );
  const sourceSummary: SourceGroup[] = [];
  for (const it of restSorted) {
    const mod = it.modifiedAt ?? 0;
    const ty = typeKey(it);
    const last = sourceSummary.at(-1);
    if (last?.service === it.service && last?.type === ty) {
      last.count += 1;
      last.oldestModifiedAt = Math.min(last.oldestModifiedAt, mod);
      last.newestModifiedAt = Math.max(last.newestModifiedAt, mod);
    } else {
      sourceSummary.push({
        service: it.service,
        type: ty,
        count: 1,
        oldestModifiedAt: mod,
        newestModifiedAt: mod,
      });
    }
  }
  sourceSummary.sort((a, b) => b.count - a.count);
  return {
    items: [...top],
    sourceSummary,
    totalMatches,
  };
}
