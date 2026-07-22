/** A validated citation. `quote`, when present, is a span taken from the cited body. */
export type SourceRef = {
  kind: "source" | "clip";
  title: string;
  url?: string;
  /** The `nimbus:clip:<sha256>` item id. Present only for kind: "clip". */
  clipId?: string;
  /** <= MAX_QUOTE_CHARS, verbatim from the cited body (see quote-verify.ts). */
  quote?: string;
};

export type ReportItem = {
  text: string;
  citations: SourceRef[];
};

export type Report = {
  summary: string;
  findings: ReportItem[];
  /** Every entry carries >= 2 distinct citations; enforced by the validator. */
  conflicts: ReportItem[];
  gaps: string[];
  /**
   * Typed disclosure so a client can render a banner, not bullet six.
   * `disclosure` is the EXACT string also appended to `gaps` (present iff
   * remote), so a live view can suppress the duplicate by equality rather
   * than by pattern-matching prose the gateway might later reword.
   */
  synthesis: { model: string; remote: boolean; disclosure?: string };
};

/** A fed source. `body` is EPHEMERAL — it is never written to disk. */
export type BriefSource = {
  readonly canonicalUrl: string;
  readonly url: string;
  readonly title: string;
  /** NFC-normalized at ingest so quote offsets are stable. */
  readonly body: string;
  readonly capturedAt: number;
  readonly truncated: boolean;
  /** Sum of Buffer.byteLength(x, "utf8") over body, title, and url — the full held cost. */
  readonly bytes: number;
};

export type BriefRunStatus = "collecting" | "running" | "done" | "failed";

export type BriefRun = {
  readonly id: string;
  readonly brief: string;
  readonly useIndex: boolean;
  /** canonicalUrl -> what the client declared at create. Fixed; never grows. */
  readonly declared: ReadonlyMap<string, { url: string; title: string }>;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  status: BriefRunStatus;
  /** canonicalUrl -> fed source. Cleared the moment the run reaches a terminal state. */
  sources: Map<string, BriefSource>;
  bytesHeld: number;
  report: Report | null;
  error: string | null;
};

/** One addressable source the model may cite, keyed by an opaque token (S1.., C1..). */
export type SourceRegistryEntry = {
  readonly token: string;
  readonly ref: SourceRef;
  /** NFC-normalized text the quote verifier checks against. */
  readonly body: string;
};

export type SourceRegistry = ReadonlyMap<string, SourceRegistryEntry>;
