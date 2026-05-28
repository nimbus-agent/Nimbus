export type OpenapiConfig = {
  maxWalkDepth: number;
  maxSpecBytes: number;
  ignoreGlobs: readonly string[];
};

export const DEFAULT_OPENAPI_CONFIG: OpenapiConfig = {
  maxWalkDepth: 8,
  maxSpecBytes: 5 * 1024 * 1024, // 5 MiB
  ignoreGlobs: [],
};

function stripComment(line: string): string {
  const i = line.indexOf("#");
  return i < 0 ? line : line.slice(0, i);
}

function parseStringScalar(raw: string): string | undefined {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1);
  }
  return undefined;
}

function parseInt32(raw: string): number | undefined {
  const t = raw.trim();
  if (!/^-?\d+$/.test(t)) {
    return undefined;
  }
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseGlobList(raw: string): readonly string[] {
  const s = parseStringScalar(raw);
  if (s === undefined) {
    return [];
  }
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

export function parseOpenapiToml(source: string): OpenapiConfig {
  const lines = source.split(/\r?\n/);
  let inBlock = false;
  let maxWalkDepth = DEFAULT_OPENAPI_CONFIG.maxWalkDepth;
  let maxSpecBytes = DEFAULT_OPENAPI_CONFIG.maxSpecBytes;
  let ignoreGlobs: readonly string[] = DEFAULT_OPENAPI_CONFIG.ignoreGlobs;

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("[")) {
      inBlock = line === "[openapi]";
      continue;
    }
    if (!inBlock) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key === "max_walk_depth") {
      const n = parseInt32(val);
      if (n !== undefined && n >= 1 && n <= 64) {
        maxWalkDepth = n;
      }
    } else if (key === "max_spec_bytes") {
      const n = parseInt32(val);
      if (n !== undefined && n >= 1024 && n <= 1024 * 1024 * 1024) {
        maxSpecBytes = n;
      }
    } else if (key === "ignore_globs") {
      ignoreGlobs = parseGlobList(val);
    }
  }
  return { maxWalkDepth, maxSpecBytes, ignoreGlobs };
}
