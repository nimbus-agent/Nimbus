import { flagValue, runAgentBriefCli } from "./_agent-brief-cli.ts";

export type GlossaryCliArgs = {
  term?: string;
  limit?: number;
  json: boolean;
};

/**
 * Local structural stand-in for the gateway's `GlossaryBrief`
 * (`agents/_lib/glossary-types.ts`). The CLI cannot import gateway source
 * (IPC-only rule) and `@nimbus-dev/sdk` has no glossary types yet — a future
 * SDK promotion replaces this, exactly as it did for `why`.
 */
export type GlossaryBriefLike = {
  kind: "glossary";
  mode: string;
  entries: unknown[];
  gaps: unknown[];
};

export function isGlossaryBriefLike(v: unknown): v is GlossaryBriefLike {
  if (v === null || typeof v !== "object") return false;
  const b = v as { kind?: unknown; mode?: unknown; entries?: unknown; gaps?: unknown };
  return (
    b.kind === "glossary" &&
    typeof b.mode === "string" &&
    Array.isArray(b.entries) &&
    Array.isArray(b.gaps)
  );
}

const USAGE = "Usage: nimbus glossary [<term>] [--limit <n>] [--json]";

/**
 * `--refresh` and `--rebuild` are recognised only to fail loudly.
 *
 * They were designed alongside the command but never wired: the gateway's
 * `agents.glossary` handler reads `term` and `limit` and nothing else, so
 * forwarding them produced an ordinary query while the user believed a pass —
 * or, for `--rebuild`, a destructive re-derivation — had run. Silently doing
 * something other than what was asked is worse than refusing, especially for a
 * flag documented as truncating tables. Extraction is driven by the debounced
 * post-sync trigger meanwhile.
 */
const UNWIRED_FLAGS: ReadonlyMap<string, string> = new Map([
  [
    "--refresh",
    "--refresh is not implemented yet. The glossary refreshes automatically after each connector sync.",
  ],
  [
    "--rebuild",
    "--rebuild is not implemented yet. Nothing was rebuilt; re-run without the flag to query the glossary.",
  ],
]);

function parseLimit(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error("--limit must be a positive integer");
  return n;
}

export function parseGlossaryArgs(args: string[]): GlossaryCliArgs {
  const positional: string[] = [];
  let limit: number | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // Looked up rather than `.has()`-then-`.get()`: the second form needs a
    // `?? ""` fallback the guard makes unreachable, which reads as dead code
    // and shows up as a permanently uncovered branch.
    const unwired = a === undefined ? undefined : UNWIRED_FLAGS.get(a);
    if (a === "--limit") {
      limit = parseLimit(flagValue(args, i, "--limit"));
      i += 1;
    } else if (unwired !== undefined) {
      throw new Error(`${unwired}\n${USAGE}`);
    } else if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      throw new Error(USAGE);
    } else if (typeof a === "string" && a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}\n${USAGE}`);
    } else if (typeof a === "string") {
      positional.push(a);
    }
  }

  const term = positional.join(" ").trim();
  return {
    ...(term === "" ? {} : { term }),
    ...(limit === undefined ? {} : { limit }),
    json,
  };
}

export async function runGlossaryCommand(args: string[]): Promise<void> {
  const parsed = parseGlossaryArgs(args);
  await runAgentBriefCli<GlossaryBriefLike>({
    kind: "glossary",
    guard: isGlossaryBriefLike,
    json: parsed.json,
    params: {
      ...(parsed.term === undefined ? {} : { term: parsed.term }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    },
  });
}
