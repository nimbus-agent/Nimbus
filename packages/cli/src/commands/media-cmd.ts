/**
 * `nimbus media understand` — the owner-invoked multimodal understanding pass.
 *
 * Argument parsing and summary rendering are pure and exported so they can be tested without a
 * gateway: the dispatcher-driven path uses DI rather than `mock.module`, which is process-global
 * and leaks across the combined CI test run.
 *
 * Deliberately requires no `--yes` confirmation, unlike `nimbus index rebody` (there is no dry-run
 * mode here either — every invocation is a real run). `rebody` re-fetches indexed depth across the
 * WHOLE index with no built-in cap, so a confirmation is warranted there. This pass is different
 * in kind, not just degree — every candidate is priced
 * and the run refuses up front (spec § 16.9) once the cost would exceed `--budget`, so the
 * confirmation `--yes` exists to provide (bound the blast radius before it happens) is already
 * structural here. Understanding itself still runs entirely through local models; only the
 * *fetch* of a cloud-backed artifact's bytes (Drive/Photos/OneDrive, PR 3) leaves the machine, and
 * that leg is budgeted, capped, and I29-ledgered rather than unbounded — so a `--yes` gate here
 * would be ceremony that trains users to type it without reading it, not a real guardrail.
 */
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

// Hand-mirrored from the gateway's `SkipReason` (packages/cli may not import gateway source).
// A missing member here does not fail typecheck at the boundary — the summary arrives as JSON —
// it prints nothing and once crashed the renderer outright. Both trees change together.
export type SkipReasonKey =
  | "over_byte_cap"
  | "no_local_model"
  | "no_remote_grant"
  | "unresolvable_modality"
  | "fetch_miss"
  | "path_outside_roots"
  | "transcode_failed"
  | "transcribe_failed"
  | "describe_failed"
  | "unsupported_image_format"
  | "not_configured"
  | "rate_limited";

/**
 * Mirrors the gateway's `MediaPassStopReason` (`multimodal/media-pass.ts`) — the CLI reaches the
 * gateway over IPC only, so this is a hand-maintained copy, not an import.
 */
export type MediaStopReason = "completed" | "budget_exhausted" | "rate_limited";

/**
 * Mirrors the gateway's `MediaPassSummary`. `stopReason` and `cloudBytesFetched` are REQUIRED,
 * not optional-with-a-default: the gateway refuses a run whose priced cost exceeds the byte
 * budget and leaves the resume cursor untouched, expecting the operator to raise `--budget` or
 * pass `--renditions`. A `stopReason` that silently defaulted to "completed" would make that
 * refusal indistinguishable on screen from a run that legitimately found nothing to do — the pass
 * would appear to succeed while doing nothing, every run, forever.
 */
export interface CliSummary {
  readonly understood: number;
  readonly skipped: number;
  readonly skippedByReason: Readonly<Record<SkipReasonKey, number>>;
  readonly lastItemId: string | null;
  readonly stopReason: MediaStopReason;
  readonly cloudBytesFetched: number;
  /**
   * Mirrors the gateway's `PreflightRefusal` (`multimodal/media-pass.ts`). Non-null ONLY for a
   * pre-flight refusal — the case where the gateway priced the page, refused it before fetching a
   * byte, and left the cursor untouched, so the identical refusal repeats every run until a human
   * raises the budget or asks for renditions. These are the numbers that say which knob to move,
   * and `renderSummary` MUST print them: generic guidance over an all-zero summary was what the
   * user saw before, on the one screen where the evidence matters most.
   */
  readonly preflightRefusal: CliPreflightRefusal | null;
}

/** Mirrors the gateway's `PreflightRefusal`. Hand-maintained: the CLI reaches it over IPC only. */
export interface CliPreflightRefusal {
  readonly candidateCount: number;
  readonly cloudCount: number;
  readonly knownBytes: number;
  readonly knownCount: number;
  readonly unknownCount: number;
  readonly budgetBytes: number;
}

/**
 * Bytes as a short DECIMAL string (`3.9 GB`, `512 MB`), matching spec § 16.9's printed shape and
 * `--budget`'s decimal units — `parseBudget` treats `GB` as 10^9, so echoing a binary-rounded
 * number back at an operator who typed `4GB` would not agree with what they asked for.
 * Exact for a byte count under 1 kB, since rounding `873` to `0.9 kB` loses more than it saves.
 */
