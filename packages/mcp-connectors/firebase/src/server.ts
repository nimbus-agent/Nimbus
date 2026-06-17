import { mintGoogleAccessToken } from "@nimbus-dev/sdk";
import { z } from "zod";
import { matchesResult } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterFirebaseReleases } from "./search-filter.ts";
import { configuredAppIds, projectNumberFromAppId, serviceAccountFromEnv } from "./token.ts";

const APP_DISTRIBUTION_API = "https://firebaseappdistribution.googleapis.com";

// App Distribution OAuth2 tokens last ~1h; cache and refresh conservatively.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken !== null && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }
  const token = await mintGoogleAccessToken(serviceAccountFromEnv());
  if (token === null) {
    throw new Error("failed to mint a Firebase access token");
  }
  cachedToken = { token, expiresAt: now + 30 * 60 * 1000 };
  return token;
}

async function appDistGet(path: string): Promise<unknown> {
  const res = await fetch(`${APP_DISTRIBUTION_API}${path}`, {
    headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Firebase App Distribution ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function appBasePath(appId: string): string {
  const projectNumber = projectNumberFromAppId(appId);
  if (projectNumber === null) {
    throw new Error(`cannot derive a project number from app id: ${appId}`);
  }
  return `/v1/projects/${encodeURIComponent(projectNumber)}/apps/${encodeURIComponent(appId)}`;
}

function releasesPath(appId: string, pageSize: number): string {
  return `${appBasePath(appId)}/releases?pageSize=${String(pageSize)}`;
}

function releasePath(appId: string, releaseId: string): string {
  return `${appBasePath(appId)}/releases/${encodeURIComponent(releaseId)}`;
}

await runReadOnlyMcpConnector("nimbus-firebase", (reg) => {
  reg(
    "firebase_list",
    "List Firebase App Distribution resources. When `appId` is omitted, returns the connector's configured app ids. When `appId` is provided, returns that app's most-recent releases via GET /v1/projects/<n>/apps/<appId>/releases (pageSize optional, default 50).",
    z.object({
      appId: z.string().min(1).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      if (p.appId === undefined) {
        return jsonResult({ appIds: configuredAppIds() });
      }
      return jsonResult(await appDistGet(releasesPath(p.appId, p.pageSize ?? 50)));
    },
  );

  reg(
    "firebase_get",
    "Fetch a single Firebase App Distribution release via GET /v1/projects/<n>/apps/<appId>/releases/<releaseId>.",
    z.object({
      appId: z.string().min(1),
      releaseId: z.string().min(1),
    }),
    async (p) => jsonResult(await appDistGet(releasePath(p.appId, p.releaseId))),
  );

  reg(
    "firebase_search",
    "Substring search across an app's recent releases. Matches the query against each release's display version, build version, release notes, and resource name (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      appId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const root = await appDistGet(releasesPath(p.appId, 100));
      const releases = (root as { releases?: unknown[] } | null)?.releases;
      return matchesResult(releases, filterFirebaseReleases, p);
    },
  );
});
