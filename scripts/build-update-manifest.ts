import { readFileSync, writeFileSync } from "node:fs";

interface Target {
  name: "darwin-x86_64" | "darwin-aarch64" | "linux-x86_64" | "windows-x86_64";
  file: string;
  url: string;
}

const args = process.argv.slice(2);
const versionIdx = args.indexOf("--version");
const outIdx = args.indexOf("--output");
const notesIdx = args.indexOf("--notes");
const baseIdx = args.indexOf("--base-url");
if (versionIdx < 0 || outIdx < 0 || baseIdx < 0) {
  console.error(
    "usage: bun scripts/build-update-manifest.ts --version <v> --output <path> --base-url <url> [--notes <s>]",
  );
  process.exit(1);
}
const version = args[versionIdx + 1] ?? "";
const outputPath = args[outIdx + 1] ?? "";
const baseUrl = args[baseIdx + 1] ?? "";
const notes = notesIdx >= 0 ? args[notesIdx + 1] : undefined;

const targets: Target[] = [
  {
    name: "darwin-x86_64",
    file: "nimbus-gateway-macos-x64",
    url: `${baseUrl}/nimbus-gateway-macos-x64`,
  },
  {
    name: "darwin-aarch64",
    file: "nimbus-gateway-macos-arm64",
    url: `${baseUrl}/nimbus-gateway-macos-arm64`,
  },
  {
    name: "linux-x86_64",
    file: "nimbus-gateway-linux-x64",
    url: `${baseUrl}/nimbus-gateway-linux-x64`,
  },
  {
    name: "windows-x86_64",
    file: "nimbus-gateway-windows-x64.exe",
    url: `${baseUrl}/nimbus-gateway-windows-x64.exe`,
  },
];

const platforms: Record<string, { url: string; sha256: string; signature: string }> = {};
for (const t of targets) {
  const sha = readFileSync(`${t.file}.sha256`, "utf8").trim();
  const sig = readFileSync(`${t.file}.sig`, "utf8").trim();
  platforms[t.name] = { url: t.url, sha256: sha, signature: sig };
}

const manifest: Record<string, unknown> = {
  version,
  pub_date: new Date().toISOString(),
  platforms,
};
if (notes !== undefined) {
  manifest["notes"] = notes;
}

writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
console.log(`wrote: ${outputPath}`);
