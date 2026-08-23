/**
 * Two shaping rules applied to `buildLocalIndexedContext`'s items before they reach the model.
 *
 * Both are F12. Neither is about relevance — the search already decided that — they are about
 * what a fixed-size budget does to a lopsided index, and about which of our own fields the model
 * is allowed to see.
 */

/** The subset both helpers need. Kept structural so `LocalContextItem` stays private to run-ask. */
interface ServiceScoped {
  readonly service: string;
}

/**
 * Round-robin across services, so one high-volume service cannot take the whole budget (F12b).
 *
 * Measured cause: `github_actions` held 11,979 indexed items against `github`'s 214, so a
 * question about a repo came back answered entirely from CI runs — the eight highest-ranked
 * items were all workflow runs, and the PRs the question was about never entered the context.
 * The model then answered the question it was asked from the only data it was given, and even
 * tagged each row "(GitHub Actions)".
 *
 * Round-robin rather than a fixed per-service quota: a quota has to be chosen without knowing how
 * many services matched, and is wrong in both directions — too small starves a single-service
 * result, too large is no cap at all. Taking one item per service per pass gives every matched
 * service a place before any service gets a second, and degrades to "unchanged" when only one
 * service matched.
 *
 * Relevance order WITHIN a service is preserved: the input is already ranked, and reshuffling it
 * would discard the ordering the search just computed.
 */
/**
 * Group by service in input order, so each bucket keeps the relevance ordering search computed.
 *
 * Split out of `capPerService` for cognitive complexity (S3776): the grouping and the round-robin
 * drain are independent steps, and reading either one no longer means holding the other in mind.
 */
function bucketByService<T extends ServiceScoped>(items: readonly T[]): Map<string, T[]> {
  const byService = new Map<string, T[]>();
  for (const item of items) {
    const bucket = byService.get(item.service);
    if (bucket === undefined) byService.set(item.service, [item]);
    else bucket.push(item);
  }
  return byService;
}

export function capPerService<T extends ServiceScoped>(items: readonly T[], limit: number): T[] {
  const byService = bucketByService(items);
  if (byService.size <= 1) return items.slice(0, limit);

  const out: T[] = [];
  const queues = [...byService.values()];
  let round = 0;
  while (out.length < limit) {
    let tookAny = false;
    for (const q of queues) {
      const next = q[round];
      if (next === undefined) continue;
      out.push(next);
      tookAny = true;
      if (out.length >= limit) break;
    }
    if (!tookAny) break;
    round++;
  }
  return out;
}

/**
 * Remove `rank` before serialising into the `<tool_output>` envelope (F12c).
 *
 * `rank` is internal relevance ordering with no meaning to a user, and the envelope carries no
 * schema to say so. Handed a field called `rank`, models explained it — twice, on unrelated
 * datasets: "PR #414691 is ranked 1st" for GitHub, and for CloudWatch, "the log groups also
 * contain a 'rank' value, which suggests ... a specific ordering or priority within the
 * RequiemNexus infrastructure". Both are reasonable readings of an unexplained field.
 *
 * Deleting the field beats instructing the model not to mention it: a prompt rule has to be
 * followed, and this one has to work for every model including ones that never read it.
 */
export function stripInternalRankField<T extends { rank?: number }>(
  items: readonly T[],
): Array<Omit<T, "rank">> {
  return items.map(({ rank: _rank, ...rest }) => rest);
}
