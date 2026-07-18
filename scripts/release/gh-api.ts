const API = "https://api.github.com";
const COMMON = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
} as const;

export interface ReleaseAsset {
  readonly name: string;
  readonly size: number;
}
export interface Release {
  readonly tagName: string;
  readonly assets: readonly ReleaseAsset[];
}
export interface IssueRef {
  readonly number: number;
  readonly body: string;
  readonly createdAt: string;
}
export interface RepoPerms {
  readonly push: boolean;
}
export interface ProbeResult {
  readonly status: number;
  readonly scopes: string | null;
}

export interface GitHubApi {
  getReleaseByTag(tag: string): Promise<Release | null>;
  getRepoPermissions(ownerRepo: string, token?: string): Promise<RepoPerms | { status: number }>;
  probeToken(token: string): Promise<ProbeResult>;
  listOpenIssues(label: string): Promise<IssueRef[]>;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  updateIssue(num: number, body: string): Promise<void>;
  commentIssue(num: number, body: string): Promise<void>;
  closeIssue(num: number, comment: string): Promise<void>;
  ensureLabel(label: string): Promise<void>;
}

export function createGitHubApi(opts: {
  token: string;
  repo: string;
  fetchFn?: typeof fetch;
}): GitHubApi {
  const f = opts.fetchFn ?? fetch;
  const auth = (token = opts.token) => ({ ...COMMON, authorization: `Bearer ${token}` });
  const j = async (res: Response): Promise<unknown> => (await res.json()) as unknown;

  return {
    async getReleaseByTag(tag) {
      const res = await f(`${API}/repos/${opts.repo}/releases/tags/${tag}`, { headers: auth() });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`getReleaseByTag ${tag}: HTTP ${res.status}`);
      const data = (await j(res)) as { tag_name: string; assets: { name: string; size: number }[] };
      return {
        tagName: data.tag_name,
        assets: data.assets.map((a) => ({ name: a.name, size: a.size })),
      };
    },
    async getRepoPermissions(ownerRepo, token) {
      const res = await f(`${API}/repos/${ownerRepo}`, { headers: auth(token) }); // token undefined → default; else the PAT under test
      if (!res.ok) return { status: res.status };
      const data = (await j(res)) as { permissions?: { push?: boolean } };
      return { push: data.permissions?.push === true };
    },
    async probeToken(token) {
      const res = await f(`${API}/rate_limit`, { headers: auth(token) });
      return { status: res.status, scopes: res.headers.get("x-oauth-scopes") };
    },
    async listOpenIssues(label) {
      const res = await f(
        `${API}/repos/${opts.repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
        { headers: auth() },
      );
      if (!res.ok) throw new Error(`listOpenIssues: HTTP ${res.status}`);
      const data = (await j(res)) as { number: number; body: string | null; created_at: string }[];
      return data.map((i) => ({ number: i.number, body: i.body ?? "", createdAt: i.created_at }));
    },
    async createIssue(title, body, labels) {
      const res = await f(`${API}/repos/${opts.repo}/issues`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ title, body, labels }),
      });
      if (!res.ok) throw new Error(`createIssue: HTTP ${res.status}`);
      return ((await j(res)) as { number: number }).number;
    },
    async updateIssue(num, body) {
      const res = await f(`${API}/repos/${opts.repo}/issues/${num}`, {
        method: "PATCH",
        headers: auth(),
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`updateIssue: HTTP ${res.status}`);
    },
    async commentIssue(num, body) {
      const res = await f(`${API}/repos/${opts.repo}/issues/${num}/comments`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`commentIssue: HTTP ${res.status}`);
    },
    async closeIssue(num, comment) {
      await this.commentIssue(num, comment);
      const res = await f(`${API}/repos/${opts.repo}/issues/${num}`, {
        method: "PATCH",
        headers: auth(),
        body: JSON.stringify({ state: "closed" }),
      });
      if (!res.ok) throw new Error(`closeIssue: HTTP ${res.status}`);
    },
    async ensureLabel(label) {
      const res = await f(`${API}/repos/${opts.repo}/labels`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: label, color: "d93f0b" }),
      });
      if (!res.ok && res.status !== 422) throw new Error(`ensureLabel: HTTP ${res.status}`); // 422 = already exists
    },
  };
}
