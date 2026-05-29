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

type MutableOpenapiConfig = {
  maxWalkDepth: number;
  maxSpecBytes: number;
  ignoreGlobs: readonly string[];
};

function applyOpenapiKeyValue(cfg: MutableOpenapiConfig, key: string, val: string): void {
  if (key === "max_walk_depth") {
    const n = parseInt32(val);
    if (n !== undefined && n >= 1 && n <= 64) {
      cfg.maxWalkDepth = n;
    }
  } else if (key === "max_spec_bytes") {
    const n = parseInt32(val);
    if (n !== undefined && n >= 1024 && n <= 1024 * 1024 * 1024) {
      cfg.maxSpecBytes = n;
    }
  } else if (key === "ignore_globs") {
    cfg.ignoreGlobs = parseGlobList(val);
  }
}

export function parseOpenapiToml(source: string): OpenapiConfig {
  const lines = source.split(/\r?\n/);
  let inBlock = false;
  const cfg: MutableOpenapiConfig = {
    maxWalkDepth: DEFAULT_OPENAPI_CONFIG.maxWalkDepth,
    maxSpecBytes: DEFAULT_OPENAPI_CONFIG.maxSpecBytes,
    ignoreGlobs: DEFAULT_OPENAPI_CONFIG.ignoreGlobs,
  };

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
    applyOpenapiKeyValue(cfg, line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return {
    maxWalkDepth: cfg.maxWalkDepth,
    maxSpecBytes: cfg.maxSpecBytes,
    ignoreGlobs: cfg.ignoreGlobs,
  };
}
