import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

export const ALLOWED_OUTPUT_NAMES: ReadonlySet<string> = new Set([
  "external-id",
  "is-new",
  "dora-eligible",
]);

export function setOutput(name: string, value: string): void {
  if (!ALLOWED_OUTPUT_NAMES.has(name)) {
    throw new Error(`refusing to set unknown output: ${name}`);
  }
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile === undefined) return;
  let delim: string;
  do {
    delim = `EOF_${randomUUID().replaceAll("-", "")}`;
  } while (value.includes(delim));
  appendFileSync(outFile, `${name}<<${delim}\n${value}\n${delim}\n`);
}
