import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stripAffixChars } from "../util/strip-affixes.ts";

export type ServiceNameInput = {
  specPath: string;
  infoTitle: string;
  rootPath: string;
};

const SLUG_DROP = /[^a-z0-9]+/g;

function slugify(s: string): string {
  const collapsed = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(SLUG_DROP, "-");
  return stripAffixChars(collapsed, "-");
}

function readOverride(specPath: string): string | undefined {
  const sib = join(dirname(specPath), "nimbus.openapi.toml");
  if (!existsSync(sib)) {
    return undefined;
  }
  try {
    const raw = readFileSync(sib, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.replace(/#.*$/, "").trim();
      const m = /^service\s*=\s*"([^"]*)"\s*$/.exec(t);
      if (m !== null) {
        const v = m[1]?.trim();
        if (v !== undefined && v !== "") {
          return v;
        }
      }
    }
  } catch {
    // ignore — best-effort
  }
  return undefined;
}

function enclosingDirOrUndef(specPath: string, rootPath: string): string | undefined {
  const dir = dirname(specPath);
  if (dir === rootPath) {
    return undefined;
  }
  return basename(dir);
}

function sha8(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 8);
}

export function inferServiceName(input: ServiceNameInput): string {
  const override = readOverride(input.specPath);
  if (override !== undefined && override !== "") {
    return override;
  }
  const enc = enclosingDirOrUndef(input.specPath, input.rootPath);
  if (enc !== undefined && enc !== "") {
    const s = slugify(enc);
    if (s !== "") {
      return s;
    }
  }
  const title = slugify(input.infoTitle);
  if (title !== "") {
    return title;
  }
  return `service-${sha8(input.specPath)}`;
}
