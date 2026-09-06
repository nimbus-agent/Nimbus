import { readFileSync } from "node:fs";

export interface GhSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GhSpawnFn = (
  args: readonly string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined> },
) => Promise<GhSpawnResult>;

export interface GhCliOptions {
  spawn?: GhSpawnFn;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  backoffMs?: number;
}

const DEFAULT_BACKOFF_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;

const NO_ARTIFACT_PATTERNS = [
  /no artifact found/i,
  /artifact .* not found/i,
  /not found.*artifact/i,
];

/**
 * Parse `gh --json` stdout as an array of objects, validating shape at the boundary. External
 * data is treated as `unknown` (never asserted): non-array JSON or malformed entries are dropped
 * rather than throwing mid-pipeline. `pick` runs only on entries `isValid` has already vetted.
 */
function parseJsonObjectArray<T>(
  out: string,
  isValid: (rec: Record<string, unknown>) => boolean,
  pick: (rec: Record<string, unknown>) => T,
): T[] {
  const parsed: unknown = JSON.parse(out);
  if (!Array.isArray(parsed)) return [];
  const result: T[] = [];
  for (const x of parsed) {
    if (typeof x === "object" && x !== null) {
      const rec = x as Record<string, unknown>;
      if (isValid(rec)) result.push(pick(rec));
    }
  }
  return result;
}

function defaultSpawn(): GhSpawnFn {
  return async (args, opts) => {
    const proc = Bun.spawn(["gh", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      ...(opts?.cwd !== undefined && { cwd: opts.cwd }),
      ...(opts?.env !== undefined && {
        env: { ...process.env, ...opts.env } as Record<string, string>,
      }),
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stdout, stderr };
  };
}

export class GhCli {
  readonly #spawn: GhSpawnFn;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxAttempts: number;
  readonly #backoffMs: number;

  constructor(opts: GhCliOptions = {}) {
    this.#spawn = opts.spawn ?? defaultSpawn();
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  async #run(args: readonly string[]): Promise<GhSpawnResult> {
    let lastErr = "";
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const r = await this.#spawn(args);
      if (r.exitCode === 0) return r;
      lastErr = r.stderr || `gh exited ${r.exitCode}`;
      if (NO_ARTIFACT_PATTERNS.some((re) => re.test(lastErr))) {
        throw new Error(
          `gh ${args[0] ?? "?"} ${args[1] ?? "?"} failed after 1 attempt: ${lastErr}`,
        );
      }
      if (attempt < this.#maxAttempts) {
        await this.#sleep(this.#backoffMs);
      }
    }
    throw new Error(
      `gh ${args[0] ?? "?"} ${args[1] ?? "?"} failed after ${this.#maxAttempts} attempts: ${lastErr}`,
    );
  }

  async runListRecentSuccesses(args: {
    workflow: string;
    branch: string;
    limit: number;
  }): Promise<{ databaseId: number; headSha: string }[]> {
    const r = await this.#run([
      "run",
      "list",
      "--workflow",
      args.workflow,
      "--branch",
      args.branch,
      "--status",
      "success",
      "--limit",
      String(args.limit),
      "--json",
      "databaseId,headSha",
    ]);
    const out = r.stdout.trim();
    if (out === "") return [];
    return parseJsonObjectArray(
      out,
      (rec) => typeof rec["databaseId"] === "number" && typeof rec["headSha"] === "string",
      (rec) => ({ databaseId: rec["databaseId"] as number, headSha: rec["headSha"] as string }),
    );
  }

  async runDownloadArtifact(args: { runId: number; name: string; dir: string }): Promise<boolean> {
    try {
      await this.#run([
        "run",
        "download",
        String(args.runId),
        "--name",
        args.name,
        "--dir",
        args.dir,
      ]);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (NO_ARTIFACT_PATTERNS.some((re) => re.test(msg))) return false;
      throw err;
    }
  }

  async prCommentList(args: { pr: number }): Promise<{ id: string; body: string }[]> {
    const r = await this.#run([
      "pr",
      "view",
      String(args.pr),
      "--json",
      "comments",
      "--jq",
      ".comments",
    ]);
    const out = r.stdout.trim();
    if (out === "") return [];
    return parseJsonObjectArray(
      out,
      (rec) => typeof rec["id"] === "string" && typeof rec["body"] === "string",
      (rec) => ({ id: rec["id"] as string, body: rec["body"] as string }),
    );
  }

  async prCommentCreate(args: { pr: number; bodyFile: string }): Promise<void> {
    await this.#run(["pr", "comment", String(args.pr), "--body-file", args.bodyFile]);
  }

  async prCommentEdit(args: { commentId: string; bodyFile: string; repo: string }): Promise<void> {
    const body = readFileSync(args.bodyFile, "utf8");
    await this.#run([
      "api",
      "--method",
      "PATCH",
      `/repos/${args.repo}/issues/comments/${args.commentId}`,
      "-f",
      `body=${body}`,
    ]);
  }

  async issueList(args: { label: string }): Promise<{ number: number; title: string }[]> {
    const r = await this.#run([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      args.label,
      "--json",
      "number,title",
    ]);
    const out = r.stdout.trim();
    if (out === "") return [];
    return parseJsonObjectArray(
      out,
      (rec) => typeof rec["number"] === "number" && typeof rec["title"] === "string",
      (rec) => ({ number: rec["number"] as number, title: rec["title"] as string }),
    );
  }

  async issueCreate(args: { title: string; label: string; bodyFile: string }): Promise<void> {
    await this.#run([
      "issue",
      "create",
      "--title",
      args.title,
      "--label",
      args.label,
      "--body-file",
      args.bodyFile,
    ]);
  }
}
