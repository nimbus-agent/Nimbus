import type { CorpusTier } from "../types.ts";

export const GITHUB_TIER_COUNTS: Record<CorpusTier, number> = {
  small: 50,
  medium: 500,
  large: 5_000,
};

export const GITHUB_PER_PAGE = 100;

export interface GithubPull {
  number: number;
  title: string;
  state: "open" | "closed";
  user: { login: string };
  updated_at: string;
  html_url: string;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_103_515_245 + 12_345) >>> 0;
    return s / 0x100000000;
  };
}

const TITLES = [
  "fix: type narrowing",
  "feat: add diag",
  "docs: cleanup",
  "test: cover edge case",
  "refactor: extract helper",
];

export function githubPullsPages(tier: CorpusTier): GithubPull[][] {
  const total = GITHUB_TIER_COUNTS[tier];
  const all: GithubPull[] = [];
  for (let i = 0; i < total; i += 1) {
    const rand = lcg(0xc0ffee + i);
    const title = TITLES[Math.floor(rand() * TITLES.length)] ?? TITLES[0];
    const state: "open" | "closed" = rand() > 0.6 ? "closed" : "open";
    const updated = new Date(
      Date.UTC(2026, 0, 1) + Math.floor(rand() * 90 * 86_400_000),
    ).toISOString();
    all.push({
      number: i + 1,
      title: `${title} (#${i + 1})`,
      state,
      user: { login: `bot-${(i % 7).toString()}` },
      updated_at: updated,
      html_url: `https://github.com/example/repo/pull/${i + 1}`,
    });
  }
  const pages: GithubPull[][] = [];
  for (let off = 0; off < all.length; off += GITHUB_PER_PAGE) {
    pages.push(all.slice(off, off + GITHUB_PER_PAGE));
  }
  return pages;
}

export interface BuildGithubLinkOpts {
  page: number;
  totalPages: number;
  perPage: number;
  baseUrl?: string;
}

export function buildGithubLinkHeader(opts: BuildGithubLinkOpts): string {
  const url = opts.baseUrl ?? "https://api.github.com/repos/example/repo/pulls";
  const parts: string[] = [];
  const link = (page: number, rel: string): string =>
    `<${url}?page=${page}&per_page=${opts.perPage}>; rel="${rel}"`;
  if (opts.page > 1) {
    parts.push(link(opts.page - 1, "prev"), link(1, "first"));
  }
  if (opts.page < opts.totalPages) {
    parts.push(link(opts.page + 1, "next"), link(opts.totalPages, "last"));
  }
  return parts.join(", ");
}
