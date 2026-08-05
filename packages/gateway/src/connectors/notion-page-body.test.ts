import { expect, test } from "bun:test";

import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { describeWithFetchRestore, urlFromFetchInput } from "./connector-sync-test-helpers.ts";
import {
  fetchNotionPageText,
  NOTION_BODY_REQUESTS_PER_PAGE_MAX,
  notionBlockOwnText,
  notionRichTextToPlain,
} from "./notion-page-body.ts";

function para(id: string, text: string, hasChildren = false): Record<string, unknown> {
  return {
    id,
    type: "paragraph",
    has_children: hasChildren,
    paragraph: { rich_text: [{ type: "text", plain_text: text }] },
  };
}

function bullet(id: string, text: string, hasChildren = false): Record<string, unknown> {
  return {
    id,
    type: "bulleted_list_item",
    has_children: hasChildren,
    bulleted_list_item: { rich_text: [{ type: "text", plain_text: text }] },
  };
}

/** Route block-children requests by parent block id, taken from the URL path. */
function routedFetch(byParent: Record<string, unknown[]>, status = 200): typeof fetch {
  return ((input: Parameters<typeof fetch>[0]) => {
    const url = urlFromFetchInput(input);
    const m = /\/v1\/blocks\/([^/]+)\/children/.exec(url);
    const parent = m?.[1] ?? "";
    if (status !== 200) {
      return Promise.resolve(new Response("{}", { status }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ results: byParent[parent] ?? [], has_more: false, next_cursor: null }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
}

function deps(budgetLeft = 100) {
  return {
    accessToken: "tok",
    // Real Notion quota (burst 5) would force these tests to wait on real
    // wall-clock refills once a test issues more than 5 requests (e.g. the
    // per-page cap test issues NOTION_BODY_REQUESTS_PER_PAGE_MAX = 10).
    // Same override pattern as zoom-sync.test.ts's `fastLimiter`.
    rateLimiter: new ProviderRateLimiter({
      notion: { requestsPerMinute: 6000, burstSize: 100 },
    }),
    budget: { left: budgetLeft },
  };
}

describeWithFetchRestore("notion-page-body", () => {
  test("notionRichTextToPlain joins plain_text and ignores junk", () => {
    expect(
      notionRichTextToPlain([{ plain_text: "a" }, "junk", { type: "text" }, { plain_text: "b" }]),
    ).toBe("ab");
    expect(notionRichTextToPlain("not-an-array")).toBe("");
  });

  test("notionBlockOwnText reads the type-keyed rich_text", () => {
    expect(notionBlockOwnText(para("b1", "hello"))).toBe("hello");
    expect(notionBlockOwnText({ id: "x" })).toBe("");
    expect(notionBlockOwnText({ id: "x", type: "divider" })).toBe("");
  });

  test("notionBlockOwnText reads table_row cells, joined", () => {
    expect(
      notionBlockOwnText({
        id: "r1",
        type: "table_row",
        table_row: {
          cells: [[{ plain_text: "CDR" }], [{ plain_text: "change data record" }], []],
        },
      }),
    ).toBe("CDR | change data record");
  });

  test("notionBlockOwnText falls back to caption when there is no rich_text", () => {
    expect(
      notionBlockOwnText({
        id: "i1",
        type: "image",
        image: { caption: [{ plain_text: "the deploy topology" }] },
      }),
    ).toBe("the deploy topology");
  });

  test("notionBlockOwnText returns empty for a table_row with no cells array", () => {
    expect(notionBlockOwnText({ id: "r2", type: "table_row", table_row: {} })).toBe("");
  });

  test("collects top-level text and reports complete", async () => {
    globalThis.fetch = routedFetch({ p1: [para("b1", "one"), para("b2", "two")] });
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("one\ntwo");
    expect(r.outcome).toBe("complete");
  });

  test("follows a container into its children", async () => {
    globalThis.fetch = routedFetch({
      p1: [{ id: "c1", type: "column_list", has_children: true, column_list: {} }],
      c1: [para("b1", "inner")],
    });
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("inner");
    expect(r.outcome).toBe("complete");
  });

  test("a list item with children yields its own text AND its sub-bullets, in order", async () => {
    globalThis.fetch = routedFetch({
      p1: [bullet("b1", "parent", true)],
      b1: [bullet("b2", "child")],
    });
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("parent\nchild");
  });

  test("does not follow child_page or child_database", async () => {
    const seen: string[] = [];
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      seen.push(urlFromFetchInput(input));
      const url = urlFromFetchInput(input);
      const results = url.includes("/p1/")
        ? [
            { id: "sub", type: "child_page", has_children: true, child_page: { title: "Sub" } },
            { id: "dbx", type: "child_database", has_children: true, child_database: {} },
          ]
        : [];
      return Promise.resolve(
        new Response(JSON.stringify({ results, has_more: false, next_cursor: null }), {
          status: 200,
        }),
      );
    }) as typeof fetch;
    const r = await fetchNotionPageText(deps(), "p1");
    expect(seen).toHaveLength(1);
    expect(r.outcome).toBe("complete");
  });

  test("toggle -> list -> sub-list resolves fully at depth 3", async () => {
    globalThis.fetch = routedFetch({
      p1: [
        {
          id: "t1",
          type: "toggle",
          has_children: true,
          toggle: { rich_text: [{ plain_text: "Decisions" }] },
        },
      ],
      t1: [bullet("b1", "L1", true)],
      b1: [bullet("b2", "L2")],
    });
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("Decisions\nL1\nL2");
    expect(r.outcome).toBe("complete");
  });

  test("stops at depth 3 and reports capped", async () => {
    globalThis.fetch = routedFetch({
      p1: [bullet("b1", "L1", true)],
      b1: [bullet("b2", "L2", true)],
      b2: [bullet("b3", "L3", true)],
      b3: [bullet("b4", "L4")],
    });
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("L1\nL2\nL3");
    expect(r.outcome).toBe("capped");
  });

  test("a table's rows are collected", async () => {
    globalThis.fetch = routedFetch({
      p1: [{ id: "tb1", type: "table", has_children: true, table: { table_width: 2 } }],
      tb1: [
        {
          id: "r1",
          type: "table_row",
          has_children: false,
          table_row: { cells: [[{ plain_text: "CDR" }], [{ plain_text: "change data record" }]] },
        },
      ],
    });
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("CDR | change data record");
    expect(r.outcome).toBe("complete");
  });

  test("paginates block children via start_cursor", async () => {
    let call = 0;
    globalThis.fetch = (() => {
      call += 1;
      const first = call === 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [para(`b${String(call)}`, first ? "one" : "two")],
            has_more: first,
            next_cursor: first ? "CUR" : null,
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("one\ntwo");
    expect(call).toBe(2);
  });

  test("caps a single page at NOTION_BODY_REQUESTS_PER_PAGE_MAX requests", async () => {
    let call = 0;
    globalThis.fetch = (() => {
      call += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [para(`b${String(call)}`, "x")],
            has_more: true,
            next_cursor: "CUR",
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;
    const r = await fetchNotionPageText(deps(), "p1");
    expect(call).toBe(NOTION_BODY_REQUESTS_PER_PAGE_MAX);
    expect(r.outcome).toBe("capped");
  });

  test("the global budget never truncates a page mid-walk, even once it goes negative", async () => {
    // deps(2) starts the sync-wide budget far below what this page needs (5
    // paginated requests). The budget is checked by the CALLER before starting a
    // page, never inside the walk — so a page already in progress must run to
    // completion regardless of how far left goes negative. Asserting the exact
    // fetch count is what would catch a regression like an added
    // `if (deps.budget.left <= 0) return;` inside collectChildren's loop: such a
    // change wouldn't show up as a coverage gap (budget.left has no existing
    // conditional), but it WOULD change this call count.
    const totalRequests = 5;
    let call = 0;
    globalThis.fetch = (() => {
      call += 1;
      const isLast = call === totalRequests;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [para(`b${String(call)}`, `t${String(call)}`)],
            has_more: !isLast,
            next_cursor: isLast ? null : "CUR",
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;
    const d = deps(2);
    const r = await fetchNotionPageText(d, "p1");
    expect(call).toBe(totalRequests);
    expect(r.outcome).toBe("complete");
    expect(r.text).toBe("t1\nt2\nt3\nt4\nt5");
    expect(d.budget.left).toBe(2 - totalRequests);
  });

  test("a 429 returns errored and zeroes the remaining budget", async () => {
    globalThis.fetch = routedFetch({}, 429);
    const d = deps(100);
    const r = await fetchNotionPageText(d, "p1");
    expect(r.outcome).toBe("errored");
    expect(d.budget.left).toBe(0);
  });

  test("a non-429 error returns errored and leaves the budget alone", async () => {
    globalThis.fetch = routedFetch({}, 500);
    const d = deps(100);
    const r = await fetchNotionPageText(d, "p1");
    expect(r.outcome).toBe("errored");
    expect(d.budget.left).toBe(99);
  });

  test("invalid JSON returns errored", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("not json", { status: 200 }))) as unknown as typeof fetch;
    expect((await fetchNotionPageText(deps(), "p1")).outcome).toBe("errored");
  });

  test("a malformed results field returns errored", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: "nope" }), { status: 200 }),
      )) as unknown as typeof fetch;
    expect((await fetchNotionPageText(deps(), "p1")).outcome).toBe("errored");
  });

  test("a later request on the same page preserves earlier gathered text on error", async () => {
    // fetchNotionPageText's contract: "a failure returns whatever text was
    // gathered." Every other errored test fails on the FIRST request, so `out`
    // is empty in all of them — none actually exercises the "partial text
    // survives" half of the contract. Here the first paginated request
    // succeeds and contributes text, then the second (same page, via
    // start_cursor) fails.
    let call = 0;
    globalThis.fetch = (() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [para("b1", "first")],
              has_more: true,
              next_cursor: "CUR",
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 500 }));
    }) as unknown as typeof fetch;
    const r = await fetchNotionPageText(deps(), "p1");
    expect(call).toBe(2);
    expect(r.outcome).toBe("errored");
    expect(r.text).toBe("first");
  });

  test("a non-object JSON root returns errored", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([1, 2, 3]), { status: 200 }),
      )) as unknown as typeof fetch;
    expect((await fetchNotionPageText(deps(), "p1")).outcome).toBe("errored");
  });

  test("skips non-record and untyped entries", async () => {
    globalThis.fetch = routedFetch({ p1: ["junk", { id: "x" }, para("b1", "kept")] });
    expect((await fetchNotionPageText(deps(), "p1")).text).toBe("kept");
  });

  test("skips a has_children block with no id", async () => {
    globalThis.fetch = routedFetch({
      p1: [{ type: "toggle", has_children: true, toggle: { rich_text: [] } }],
    });
    expect((await fetchNotionPageText(deps(), "p1")).outcome).toBe("complete");
  });

  test("reports bytes transferred", async () => {
    globalThis.fetch = routedFetch({ p1: [para("b1", "one")] });
    expect((await fetchNotionPageText(deps(), "p1")).bytes).toBeGreaterThan(0);
  });
});
