import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { encodeZoomMeetingPathSegment } from "./encode-meeting-path.ts";
import { filterZoomMeetings } from "./search-filter.ts";

const BASE = "https://api.zoom.us";

function apiToken(): string {
  const t = process.env["ZOOM_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("ZOOM_TOKEN is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${apiToken()}`, Accept: "application/json" };
}

async function zoomGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Zoom ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-zoom", (reg) => {
  reg(
    "zoom_list",
    "List the authenticated user's scheduled Zoom meetings (`GET /v2/users/me/meetings?type=scheduled&page_size=100`). Returns the `{ meetings: [...], next_page_token, page_size, total_records }` envelope — `meetings` holds the meeting objects.",
    z.object({}),
    async () => {
      return jsonResult(await zoomGet("/v2/users/me/meetings?type=scheduled&page_size=100"));
    },
  );

  reg(
    "zoom_get",
    "Fetch one Zoom meeting by its numeric meeting id OR its UUID (`GET /v2/meetings/{meetingId}`). Returns the meeting object directly (NOT wrapped in `{ meetings }`). Throws when no match is found. UUIDs are auto-double-encoded when they start with `/` or contain `//` (Zoom's documented requirement).",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await zoomGet(`/v2/meetings/${encodeZoomMeetingPathSegment(p.id)}`));
    },
  );

  reg(
    "zoom_search",
    "**Substring search over the FIRST PAGE only** (up to 100 most recently-listed scheduled meetings) of the authenticated user's Zoom meetings. The Zoom REST API has no native text-search endpoint for meetings; this tool fetches `GET /v2/users/me/meetings?type=scheduled&page_size=100` once and matches the query locally against the meeting topic, agenda, and host id (case-insensitive). **Meetings older than the first page are not searchable here — query the local Nimbus index instead for full coverage.** Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const root = await zoomGet("/v2/users/me/meetings?type=scheduled&page_size=100");
      const meetings = (root as { meetings?: unknown[] } | null)?.meetings;
      const matches = Array.isArray(meetings)
        ? filterZoomMeetings(
            meetings,
            p.limit !== undefined ? { query: p.query, limit: p.limit } : { query: p.query },
          )
        : [];
      return jsonResult({ matches });
    },
  );
});
