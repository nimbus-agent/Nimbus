import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const IS_WIN = process.platform === "win32";

function resolveBin(candidates: readonly string[]): string {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0] ?? "bash";
}

const BASH_BIN = IS_WIN
  ? resolveBin([
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
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
      ? `${process.env.USERPROFILE || ""}\\.bun\\bin;C:\\Program Files\\Git\\bin;C:\\Program Files\\Git\\usr\\bin;${process.env.PATH}`
      : process.env.PATH,
  },
});

process.exit(res.status ?? 1);
