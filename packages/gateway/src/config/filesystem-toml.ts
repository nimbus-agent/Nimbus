import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  fallbackMessage,
  layeredConfigText,
  layerReadError,
  sectionFallbackSink,
} from "./layered-config.ts";
import { parseBool, parseString, stripComment } from "./toml-primitives.ts";

export type NimbusFilesystemRootToml = {
  path: string;
  gitAware: boolean;
  codeIndex: boolean;
  dependencyGraph: boolean;
  mediaIndex: boolean;
  exclude: string[];
};

function applyOptionalBool(valRaw: string, set: (b: boolean) => void): void {
  const b = parseBool(valRaw);
  if (b !== undefined) {
    set(b);
  }
}

function expandPath(p: string): string {
  const t = p.trim();
  if (t === "" || t === "~" || t.startsWith("~/")) {
    const rest = t === "~" || t === "~/" ? "" : t.slice(2);
    return resolve(join(homedir(), rest));
  }
  return resolve(t);
}

function defaultRoot(): NimbusFilesystemRootToml {
  return {
    path: "",
    gitAware: true,
    codeIndex: false,
    dependencyGraph: true,
    mediaIndex: false,
    exclude: ["node_modules", ".git", "dist", "target", "build", ".next"],
  };
}

function parseExcludeList(raw: string): string[] {
  return parseString(raw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function pushExpandedRoot(cur: NimbusFilesystemRootToml, roots: NimbusFilesystemRootToml[]): void {
  if (cur.path.trim() !== "") {
    roots.push({
      ...cur,
      path: expandPath(cur.path),
    });
  }
}

function applyFilesystemRootKey(cur: NimbusFilesystemRootToml, key: string, valRaw: string): void {
  switch (key) {
    case "path":
      cur.path = parseString(valRaw);
      break;
    case "git_aware": {
      applyOptionalBool(valRaw, (b) => {
        cur.gitAware = b;
      });
      break;
    }
    case "code_index": {
      applyOptionalBool(valRaw, (b) => {
        cur.codeIndex = b;
      });
      break;
    }
    case "media_index": {
      applyOptionalBool(valRaw, (b) => {
        cur.mediaIndex = b;
      });
      break;
    }
    case "dependency_graph": {
      applyOptionalBool(valRaw, (b) => {
        cur.dependencyGraph = b;
      });
      break;
    }
    case "exclude":
      cur.exclude = parseExcludeList(valRaw);
      break;
    default:
      break;
  }
}

export function parseNimbusTomlFilesystemRoots(source: string): NimbusFilesystemRootToml[] {
  const lines = source.split(/\r?\n/);
  const roots: NimbusFilesystemRootToml[] = [];
  let cur: NimbusFilesystemRootToml | undefined;

  for (const line of lines) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") {
      continue;
    }
    if (trimmed === "[[filesystem.roots]]") {
      if (cur !== undefined) {
        pushExpandedRoot(cur, roots);
      }
      cur = defaultRoot();
      continue;
    }
    if (cur === undefined) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const valRaw = trimmed.slice(eq + 1).trim();
    applyFilesystemRootKey(cur, key, valRaw);
  }
  if (cur !== undefined) {
    pushExpandedRoot(cur, roots);
  }
  return roots;
}

export function loadNimbusFilesystemRootsFromConfigDir(
  configDir: string,
): NimbusFilesystemRootToml[] {
  // Roots replace whole per layer, so an unreadable profile file would otherwise index the BASE
  // file's roots in its place. Index nothing until every layer is readable.
  const readError = layerReadError(configDir);
  if (readError !== undefined) {
    sectionFallbackSink(configDir, "filesystem.roots")(readError);
    return [];
  }
  const raw = layeredConfigText(configDir);
  if (raw === null) {
    return [];
  }
  try {
    return parseNimbusTomlFilesystemRoots(raw);
  } catch (err) {
    sectionFallbackSink(configDir, "filesystem.roots")(fallbackMessage(err));
    return [];
  }
}
