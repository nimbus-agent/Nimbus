import type { HttpResponse } from "./http.ts";
import type { Pagination } from "./pagination.ts";

export interface RunConnectorSyncOptions<S, B, Item> {
  readonly pagination: Pagination<S>;
  readonly fetchPage: (state: S | undefined) => Promise<HttpResponse<B>>;
  readonly mapBody: (body: B) => Item[];
  readonly onItem: (item: Item) => Promise<void>;
  readonly pageLimit?: number;
}

export interface SyncResult {
  readonly pageCount: number;
  readonly itemCount: number;
}

export async function runConnectorSync<S, B, Item>(
  opts: RunConnectorSyncOptions<S, B, Item>,
): Promise<SyncResult> {
  let state: S | undefined = opts.pagination.initialState();
  let pageCount = 0;
  let itemCount = 0;
  const limit = opts.pageLimit ?? Number.POSITIVE_INFINITY;

  while (pageCount < limit) {
    const response = await opts.fetchPage(state);
    pageCount += 1;
    for (const item of opts.mapBody(response.body)) {
      await opts.onItem(item);
      itemCount += 1;
    }
    const next = opts.pagination.nextState(state, response);
    if (next === undefined) break;
    state = next;
  }
  return { pageCount, itemCount };
}