export function formatBytes(bytes: number): string {
  const units: readonly (readonly [number, string])[] = [
    [1_000 ** 3, "GB"],
    [1_000 ** 2, "MB"],
    [1_000, "kB"],
  ];
  for (const [scale, label] of units) {
    if (bytes >= scale) {
      const value = bytes / scale;
      // One decimal below 10 (3.9 GB), none above it (412 MB) — the extra digit stops mattering.
      return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${label}`;
    }
  }
  return `${bytes} B`;
}

export interface ParsedMediaArgs {
  readonly kind: "understand";
  readonly params: {
    service?: string;
    modality?: "image" | "av";
    sinceDays?: number;
    limit?: number;
    budgetBytes?: number;
    renditions?: boolean;
    originals?: boolean;
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

/**
 * Decimal vs. binary unit multipliers for {@link parseBudget}. `GB`/`MB`/`KB` are 10^3n; `GiB`/
 * `MiB`/`KiB` are 2^10n. Collapsing the two would silently grant ~7% more than an operator typing
 * "4GB" asked for — and this number is echoed straight back to them in the summary, so a budget
 * that does not mean what it says is worse than no budget at all.
 */
const BYTE_UNIT_MULTIPLIERS: Readonly<Record<string, number>> = {
  kb: 1_000,
  mb: 1_000 ** 2,
  gb: 1_000 ** 3,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

/**
 * `--budget`: a raw byte count, or a number with a case-insensitive unit suffix
 * (KB/MB/GB decimal, KiB/MiB/GiB binary — see {@link BYTE_UNIT_MULTIPLIERS}). Negative and
 * non-finite values return `null` rather than throwing, so the caller decides the error message
 * (mirrors `parseModality`/`parseLimit`'s throw-at-the-call-site shape, except this one is also
 * unit-tested directly per the plan).
 */
export function parseBudget(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(kib|mib|gib|kb|mb|gb)?$/i.exec(value.trim());
  if (match === null) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unitToken = match[2];
  if (unitToken === undefined) return Math.round(n);
  const multiplier = BYTE_UNIT_MULTIPLIERS[unitToken.toLowerCase()];
  if (multiplier === undefined) return null;
  return Math.round(n * multiplier);
}

/**
 * `--renditions`/`--originals` carry no value. Returns whether `flag` was one of them (and, if
 * so, has already applied it) — the caller advances by 1 rather than 2 in that case.
 */
function applyNoValueFlag(params: ParsedMediaArgs["params"], flag: string | undefined): boolean {
  if (flag === "--renditions") {
    params.renditions = true;
    return true;
  }
  if (flag === "--originals") {
    params.originals = true;
    return true;
  }
  return false;
}

/** Every flag that DOES take a value. `flag` may be `undefined` only for the final argv slot. */
function applyValueFlag(
  params: ParsedMediaArgs["params"],
  flag: string | undefined,
  value: string,
): void {
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
    case "--budget": {
      const budget = parseBudget(value);
      if (budget === null) {
        throw new Error(
          `nimbus media: --budget must be a byte count or a number with a unit (KB/MB/GB decimal, KiB/MiB/GiB binary), e.g. "500MB"`,
        );
      }
      params.budgetBytes = budget;
      break;
    }
    default:
      throw new Error(`nimbus media: unknown flag "${flag ?? ""}"`);
  }
}

export function parseMediaArgs(argv: readonly string[]): ParsedMediaArgs {
  const sub = argv[0];
  if (sub !== "understand") {
    throw new Error(`nimbus media: unknown subcommand "${sub ?? ""}" (expected "understand")`);
  }
  const params: ParsedMediaArgs["params"] = {};
  // A `while` loop, not the old `for (…; i += 2)`: `--renditions` and `--originals` carry no
  // value, so a fixed pair-stride would swallow the next flag as this one's value (or throw
  // "requires a value" when one of them is last). Only flag/value pairs advance by two.
  let i = 1;
  while (i < argv.length) {
    const flag = argv[i];
    if (applyNoValueFlag(params, flag)) {
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`nimbus media: ${flag ?? ""} requires a value`);
    }
    applyValueFlag(params, flag, value);
    i += 2;
  }
  // Rejected outright, never resolved by precedence: a silent override on a pair that controls
  // bandwidth is something a user discovers from their data cap, not from the CLI.
  if (params.renditions === true && params.originals === true) {
    throw new Error("nimbus media: --renditions and --originals are mutually exclusive");
  }
  return { kind: "understand", params };
}

/**
 * Human-readable labels for a `SkipReasonKey`, appended after the raw `reason: count` line so the
 * key a machine (or `--json`) reads and the sentence a person reads never disagree. Only the two
 * PR-4 additions carry a label today — the older reasons are left as their raw key alone, which is
 * pre-existing behavior this task does not change.
 */
const REASON_LABELS: Readonly<Partial<Record<SkipReasonKey, string>>> = {
  describe_failed: "the vision model failed to describe it",
  unsupported_image_format:
    "not a JPEG, PNG, WebP or GIF — refused rather than sent as an unknown type",
};

/**
 * The exact text for a non-"completed" `stopReason` — what happened, and what to do about it.
 * `budget_exhausted` is the important case: the gateway priced the run up front and refused it
 * because the cost exceeded `--budget`, leaving the resume cursor untouched on purpose (spec
 * § 16.9/17.3). Without this line, that refusal is indistinguishable on screen from a run that
 * legitimately understood everything there was to understand.
 */
function stopReasonGuidance(
  reason: Exclude<MediaStopReason, "completed">,
): readonly [string, string] {
  switch (reason) {
    case "budget_exhausted":
      return [
        "Run stopped: byte budget reached before every candidate could be priced or fetched.",
        'Resumable — raise --budget, or fetch smaller downsized copies with --renditions, then re-run "nimbus media understand".',
      ];
    case "rate_limited":
      return [
        "Run stopped: a connected service is rate-limiting cloud byte fetches.",
        'Resumable — wait for the rate limit to clear, then re-run "nimbus media understand".',
      ];
  }
}

/**
 * The pre-flight refusal's own screen, replacing the ordinary summary entirely.
 *
 * It replaces rather than decorates because every line of the ordinary summary would be a false
 * note here: "Understood 0 of 0" says there was nothing to do when in fact a whole page was found
 * and refused, and `stopReasonGuidance`'s "byte budget reached before every candidate could be
 * priced or fetched" describes a MID-RUN stop — a run that fetched, advanced its cursor and
 * resumes on its own. This outcome fetched nothing, attempted nothing and moved no cursor, so the
 * identical refusal repeats on every subsequent run until a human raises the budget or asks for
 * renditions. That makes this the one screen where the priced numbers must appear: they are the
 * evidence for the decision the refusal is demanding, and they were computed and discarded until
 * `preflightRefusal` carried them out (spec § 16.9).
 */
function renderPreflightRefusal(refusal: CliPreflightRefusal): string {
  const localCount = refusal.candidateCount - refusal.cloudCount;
  return [
    `Refused before fetching anything: ${refusal.candidateCount} candidate${refusal.candidateCount === 1 ? "" : "s"} found, none attempted.`,
    `${refusal.candidateCount} artifacts · ${refusal.knownCount} with known size ~ ${formatBytes(refusal.knownBytes)} · ${refusal.unknownCount} unknown (google_photos indexes no byte size)`,
    `Refusing: known bytes exceed the fetch budget (${formatBytes(refusal.budgetBytes)}). Nothing was fetched and the resume cursor is untouched, so every re-run is refused identically until you raise the budget or choose renditions.`,
    // Named only when there ARE local candidates, so the sentence never reads as a contradiction on
    // an all-cloud page. Stated because the old wording omitted it and the omission misleads: the
    // refusal returns before the candidate loop starts, so a local file needing no network at all
    // is blocked alongside the cloud ones rather than quietly understood.
    ...(localCount > 0
      ? [
          `${localCount} of those ${refusal.candidateCount} are LOCAL and need no network at all — they are blocked too, because no candidate in the page is attempted.`,
        ]
      : []),
    "",
    "  --budget <size>   raise the ceiling for one run (e.g. --budget 4GB)",
    "  --renditions      fetch downscaled/audio-only copies where available",
    "  --originals       fetch as-is, this run only",
  ].join("\n");
}

/**
 * Reports the total AND the per-reason breakdown. A bare "Understood 42" is precisely the
 * disclosure failure the pass exists not to commit (spec § 8) — the reader cannot tell whether the
 * other 66 were absent, too large, or silently refused. Reasons with a zero count are omitted as
 * noise; a non-zero reason always appears.
 *
 * A `stopReason` other than "completed" gets its own clearly separated block (never folded into
 * the skip breakdown, which is per-artifact — a budget/rate-limit stop ends the RUN, not one
 * artifact) naming what happened and the exact next step. See `stopReasonGuidance`.
 *
 * A PRE-FLIGHT refusal (`preflightRefusal !== null`) takes that block over entirely and prints the
 * numbers the gateway actually computed: artifacts found, how many were priceable and to what
 * total, how many were not, and the budget the total exceeded, plus the flags that change the
 * outcome. It is the one outcome that repeats forever until a human acts (nothing fetched, cursor
 * untouched), so printing generic guidance over an all-zero summary there withheld exactly the
 * evidence the decision needs (spec § 16.9).
 */
export function renderSummary(summary: CliSummary): string {
  const refusal = summary.preflightRefusal;
  // Loose equality is deliberate: `CliSummary` is hand-mirrored across the IPC boundary (no
  // gateway source import), and a gateway daemon that predates `preflightRefusal` sends a summary
  // with the field ABSENT rather than `null`, so `refusal` arrives as `undefined` here even though
  // the type says it can't. `!== null` let `undefined` through to `renderPreflightRefusal`, which
  // crashed on `undefined.candidateCount`. Do not "fix" this back to `!== null`.
  if (refusal != null) return renderPreflightRefusal(refusal);
  const total = summary.understood + summary.skipped;
  const lines = [`Understood ${summary.understood} of ${total}.`];
  const reasons = Object.entries(summary.skippedByReason).filter(([, n]) => n > 0);
  if (reasons.length > 0) {
    lines.push("Skipped:");
    for (const [reason, n] of reasons) {
      const label = REASON_LABELS[reason as SkipReasonKey];
      lines.push(label === undefined ? `  ${reason}: ${n}` : `  ${reason}: ${n} — ${label}`);
    }
  }
  lines.push(`Cloud bytes fetched: ${summary.cloudBytesFetched}`);
  if (summary.stopReason !== "completed") {
    const [stopped, resume] = stopReasonGuidance(summary.stopReason);
    lines.push("", stopped, resume);
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
                           [--budget <bytes>]     (e.g. 500MB, 4GiB — cloud fetches only)
                           [--renditions]         (prefer smaller downsized copies over originals)
                           [--originals]          (always fetch the original, never a rendition)
                           [--json]

Runs the budgeted, resumable understanding pass over indexed local AND cloud-backed (Google Drive,
Google Photos, OneDrive) audio, video and still images: transcribes recordings and captions images
(plus a small number of sampled video frames) that have not been understood yet, and writes the
result back into the index so it becomes searchable and available to agents. Omit --modality to
discover both image and audio/video candidates in one pass.

Vision captioning needs a local Ollama vision model pulled by you (see the [multimodal] vlm_model
config key) — nothing here downloads one, and a machine without one still transcribes audio/video,
just without frame captions.

A cloud-backed candidate's bytes are priced before any fetch happens; if fetching everything found
this run would exceed --budget, the run refuses up front rather than fetching part of it and
stopping mid-way. --renditions and --originals are mutually exclusive.

  * Local models, budgeted cloud fetch: understanding itself is always local (spec § 3.4); only a
    cloud-backed candidate's bytes leave the machine, capped by --budget and I29-ledgered — which
    is why this command still needs no --yes confirmation the way "nimbus index rebody" does.
  * Resumable: an interrupted or re-run pass picks up where the last one left off rather than
    restarting from the beginning, and a per-artifact failure never aborts the whole run. A run
    REFUSED up front by the byte budget leaves its resume cursor untouched entirely (nothing was
    fetched or attempted, so the next run sees exactly the same page). A run stopped MID-WAY by the
    budget or by a rate limit instead leaves the cursor on the last COMPLETED artifact, so the one
    it stopped on is retried next run rather than skipped, and nothing already understood is
    re-fetched.
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
