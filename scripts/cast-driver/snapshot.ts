import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function unifiedDiff(
  baseline: string | null,
  actual: string,
  baselineLabel: string,
  actualLabel: string,
): string {
  if (baseline === null) {
    return `--- ${baselineLabel}\n+++ ${actualLabel}\n@@ first-run: no baseline exists yet @@\n${actual
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n")}\n`;
  }
  if (baseline === actual) return "";
  const baselineLines = baseline.split("\n");
  const actualLines = actual.split("\n");
  const max = Math.max(baselineLines.length, actualLines.length);
  const body: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const b = baselineLines[i];
    const a = actualLines[i];
    if (b === a) {
      if (b !== undefined) body.push(` ${b}`);
    } else {
      if (b !== undefined) body.push(`-${b}`);
      if (a !== undefined) body.push(`+${a}`);
    }
  }
  return `--- ${baselineLabel}\n+++ ${actualLabel}\n@@ -1,${baselineLines.length} +1,${actualLines.length} @@\n${body.join("\n")}\n`;
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, path);
}
