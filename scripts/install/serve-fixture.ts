#!/usr/bin/env bun
// Serves a directory of release fixtures for the install-smoke CI job's
// served-release (remote-mode) install steps. Deliberately the ONLY server
// implementation for this purpose: one Bun.serve, reused verbatim on Linux,
// macOS AND Windows (via Git Bash's `shell: bash`), rather than a
// Python-on-Unix / "mirror this on Windows" split that depends on Python
// being present and identical across three runner images. Bun is already
// provisioned on every runner by .github/actions/setup-nimbus-ci.
//
// Usage: bun scripts/install/serve-fixture.ts <dir> <port>
import { join } from "node:path";

const dir = process.argv[2];
const port = Number(process.argv[3] ?? 8788);
if (!dir) throw new Error("usage: serve-fixture.ts <dir> <port>");
if (!Number.isFinite(port) || port <= 0) throw new Error(`invalid port: ${process.argv[3]}`);

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const name = new URL(req.url).pathname.split("/").pop() ?? "";
    // Reject empty/traversal-shaped names outright rather than let path.join
    // resolve ".." upward — this only ever needs to serve flat filenames
    // (the release asset + SHA256SUMS[.asc]) from one directory.
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      return new Response("not found", { status: 404 });
    }
    const file = Bun.file(join(dir, name));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
console.log(`serving ${dir} on 127.0.0.1:${port}`);
