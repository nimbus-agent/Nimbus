// scripts/lib/run-gate-with-work-check.ts
import { delimiter, join } from "node:path";
import { assertDidWork } from "./assert-work.ts";

// Only `lint:markdown` is load-bearing here: markdownlint-cli2 exits 0 after linting nothing, so
// the count is the only evidence it did work. biome exits non-zero on 0 files, which the exit-code
// check below already catches before the assertion runs — its pattern is kept as a belt-and-braces
// guard against a future biome that reports zero and exits 0.
const PATTERNS: Record<string, RegExp[]> = {
  lint: [/Checked (\d+) files/],
  "lint:markdown": [/Linting: (\d+) files/],
};

const label = process.argv[2] ?? "";
const cmd = process.argv.slice(3);
if (label === "" || cmd.length === 0) {
  console.error("usage: run-gate-with-work-check <label> <cmd...>");
  process.exit(2);
}

// `bun run <script>` augments PATH with node_modules/.bin automatically; a direct
// `bun scripts/lib/run-gate-with-work-check.ts ...` invocation does not, so the binary
// (e.g. biome) would fail to resolve. Prepend it explicitly so both invocation styles agree.
const binDir = join(process.cwd(), "node_modules", ".bin");
const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env["PATH"] ?? ""}` };

const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env });
const out = `${p.stdout.toString()}${p.stderr.toString()}`;
process.stdout.write(out);

if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);

try {
  assertDidWork(out, PATTERNS[label] ?? [], label);
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}
