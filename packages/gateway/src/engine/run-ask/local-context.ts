import type { PointInTimeFacts } from "../../index/item-history-at.ts";
import { escapeLikeLiteral } from "../../index/item-store.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { RankedIndexItem } from "../../index/ranked-item.ts";
import { describeRetrieval } from "../../index/search-retrieval.ts";
import type { ContributingPass, LocalCandidate, PrimaryRetrieval } from "../ask-explain-types.ts";
import { capPerService, stripInternalRankField } from "../context-fairness.ts";
import type { ContextTruncation } from "../context-truncation-disclosure.ts";
import { fallbackSearchTerms, questionSearchTerms } from "../question-search-terms.ts";
import { wrapToolOutput } from "../tool-output-envelope.ts";
import {
  buildCandidatePool,
  type DiscardedTailEntry,
  summarizeDiscardedTail,
} from "./candidate-pool.ts";
import {
  cleanContextText,
  clipContextText,
  LOCAL_CONTEXT_PREVIEW_MAX_CHARS,
  type LocalContextItem,
} from "./context-item.ts";
import { runAskLog } from "./log.ts";

const DEFAULT_LOCAL_CONTEXT_ITEM_LIMIT = 8;

/**
 * How many indexed items `ask` puts in front of the model.
 *
 * The default of 8 was sized for a small local model and is kept as-is, so no
 * existing deployment changes behaviour. It is a ceiling on the ANSWER, not on
 * the search: with a larger local model (a 14B-class one holds a 128k window)
 * the cap, not the model, is what makes `ask` say it has no data while dozens
 * of items match — the disclosure note below reports exactly that shortfall.
 * Raise it via NIMBUS_ASK_CONTEXT_ITEMS when the configured model can hold more.
 *
 * Read per call rather than cached so a caller can change it without a restart;
 * a non-positive or unparseable value falls back to the default instead of
 * throwing, since a malformed override must not make `ask` unusable.
 */
export function resolveLocalContextItemLimit(): number {
  const raw = process.env["NIMBUS_ASK_CONTEXT_ITEMS"];
  if (raw === undefined || raw === "") return DEFAULT_LOCAL_CONTEXT_ITEM_LIMIT;
  // Number(), not parseInt(): parseInt stops at the first non-digit, so "40ms"
  // would silently become a budget of 40 and "1.5" a budget of 1.
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return DEFAULT_LOCAL_CONTEXT_ITEM_LIMIT;
  return n;
}
/**
 * How far the primary ranked search looks before the context is sliced to
 * {@link resolveLocalContextItemLimit}.
 *
 * The context budget defaults to 8; this exists only so the answer can SAY how much it left out.
 * Before it, the search itself asked for 8, so nothing downstream could tell "8 matches" from
 * "800 matches, of which you are seeing 8" — and `ask` served the second as the first.
 *
 * A ceiling rather than a full count because the ranked search fuses FTS with vector hits and
 * has no cheap `COUNT(*)`. When the probe comes back full the total is reported as a FLOOR
 * ("at least 100"), never as an exact number the query cannot support.
 */
const LOCAL_CONTEXT_TOTAL_PROBE_LIMIT = 100;
const LOCAL_CONTEXT_QUOTED_QUERY_LIMIT = 4;

