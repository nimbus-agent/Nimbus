import { HttpResponse, http } from "msw";

import type { CorpusTier } from "../types.ts";
import { DRIVE_PAGE_SIZE, type DrivePage, driveTracePages } from "./synthetic-drive-trace.ts";
import {
  buildGithubLinkHeader,
  GITHUB_PER_PAGE,
  githubPullsPages,
} from "./synthetic-github-trace.ts";
import { GMAIL_PAGE_SIZE, gmailListPages, gmailMessage } from "./synthetic-gmail-trace.ts";

export function driveHandlers(tier: CorpusTier): ReturnType<typeof http.get>[] {
  const pages: DrivePage[] = driveTracePages(tier);
  return [
    http.get("https://www.googleapis.com/drive/v3/files", ({ request }) => {
      const url = new URL(request.url);
      const token = url.searchParams.get("pageToken");
      let pageIdx = 0;
      if (token !== null) {
        const m = token.match(/^tok-drive-[a-z]+-(\d+)$/);
        if (m !== null) {
          pageIdx = Math.floor(Number.parseInt(m[1] ?? "0", 10) / DRIVE_PAGE_SIZE);
        }
      }
      const page = pages[pageIdx];
      if (page === undefined) return HttpResponse.json({ files: [] });
      return HttpResponse.json(page);
    }),
  ];
}

export function gmailHandlers(tier: CorpusTier): ReturnType<typeof http.get>[] {
  const pages = gmailListPages(tier);
  return [
    http.get("https://gmail.googleapis.com/gmail/v1/users/:user/messages", ({ request }) => {
      const url = new URL(request.url);
      const token = url.searchParams.get("pageToken");
      let pageIdx = 0;
      if (token !== null) {
        const m = token.match(/^tok-gmail-[a-z]+-(\d+)$/);
        if (m !== null) {
          pageIdx = Math.floor(Number.parseInt(m[1] ?? "0", 10) / GMAIL_PAGE_SIZE);
        }
      }
      const page = pages[pageIdx];
      if (page === undefined) {
        return HttpResponse.json({ messages: [], resultSizeEstimate: 0 });
      }
      return HttpResponse.json(page);
    }),
    http.get("https://gmail.googleapis.com/gmail/v1/users/:user/messages/:id", ({ params }) => {
      const id = params["id"];
      if (typeof id !== "string") {
        return new HttpResponse(null, { status: 404 });
      }
      const m = gmailMessage(id, tier);
      if (m === undefined) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json(m);
    }),
  ];
}

export function githubHandlers(tier: CorpusTier): ReturnType<typeof http.get>[] {
  const pages = githubPullsPages(tier);
  return [
    http.get("https://api.github.com/repos/:owner/:repo/pulls", ({ request }) => {
      const url = new URL(request.url);
      const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
      const perPage = Number.parseInt(url.searchParams.get("per_page") ?? `${GITHUB_PER_PAGE}`, 10);
      const slice = pages[page - 1] ?? [];
      const link = buildGithubLinkHeader({
        page,
        totalPages: pages.length,
        perPage,
      });
      const headers = link.length > 0 ? { Link: link } : {};
      return HttpResponse.json(slice, { headers });
    }),
  ];
}
