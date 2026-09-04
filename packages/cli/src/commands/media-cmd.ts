/**
 * `nimbus media understand` — the owner-invoked multimodal understanding pass.
 *
 * Argument parsing and summary rendering are pure and exported so they can be tested without a
 * gateway: the dispatcher-driven path uses DI rather than `mock.module`, which is process-global
 * and leaks across the combined CI test run.
 *
 * Deliberately does NOT require `--yes` before a non-dry run, unlike `nimbus index rebody`:
 * `rebody` triggers real outbound network traffic against connectors, so a confirmation is
 * warranted there. This pass makes NO network request at all — understanding runs entirely
 * through local models — so a confirmation gate here would be ceremony that trains users to type
 * `--yes` without reading it.
 */
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

export type SkipReasonKey =
  | "over_byte_cap"
  | "no_local_model"
  | "no_remote_grant"
  | "unresolvable_modality"
  | "fetch_miss"
  | "path_outside_roots"
  | "transcode_failed"
  | "transcribe_failed";

export interface CliSummary {
  readonly understood: number;
  readonly skipped: number;
  readonly skippedByReason: Readonly<Record<SkipReasonKey, number>>;
  readonly lastItemId: string | null;
}

export interface ParsedMediaArgs {
  readonly kind: "understand";
  readonly params: {
    service?: string;
    modality?: "image" | "av";
    sinceDays?: number;
    limit?: number;
  };
}

/**
 * `--modality`, which accepts both `MediaModality` values as of PR 2 (S2 multimodal I/O).
 *
 * `image` captions still images through the local VLM; `av` transcribes audio/video and captions
 * sampled frames. Omitting the flag discovers both in one pass.
 *
 * This refused `image` by name until PR 2, because before a vision model existed every image
 * candidate was skipped as `unresolvable_modality` and accepting the flag would have returned
 * "understood 0 of 0" — letting a user conclude they had no images when in fact nothing could
 * read one. That reason expired the moment the VLM arm landed; the gateway has accepted
 * `"image" | "av"` since then, so keeping the refusal here made the CLI unable to request the
 * feature this slice adds.
 */
function parseModality(value: string): "image" | "av" {
  if (value !== "image" && value !== "av") {
    throw new Error('nimbus media: --modality must be "image" or "av"');
  }
  return value;
}

/** `--limit`: a positive integer, so `0`, `-1` and `1.5` are all refused rather than clamped. */
function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("nimbus media: --limit must be a positive integer");
  }
  return n;
}

/** `--since`: a non-negative number of days. Fractional is fine; NaN and Infinity are not. */
function parseSinceDays(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("nimbus media: --since must be a non-negative number of days");
  }
  return n;
}

export function parseMediaArgs(argv: readonly string[]): ParsedMediaArgs {
  const sub = argv[0];
  if (sub !== "understand") {
    throw new Error(`nimbus media: unknown subcommand "${sub ?? ""}" (expected "understand")`);
  }
  const params: ParsedMediaArgs["params"] = {};
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`nimbus media: ${flag ?? ""} requires a value`);
    }
    switch (flag) {
      case "--service":
        params.service = value;
        break;
      case "--modality":
        params.modality = parseModality(value);
        break;
      case "--limit":
        params.limit = parseLimit(value);
        break;
      case "--since":
        params.sinceDays = parseSinceDays(value);
        break;
      default:
        throw new Error(`nimbus media: unknown flag "${flag ?? ""}"`);
    }
  }
  return { kind: "understand", params };
}

/**
 * Reports the total AND the per-reason breakdown. A bare "Understood 42" is precisely the
 * disclosure failure the pass exists not to commit (spec § 8) — the reader cannot tell whether the
 * other 66 were absent, too large, or silently refused. Reasons with a zero count are omitted as
 * noise; a non-zero reason always appears.
 */
export function renderSummary(summary: CliSummary): string {
  const total = summary.understood + summary.skipped;
  const lines = [`Understood ${summary.understood} of ${total}.`];
  const reasons = Object.entries(summary.skippedByReason).filter(([, n]) => n > 0);
  if (reasons.length > 0) {
    lines.push("Skipped:");
    for (const [reason, n] of reasons) {
      lines.push(`  ${reason}: ${n}`);
    }
  }
  return lines.join("\n");
}

function printMediaHelp(): void {
  console.log(`nimbus media — local multimodal understanding (Gateway IPC)

Usage:
  nimbus media understand [--service <name>]
                           [--modality image|av]
                           [--since <days>]
                           [--limit N]           (default 50)
                           [--json]

Runs the budgeted, resumable understanding pass over indexed local audio, video and still images:
transcribes recordings and captions images (plus a small number of sampled video frames) that have
not been understood yet, and writes the result back into the index so it becomes searchable and
available to agents. Omit --modality to discover both image and audio/video candidates in one pass.

Vision captioning needs a local Ollama vision model pulled by you (see the [multimodal] vlm_model
config key) — nothing here downloads one, and a machine without one still transcribes audio/video,
just without frame captions.

  * Local-models-only: this pass runs entirely on-device (spec § 3.4) — it makes no outbound
    network request, so it needs no --yes confirmation the way "nimbus index rebody" does.
  * Resumable: an interrupted or re-run pass picks up where the last one left off rather than
    restarting from the beginning, and a per-artifact failure never aborts the whole run.
`);
}

export async function runMediaCmd(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printMediaHelp();
    return;
  }
  const isJson = args.includes("--json");
  const parsed = parseMediaArgs(args.filter((a) => a !== "--json"));

  const summary = await withGatewayIpc((c) =>
    c.call<CliSummary>("media.understand", parsed.params),
  );

  process.stdout.write(isJson ? `${JSON.stringify(summary)}\n` : `${renderSummary(summary)}\n`);
}
