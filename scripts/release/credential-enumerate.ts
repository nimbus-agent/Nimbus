import type { LiveSecret } from "./credential-audit";
import type { SecretProduct } from "./credential-registry";

const API = "https://api.github.com";
const ORG = "nimbus-agent";

interface SecretListResponse {
  readonly secrets?: readonly {
    readonly name?: unknown;
    readonly updated_at?: unknown;
    readonly visibility?: unknown;
  }[];
}

/** Narrow the API payload without trusting it. Anything malformed is skipped, not coerced. */
function parseSecrets(
  body: unknown,
  scope: "org" | "repo",
  product: SecretProduct,
  repo?: string,
): LiveSecret[] {
  const list = (body as SecretListResponse)?.secrets;
  if (!Array.isArray(list)) return [];
  const out: LiveSecret[] = [];
  for (const s of list) {
    if (typeof s?.name !== "string" || typeof s?.updated_at !== "string") continue;
    const visibility =
      s.visibility === "all" || s.visibility === "selected" ? s.visibility : undefined;
    out.push({
      name: s.name,
      scope,
      ...(repo ? { repo } : {}),
      product,
      updatedAt: s.updated_at,
      ...(visibility ? { visibility } : {}),
    });
  }
  return out;
}

interface RepoListResponse {
  readonly repositories?: readonly { readonly name?: unknown }[];
}

/**
 * Scan every repository the auditor App is installed on.
 *
 * There is deliberately no `repos` parameter. Deriving the list from the
 * manifest would mean only looking where the manifest already points, so a
 * secret in an undocumented repo — the exact thing `undocumented` exists to
 * catch — would be invisible by construction.
 */
export async function enumerateSecrets(deps: {
  token: string;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ secrets: LiveSecret[]; errors: string[] }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const secrets: LiveSecret[] = [];
  const errors: string[] = [];

  // The token travels in the Authorization header, never in the URL — a URL can
  // land in a log line, a redirect, or an error message.
  const get = async (path: string): Promise<{ status: number; body: unknown }> => {
    const res = await fetchFn(`${API}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${deps.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };

  const org = await get(`/orgs/${ORG}/actions/secrets`);
  if (org.status === 200) secrets.push(...parseSecrets(org.body, "org", "actions"));
  else errors.push(`org actions secrets: HTTP ${org.status}`);

  // Discover the scan surface rather than being told it. A failure here must be
  // loud: an empty repo list would make the whole inventory look clean.
  const installed = await get("/installation/repositories");
  const repos: string[] = [];
  if (installed.status === 200) {
    for (const r of (installed.body as RepoListResponse)?.repositories ?? []) {
      if (typeof r?.name === "string") repos.push(r.name);
    }
  } else {
    errors.push(`installation repositories: HTTP ${installed.status}`);
  }

  for (const repo of repos) {
    for (const product of ["actions", "dependabot"] as const) {
      const r = await get(`/repos/${ORG}/${repo}/${product}/secrets`);
      if (r.status === 200) {
        secrets.push(...parseSecrets(r.body, "repo", product, repo));
        continue;
      }
      // 404 means the App is not installed on that repo, which is a
      // configuration fact, not a failure. 403 means the permission is missing —
      // that MUST surface, because silently reporting zero secrets for a repo
      // would make `undocumented` claim a completeness it does not have.
      if (r.status !== 404) errors.push(`${repo} ${product} secrets: HTTP ${r.status}`);
    }
  }

  return { secrets, errors };
}
