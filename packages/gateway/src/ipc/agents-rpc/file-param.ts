import type { Database } from "bun:sqlite";
import { resolveFileByRemote } from "../../index/resolve-file-by-remote.ts";
import { AgentsRpcError } from "./_shared.ts";
import { MAX_FILE_LEN, MIN_FILE_LEN } from "./limits.ts";

const MAX_NAMESPACE_LEN = 256;

export function parseNamespaces(p: { namespace?: unknown; namespaces?: unknown }): string[] {
  // `namespaces` (array) takes precedence over the singular `namespace` alias when both are given.
  const raw = p.namespaces ?? p.namespace;
  if (raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX_NAMESPACE_LEN) {
      throw new AgentsRpcError(
        -32602,
        `namespace must be a non-empty string up to ${MAX_NAMESPACE_LEN} chars`,
      );
    }
    out.push(v.trim());
  }
  return out;
}

type FileParam = { file: string; namespaces: string[] };

/**
 * A file subject, from either shape a caller can name one in.
 *
 * `{ file }` is a LOCAL path and stays exactly as it was — the terminal surface knows the
 * reader's filesystem. `{ service, repo, refAndPath }` is a FORGE coordinate, which is all
 * a browser has, and is resolved against the reader's checkout by
 * `resolveFileByRemote` before any agent sees it. The five agents therefore keep taking a
 * local path and are unchanged.
 */
export function requireFileParam(db: Database, params: unknown): FileParam {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "requires { file: string } or { service, repo, refAndPath }");
  }
  const p = params as {
    file?: unknown;
    service?: unknown;
    repo?: unknown;
    refAndPath?: unknown;
    namespace?: unknown;
    namespaces?: unknown;
  };

  const namespaces = parseNamespaces(p);

  if (p.refAndPath !== undefined || p.repo !== undefined || p.service !== undefined) {
    // The forge shape is LOCAL-ONLY, and refuses rather than ignores.
    //
    // `ghost` and `conflicts` fan out to federation peers whenever `namespaces` is
    // non-empty. This shape exists for the browser — a client reachable over HTTP under
    // the `agents` scope — so admitting namespaces would let any holder of that token
    // turn a question about one file into peer network calls. Reading them from the
    // original params and passing them through, as this did, was exactly that hole.
    //
    // REFUSED, not silently emptied: a caller who asked for fan-out and received a local
    // answer would believe they had searched the federation. The local `{ file }` shape
    // is unaffected and still fans out when asked.
    if (namespaces.length > 0) {
      throw new AgentsRpcError(
        -32602,
        "namespaces are not accepted with a forge coordinate — that shape answers locally only",
      );
    }
    if (p.file !== undefined) {
      throw new AgentsRpcError(
        -32602,
        "{ file } and { service, repo, refAndPath } are mutually exclusive — pass one",
      );
    }
    const service = requireForgeField(p.service, "service");
    const repo = requireForgeField(p.repo, "repo");
    const refAndPath = requireForgeField(p.refAndPath, "refAndPath");
    const resolved = resolveFileByRemote(db, { service, repo, refAndPath });
    if (!resolved.ok) {
      // The typed reason reaches the caller in the message, because the client renders a
      // different sentence for each: "no local checkout of this repo" is permanent and
      // unactionable from the page, "that path is not indexed" is neither.
      throw new AgentsRpcError(-32602, `${resolved.reason}: \`${repo}\` — no file to answer about`);
    }
    return { file: resolved.path, namespaces };
  }

  if (typeof p.file !== "string") {
    throw new AgentsRpcError(-32602, "requires { file: string } or { service, repo, refAndPath }");
  }
  const trimmed = p.file.trim();
  if (trimmed.length < MIN_FILE_LEN || trimmed.length > MAX_FILE_LEN) {
    throw new AgentsRpcError(-32602, `file must be ${MIN_FILE_LEN}..${MAX_FILE_LEN} chars`);
  }
  return { file: trimmed, namespaces };
}

/** One forge-coordinate field: a non-empty string within the same bounds a path gets. */
export function requireForgeField(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new AgentsRpcError(-32602, `${name} must be a string`);
  }
  // Measured AFTER trim, on the normalised value — never on the caller's raw string.
  const trimmed = value.trim();
  if (trimmed.length < MIN_FILE_LEN || trimmed.length > MAX_FILE_LEN) {
    throw new AgentsRpcError(-32602, `${name} must be ${MIN_FILE_LEN}..${MAX_FILE_LEN} chars`);
  }
  return trimmed;
}
