// packages/gateway/src/multimodal/media-bytes.ts
/**
 * Resolves a candidate to a path that may actually be read (spec § 5.1).
 *
 * Contacts no model — that separation is what makes `media-gate.ts`'s chokepoint claim checkable.
 *
 * The path stored on an item is NOT trusted. Roots can narrow after indexing, so containment is
 * re-checked against the LIVE roots at read time. `isAbsolute` is not sufficient:
 * `/a/b/../../etc` passes it, and the terminal lane shipped that bug — the consent prompt showed
 * the unresolved string while the sandbox bound the resolved one. Resolve first, compare after.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { MediaCandidate, SkipReason } from "./media-types.ts";

export type ResolvedMediaPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: SkipReason };

/**
 * True when `child` is `parent` itself or lies beneath it.
 *
 * The trailing separator matters: a plain `startsWith` would accept `/tmp/rootA-evil` for the root
 * `/tmp/rootA`, since one string does prefix the other.
 */
function isContainedBy(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(withSep);
}

export function resolveLocalMediaPath(
  candidate: MediaCandidate,
  roots: readonly string[],
  maxBytes: number,
): ResolvedMediaPath {
  const raw = candidate.sourcePath;
  if (raw === null || raw === undefined || raw === "") {
    return { ok: false, reason: "fetch_miss" };
  }

  const resolved = resolve(raw);

  // Containment is checked on the RESOLVED path first, so a traversal that escapes is rejected
  // before the filesystem is touched at all.
  const rootsResolved = roots.map((r) => resolve(r));
  if (!rootsResolved.some((r) => isContainedBy(resolved, r))) {
    return { ok: false, reason: "path_outside_roots" };
  }

  if (!existsSync(resolved)) {
    return { ok: false, reason: "fetch_miss" };
  }

  // Re-check containment after following symlinks: a link INSIDE a root pointing OUTSIDE it would
  // otherwise pass the check above and then read an out-of-root file.
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    return { ok: false, reason: "fetch_miss" };
  }
  const realRoots = rootsResolved.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  if (!realRoots.some((r) => isContainedBy(real, r))) {
    return { ok: false, reason: "path_outside_roots" };
  }

  // The byte cap is enforced against the INDEXED size when the index recorded one — that is the
  // number the pass's summary counts against, and it must refuse before touching the file at all
  // for an artifact the index already knows is oversized. Fall back to the on-disk size only when
  // the index never recorded one.
  let size: number;
  if (candidate.sourceBytes !== null && candidate.sourceBytes !== undefined) {
    size = candidate.sourceBytes;
  } else {
    try {
      size = statSync(real).size;
    } catch {
      return { ok: false, reason: "fetch_miss" };
    }
  }
  if (size > maxBytes) {
    return { ok: false, reason: "over_byte_cap" };
  }

  return { ok: true, path: real };
}
