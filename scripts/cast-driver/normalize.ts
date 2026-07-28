export interface NormalizationContext {
  readonly tmpDirPrefix: string;
  readonly homePrefix: string;
}

export interface Rule {
  readonly name: string;
  readonly apply: (text: string, ctx: NormalizationContext) => string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI parsing requires the literal ESC (\x1b) byte
const ANSI_CSI = /\x1b\[[?]?[0-9;]*[A-Za-z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI OSC parsing requires the literal ESC (\x1b) and BEL (\x07) bytes
const ANSI_OSC = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g; // NOSONAR S6324: ANSI OSC parsing requires literal ESC/BEL control bytes
const ISO_8601 = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;
const EPOCH_MS = /\b\d{13}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const LABELLED_ID = /\b(session_id|streamId|stream_id|sessionId|pid|PID)\s*[=:]?\s*([\w-]+)\b/g;
const VERSION = /\b(nimbus|Bun|Node)\s+v\d+\.\d+\.\d+(?:[-+.][\w.-]+)?\b/g;
const GIT_SHA = /(?:sha=|commit=|SHA=|COMMIT=)([0-9a-f]{7,40})\b|\b[0-9a-f]{20,40}\b/g;

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

export const NORMALIZATION_RULES: ReadonlyArray<Rule> = [
  {
    name: "ansi-strip",
    apply: (t) => t.replace(ANSI_CSI, "").replace(ANSI_OSC, ""),
  },
  {
    name: "crlf-to-lf",
    apply: (t) => t.replaceAll("\r\n", "\n"),
  },
  {
    name: "cr-resolution",
    apply: (t) => {
      let text = t.replaceAll("\r\n", "\n");
      if (text.endsWith("\r")) {
        text = `${text.slice(0, -1)}\n`;
      }
      const lines = text.split("\n");
      const resolved = lines.map((line) => {
        const lastCr = line.lastIndexOf("\r");
        return lastCr === -1 ? line : line.slice(lastCr + 1);
      });
      return resolved.join("\n");
    },
  },
  {
    name: "trailing-whitespace",
    apply: (t) =>
      t
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/, ""))
        .join("\n"),
  },
  {
    name: "tmp-prefix",
    apply: (t, ctx) => {
      if (ctx.tmpDirPrefix.length === 0) return t;
      return t.replace(new RegExp(escapeForRegex(ctx.tmpDirPrefix), "g"), "<TMP>");
    },
  },
  {
    name: "home-prefix",
    apply: (t, ctx) => {
      if (ctx.homePrefix.length === 0) return t;
      return t.replace(new RegExp(escapeForRegex(ctx.homePrefix), "g"), "<HOME>");
    },
  },
  {
    // MUST run after tmp-prefix/home-prefix: it rewrites only what those rules
    // already anchored. A command that prints a path under the harness tmpdir
    // (`nimbus init` prints its repo root) emits `<TMP>\repo` when recorded on
    // Windows and `<TMP>/repo` on Linux — a pure separator difference that
    // would otherwise drift the snapshot between a laptop recording and the
    // ubuntu tripwire. Scoped to the placeholder run so ordinary backslashes
    // elsewhere in a transcript are untouched.
    name: "placeholder-path-separators",
    apply: (t) =>
      t.replace(
        /(<TMP>|<HOME>)(\S*)/g,
        (_m, tag: string, rest: string) => `${tag}${rest.replaceAll("\\", "/")}`,
      ),
  },
  {
    name: "iso-8601",
    apply: (t) => t.replace(ISO_8601, "<TS>"),
  },
  {
    name: "epoch-ms",
    apply: (t) => t.replace(EPOCH_MS, "<TS>"),
  },
  {
    name: "uuid",
    apply: (t) => t.replace(UUID, "<ID>"),
  },
  {
    name: "ulid",
    apply: (t) => t.replace(ULID, "<ID>"),
  },
  {
    name: "labelled-id",
    apply: (t) =>
      t.replace(LABELLED_ID, (match, label: string) => {
        const sep = match.includes("=") ? "=" : " ";
        return `${label}${sep}<ID>`;
      }),
  },
  {
    name: "version",
    apply: (t) => t.replace(VERSION, (_m, name: string) => `${name} <VERSION>`),
  },
  {
    name: "git-sha",
    apply: (t) =>
      t.replace(GIT_SHA, (match) => {
        const labelMatch = /^(sha=|commit=|SHA=|COMMIT=)/i.exec(match);
        if (labelMatch) {
          return `${labelMatch[1]}<SHA>`;
        }
        return "<SHA>";
      }),
  },
];

export function applyNormalization(bytes: Uint8Array, ctx: NormalizationContext): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let result = text;
  for (const rule of NORMALIZATION_RULES) {
    result = rule.apply(result, ctx);
  }
  return result;
}