function extractQuotedSearchQueries(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(/["'`]([^"'`]{3,120})["'`]/g)) {
    const query = cleanContextText(match[1] ?? "");
    const key = query.toLowerCase();
    if (query !== "" && !seen.has(key)) {
      seen.add(key);
      out.push(query);
    }
    if (out.length >= LOCAL_CONTEXT_QUOTED_QUERY_LIMIT) {
      break;
    }
  }
  return out;
}

function extractGithubRepoSlugs(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/g)) {
    const slug = (match[1] ?? "").toLowerCase();
    if (slug !== "" && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

function formatContextItem(
  localIndex: LocalIndex,
  item: RankedIndexItem,
): Omit<LocalContextItem, "rank"> {
  const title = cleanContextText(item.name);
  const preview = cleanContextText(
    item.semanticSnippet ?? localIndex.getBodyPreview(item.indexPrimaryKey) ?? "",
  );
  const url = cleanContextText(item.canonicalUrl ?? item.url ?? "");
  return {
    sourceId: item.indexPrimaryKey,
    service: item.service,
    indexedType: item.indexedType,
    title,
    ...(preview === ""
      ? {}
      : { preview: clipContextText(preview, LOCAL_CONTEXT_PREVIEW_MAX_CHARS) }),
    ...(url === "" ? {} : { url }),
    ...(item.asOf === undefined ? {} : { asOf: item.asOf }),
  };
}

type GithubIssueContextRow = {
  id: string;
  service: string;
  type: string;
  title: string;
  body_preview: string | null;
  url: string | null;
};

function githubIssueContextItemsForRepo(
  localIndex: LocalIndex,
  repoSlug: string,
): Array<Omit<LocalContextItem, "rank">> {
  // Issues AND PRs (F12a). This filtered to `type = 'issue'`, so asking about a repo silently
  // excluded every pull request — and on the audited index `github`/`issue` held ZERO rows, so
  // the path contributed nothing at all while 16 PRs sat unreachable.
  // `_` (legal in a slug) and `%` are LIKE wildcards: escape them, and say so with ESCAPE.
  const escapedSlug = escapeLikeLiteral(repoSlug);
  const like = `${escapedSlug}#%`;
  // Host-agnostic on purpose: the service filter below already restricts to `github` rows, and a
  // gateway serves github.com OR one GitHub Enterprise Server, so a GHES `html_url` must match too.
  const urlLike = `%/${escapedSlug}/%`;
  const rows = localIndex
    .getDatabase()
    .query(
      String.raw`SELECT id, service, type, title, body_preview, url
       FROM item
       WHERE service = 'github'
         AND type IN ('issue', 'pr')
         AND (lower(external_id) LIKE ? ESCAPE '\' OR lower(url) LIKE ? ESCAPE '\')
       ORDER BY modified_at DESC, synced_at DESC, title ASC
       LIMIT ?`,
    )
    .all(like, urlLike, resolveLocalContextItemLimit()) as GithubIssueContextRow[];
  return rows.map((row) => {
    const preview = cleanContextText(row.body_preview ?? "");
    const url = cleanContextText(row.url ?? "");
    return {
      sourceId: row.id,
      service: row.service,
      indexedType: row.type,
      title: cleanContextText(row.title),
      ...(preview === ""
        ? {}
        : { preview: clipContextText(preview, LOCAL_CONTEXT_PREVIEW_MAX_CHARS) }),
      ...(url === "" ? {} : { url }),
    };
  });
}

export interface LocalIndexedContext {
  readonly text: string;
  readonly truncation: ContextTruncation;
  readonly explain: {
    readonly searchTerms: string;
    readonly primaryRetrieval: PrimaryRetrieval;
    readonly fallbackTermFired?: string;
    readonly pool: LocalCandidate[];
    readonly discardedTail: DiscardedTailEntry[];
  };
}

/**
 * `searched` (point-in-time turns): receives the facts of EVERY keyword search the build ran (primary, quoted,
 * fallback), pushed as each ran, so they survive a build that returns no context and a context whose items came
 * from a supplementary search.
 */
export async function buildLocalIndexedContext(
  localIndex: LocalIndex,
  input: string,
  atMs?: number,
  searched?: PointInTimeFacts[],
): Promise<LocalIndexedContext | undefined> {
  const query = input.trim();
  if (query === "") {
    return undefined;
  }
  try {
    const byId = new Map<string, Omit<LocalContextItem, "rank">>();
    const passById = new Map<string, ContributingPass>();
    // The scores survive ONLY here — `formatContextItem` drops them, and `byId` never gets
    // them back (spec §2.4).
    const rankedById = new Map<string, RankedIndexItem>();
    const addRankedResults = (items: RankedIndexItem[], pass: ContributingPass): void => {
      for (const item of items) {
        if (!byId.has(item.indexPrimaryKey)) {
          byId.set(item.indexPrimaryKey, formatContextItem(localIndex, item));
          passById.set(item.indexPrimaryKey, pass);
          rankedById.set(item.indexPrimaryKey, item);
        }
      }
    };
    const addContextItems = (
      items: Array<Omit<LocalContextItem, "rank">>,
      pass: ContributingPass,
    ): void => {
      for (const item of items) {
        if (!byId.has(item.sourceId)) {
          byId.set(item.sourceId, item);
          passById.set(item.sourceId, pass);
          // Deliberately NOT added to rankedById: these rows were never scored (spec §2.4).
        }
      }
    };
    // The SENTENCE is not a search term (F1). `ftsTitleMatchQuery` AND-joins every whitespace
    // token and keeps punctuation, so "what does egressRowToItem do?" contains `"do?"` — a
    // prefix term nothing matches — and the whole conjunction is unsatisfiable even though the
    // symbol is indexed and trivially findable on its own.
    const searchTerms = questionSearchTerms(query);
    if (searchTerms === undefined) {
      return undefined;
    }
    // Probe wide, serve narrow. `primary.length` is the only honest source for "how many
    // match" — every other search below is itself capped, so counting `byId` would just
    // re-measure the truncation instead of the substrate.
    // Every search below carries the instant when there is one: a time-travel context must never mix in
    // a row the index did not hold then.
    const at = atMs === undefined ? {} : { atMs };
    const primarySearch = await localIndex.searchRankedAsync(
      { name: searchTerms, limit: LOCAL_CONTEXT_TOTAL_PROBE_LIMIT, ...at },
      { semantic: true, contextChunks: 2 },
    );
    const primary = primarySearch.items;
    if (primarySearch.pointInTime !== undefined) searched?.push(primarySearch.pointInTime);
    // The supplementary searches' gap facts: `searchRanked` returns items only.
    const noteFacts = (name: string, limit: number): void => {
      if (atMs === undefined || searched === undefined) return;
      const facts = localIndex.pointInTimeFacts({ name, limit, atMs });
      if (facts !== undefined) searched.push(facts);
    };
    addRankedResults(primary.slice(0, resolveLocalContextItemLimit()), { kind: "primary-hybrid" });
    for (const quotedQuery of extractQuotedSearchQueries(query)) {
      noteFacts(quotedQuery, resolveLocalContextItemLimit());
      addRankedResults(
        localIndex.searchRanked({
          name: quotedQuery,
          limit: resolveLocalContextItemLimit(),
          ...at,
        }),
        { kind: "quoted", query: quotedQuery },
      );
    }
    // The repo-slug pass reads the CURRENT issue and PR list with raw SQL: skipped on a point-in-time turn.
    for (const repoSlug of atMs === undefined ? extractGithubRepoSlugs(query) : []) {
      addContextItems(githubIssueContextItemsForRepo(localIndex, repoSlug), {
        kind: "repo-slug",
        slug: repoSlug,
      });
    }
    let fallbackTermFired: string | undefined;
    if (byId.size === 0) {
      // The AND join is strict enough that three reasonable words routinely describe a document
      // containing only two — "what should I do for the smoke test issue?" misses an item titled
      // "add a smoke test" on `issue`, which is its TYPE and appears in neither its title nor
      // its body. Retry with the single most distinctive term: the same question with the
      // strictest part relaxed, not a different one.
      for (const term of fallbackSearchTerms(searchTerms)) {
        noteFacts(term, LOCAL_CONTEXT_TOTAL_PROBE_LIMIT);
        // The PROBE limit, not the context limit: `capPerService` below can only balance the pool
        // it is handed, and fetching eight rows from a service holding 11,979 of them returns
        // eight rows from that service. Widening here is what gives the cap something to choose
        // between; the slice back to eight still happens after it.
        addRankedResults(
          localIndex.searchRanked({ name: term, limit: LOCAL_CONTEXT_TOTAL_PROBE_LIMIT, ...at }),
          {
            kind: "fallback-term",
            term,
          },
        );
        if (byId.size > 0) {
          fallbackTermFired = term;
          break;
        }
      }
    }
    // The no-name fallback is GONE (F1, fix 2). `searchRanked` with no `name` sets
    // `useFts = false` and returns arbitrary recent items, which were then handed to the model
    // under an authoritative "Indexed Nimbus context:" header inside a `<tool_output>` envelope.
    //
    // That is how `ask` answered a question about the user's Fargate log groups with a list of
    // `microsoft/winget-pkgs` CI runs: the term matched nothing, the fallback fetched whatever
    // was recent, `github_actions` is the highest-volume service, and the model answered the
    // question it was asked using the only data it was given — even tagging each row
    // "(GitHub Actions)". It reported its source honestly; the retrieval layer had asserted a
    // relevance it did not have. No prompt change fixes that, and no context is better than
    // confident, specific, false claims about someone's production infrastructure.
    if (byId.size === 0) {
      return undefined;
    }
    // Round-robin across services before slicing (F12b): `github_actions` held 11,979 items to
    // `github`'s 214 on the audited index, so the eight highest-ranked were all CI runs and a
    // question about a repo never saw a PR.
    const contextItems = capPerService([...byId.values()], resolveLocalContextItemLimit()).map(
      (item, idx) => ({ ...item, rank: idx + 1 }),
    );

    const pool = buildCandidatePool({
      byId,
      passById,
      rankedById,
      primary,
      shownIds: new Set(contextItems.map((i) => i.sourceId)),
      limit: resolveLocalContextItemLimit(),
    });
    const discardedTail = summarizeDiscardedTail(pool);

    return {
      // `rank` is stripped before serialising (F12c). It is internal relevance ordering, the
      // envelope carries no schema to say so, and models reported it as data — "PR #414691 is
      // ranked 1st" for GitHub, and for CloudWatch an invented "priority within the RequiemNexus
      // infrastructure". Deleting the field works for every model; a prompt rule would not.
      text: `Indexed Nimbus context:\n${wrapToolOutput(
        { service: "nimbus", tool: "localIndex.searchRanked" },
        stripInternalRankField(contextItems),
      )}`,
      truncation: {
        shown: contextItems.length,
        // `byId` can hold more than the probe found — the quoted-query and repo-slug passes
        // add items the primary search missed — so the total is the larger of the two. It is
        // still a floor, never an upper bound on what the index holds.
        total: Math.max(primary.length, byId.size),
        atLeast: primary.length >= LOCAL_CONTEXT_TOTAL_PROBE_LIMIT,
      },
      explain: {
        searchTerms,
        primaryRetrieval: {
          ...primarySearch.retrieval,
          notes: describeRetrieval(primarySearch.retrieval),
        },
        ...(fallbackTermFired === undefined ? {} : { fallbackTermFired }),
        pool,
        discardedTail,
      },
    };
  } catch (e) {
    runAskLog.warn({ err: e }, "failed to build local indexed context for local LLM");
    return undefined;
  }
}
