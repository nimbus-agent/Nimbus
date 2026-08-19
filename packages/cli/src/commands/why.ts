import { runAgentCli } from "../lib/agent-cli-dispatcher.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

export type WhyCliArgs = {
  ref: string;
  line?: number;
  peek: boolean;
  json: boolean;
};

type WhyBriefLike = { kind: "why"; findings: unknown[]; gaps: Array<{ category: string }> };
/** Structural stand-in until sdk 1.6.0 ships isWhyBrief (why-lens step 2). */
function isWhyBriefLike(v: unknown): v is WhyBriefLike {
  if (v === null || typeof v !== "object") return false;
  const b = v as { kind?: unknown; findings?: unknown; gaps?: unknown };
  return b.kind === "why" && Array.isArray(b.findings) && Array.isArray(b.gaps);
}

/**
 * Local structural stand-in for the gateway's `WhyPeek` type
 * (`agents/_lib/why-types.ts`) — the CLI cannot import gateway source
 * (IPC-only rule) and `@nimbus-dev/sdk` 1.5.x has no Why types yet.
 * Step 2 (sdk 1.6.0) replaces this with the published SDK type.
 */
export type WhyPeekLike = {
  subject: { repoRoot: string; filePath: string; lineNo: number } | null;
  author: string | null;
  authorEmail: string | null;
  commitSha: string | null;
  committedAt: number | null;
  commitSubject: string | null;
  pr: { number: number | null; title: string; url: string | null } | null;
  ticket: { key: string; title: string; url: string | null } | null;
  hasMore: boolean;
};

const USAGE = "Usage: nimbus why <path[:line] | symbol | pr-url> [--line <n>] [--peek] [--json]";

/**
 * Two call sites need this: choosing the params arm, and refusing `--peek` on a
 * URL. The `catch` returns rather than being empty — `resolve-by-url.ts:133` is
 * the repo's idiom, and an empty block is a lint risk for no gain.
 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function whyParamsFor(ref: string, line: number | undefined): Record<string, unknown> {
  if (isHttpUrl(ref)) {
    return { prUrl: ref };
  }
  return line === undefined ? { ref } : { ref, line };
}

function parseLineFlag(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("--line must be a positive integer");
  }
  return n;
}

export function parseWhyArgs(args: string[]): WhyCliArgs {
  const positional: string[] = [];
  let line: number | undefined;
  let peek = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--line") {
      line = parseLineFlag(args[i + 1]);
      i += 1;
    } else if (a === "--peek") {
      peek = true;
    } else if (a === "--json") {
      json = true;
    } else if (a !== undefined && !a.startsWith("--")) {
      positional.push(a);
    }
  }
  const ref = positional[0];
  if (ref === undefined || ref.trim().length === 0) {
    throw new Error(USAGE);
  }
  const out: WhyCliArgs = { ref, peek, json };
  if (line !== undefined) out.line = line;
  return out;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function renderPeekLine(ref: string, peek: WhyPeekLike): string {
  if (peek.subject === null || peek.commitSha === null) {
    return `No indexed answer for ${ref} (line not blamed, or path outside the indexed roots).`;
  }
  const parts: string[] = [];
  if (peek.author !== null) parts.push(peek.author);
  parts.push(shortSha(peek.commitSha));
  if (peek.committedAt !== null) {
    parts.push(new Date(peek.committedAt).toISOString().slice(0, 10));
  }
  if (peek.commitSubject !== null) parts.push(peek.commitSubject);
  if (peek.pr !== null && peek.pr.number !== null) parts.push(`PR #${String(peek.pr.number)}`);
  if (peek.ticket !== null) parts.push(peek.ticket.key);
  return parts.join(" · ");
}

export async function runWhyCli(args: string[]): Promise<void> {
  const parsed = parseWhyArgs(args);
  if (parsed.peek) {
    if (isHttpUrl(parsed.ref)) {
      throw new Error("--peek takes a path or symbol, not a pull request URL");
    }
    const peek = await withGatewayIpc((c) =>
      c.call<WhyPeekLike>("agents.whyPeek", {
        ref: parsed.ref,
        ...(parsed.line === undefined ? {} : { line: parsed.line }),
      }),
    );
    process.stdout.write(
      `${parsed.json ? JSON.stringify(peek, null, 2) : renderPeekLine(parsed.ref, peek)}\n`,
    );
    return;
  }
  await runAgentCli({
    agentName: "why",
    ipcMethod: "agents.why",
    callParams: whyParamsFor(parsed.ref, parsed.line),
    guard: isWhyBriefLike,
    json: parsed.json,
  });
}
