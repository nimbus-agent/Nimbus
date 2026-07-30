import { flagValue, runAgentBriefCli } from "./_agent-brief-cli.ts";

export type GlossaryCliArgs = {
  term?: string;
  limit?: number;
  refresh: boolean;
  rebuild: boolean;
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

const USAGE = "Usage: nimbus glossary [<term>] [--limit <n>] [--refresh | --rebuild] [--json]";

function parseLimit(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error("--limit must be a positive integer");
  return n;
}

export function parseGlossaryArgs(args: string[]): GlossaryCliArgs {
  const positional: string[] = [];
  let limit: number | undefined;
  let refresh = false;
  let rebuild = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--limit") {
      limit = parseLimit(flagValue(args, i, "--limit"));
      i += 1;
    } else if (a === "--refresh") {
      refresh = true;
    } else if (a === "--rebuild") {
      rebuild = true;
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

  if (refresh && rebuild) {
    throw new Error("--refresh and --rebuild are mutually exclusive");
  }

  const term = positional.join(" ").trim();
  return {
    ...(term === "" ? {} : { term }),
    ...(limit === undefined ? {} : { limit }),
    refresh,
    rebuild,
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
      ...(parsed.refresh ? { refresh: true } : {}),
      ...(parsed.rebuild ? { rebuild: true } : {}),
    },
  });
}
