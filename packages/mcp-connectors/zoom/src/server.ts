import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { encodeZoomMeetingPathSegment } from "./encode-meeting-path.ts";
import { validateZoomRecordingsWindow } from "./recordings-window.ts";
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
            p.limit === undefined ? { query: p.query } : { query: p.query, limit: p.limit },
          )
        : [];
      return jsonResult({ matches });
    },
  );

  reg(
    "zoom_recordings_list",
    'List the authenticated user\'s cloud recordings in a date window (`GET /v2/users/me/recordings?from=&to=&page_size=100`). `from` and `to` are ISO-8601 date strings (YYYY-MM-DD or full ISO); **Zoom requires (to - from) <= 1 month** — this tool validates that locally and throws a clear error before consuming a Zoom API call. Returns the `{ meetings: [{ id, uuid, topic, recording_files: [{ id, file_type, recording_start, play_url, download_url, ... }] }], next_page_token, page_size, total_records, from, to }` envelope. **Transcript files (`file_type: "TRANSCRIPT"`) carry the speech-to-text content** — Nimbus indexes those as `zoom:transcript` items; for full transcript text query the local Nimbus index instead of refetching `download_url` from here.',
    z.object({
      from: z
        .string()
        .min(1)
        .describe("ISO-8601 start of window (e.g. '2026-05-01' or '2026-05-01T00:00:00Z')"),
      to: z.string().min(1).describe("ISO-8601 end of window; (to - from) must be <= 31 days"),
    }),
    async (p) => {
      validateZoomRecordingsWindow(p.from, p.to);
      const params = new URLSearchParams({ from: p.from, to: p.to, page_size: "100" });
      return jsonResult(await zoomGet(`/v2/users/me/recordings?${params.toString()}`));
    },
  );

  reg(
    "zoom_transcript_get",
    "Fetch the recording-file inventory for one meeting (`GET /v2/meetings/{meetingId}/recordings`). Use this to discover transcript file ids + metadata for a specific meeting; returns the `{ uuid, id, topic, recording_files: [...] }` shape. UUIDs are auto-double-encoded when they start with `/` or contain `//` (Zoom's documented requirement). **For the actual transcript TEXT, query the local Nimbus index** (`zoom:transcript` items, keyed by `<meeting_uuid>:<recording_file_id>`). This tool does NOT refetch + parse the VTT — that work is owned by the gateway-side syncable.",
    z.object({
      id: z.string().min(1).describe("Meeting numeric id (preferred) or meeting UUID"),
    }),
    async (p) => {
      return jsonResult(
        await zoomGet(`/v2/meetings/${encodeZoomMeetingPathSegment(p.id)}/recordings`),
      );
    },
  );
});
