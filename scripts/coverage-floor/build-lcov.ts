import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const IS_WIN = process.platform === "win32";
const PROGRAM_FILES = process.env["ProgramFiles"] ?? "C:\\Program Files";

function resolveBin(candidates: readonly string[]): string {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0] ?? "bash";
}

const BASH_BIN = IS_WIN
  ? resolveBin([
      win32.join(PROGRAM_FILES, "Git", "bin", "bash.exe"),
      win32.join(PROGRAM_FILES, "Git", "usr", "bin", "bash.exe"),
      "bash",
    ])
  : "bash";

const scriptPath = join(REPO_ROOT, "scripts", "coverage-floor", "build-lcov.sh");

const res = spawnSync(BASH_BIN, [scriptPath], {
  stdio: "inherit",
  env: {
    ...process.env,
    // Prepend standard Bun path and Git paths to PATH for Windows Git Bash compatibility
    PATH: IS_WIN
      ? [
          win32.join(process.env["USERPROFILE"] ?? "", ".bun", "bin"),
          win32.join(PROGRAM_FILES, "Git", "bin"),
          win32.join(PROGRAM_FILES, "Git", "usr", "bin"),
          process.env["PATH"] ?? "",
        ].join(delimiter)
      : process.env["PATH"],
  },
});

process.exit(res.status ?? 1);
