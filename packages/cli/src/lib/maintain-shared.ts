/**
 * Helpers `nimbus registry maintain` and `nimbus trust maintain` share: offline builders of a
 * signed static folder (a registry index, the Nimbus trust feed) whose root key is a file holding
 * base64 of a 32-byte Ed25519 seed.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  isValidSemver,
  parseRegistryRequest,
  REQUEST_NAME_RE,
  type RegistryRequest,
} from "@nimbus-dev/registry-format";
import type { ActionPin } from "../commands/registry-templates/workflows.ts";
import { NIMBUS_RELEASE_COMMIT } from "../release-commit.ts";
import { NIMBUS_VERSION } from "../version.ts";
import { decodeBase64, encodeBase64 } from "./extension-signing.ts";

export interface MaintainIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export const DEFAULT_IO: MaintainIo = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

/** What this binary knows about its own build: the release commit (undefined in a dev build). */
export interface MaintainBuild {
  releaseCommit: string | undefined;
  version: string;
}

export const DEFAULT_BUILD: MaintainBuild = {
  releaseCommit: NIMBUS_RELEASE_COMMIT,
  version: NIMBUS_VERSION,
};

export class MaintainError extends Error {}

export interface ParsedArgs {
  positional: string[];
  options: Map<string, string>;
  /** Every value of a repeatable option, in order. */
  lists: Map<string, string[]>;
  flags: Set<string>;
}

export function parseArgs(
  args: string[],
  valued: readonly string[],
  boolean: readonly string[],
  repeatable: readonly string[] = [],
): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (valued.includes(a) || repeatable.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new MaintainError(`${a} needs a value`);
      if (repeatable.includes(a)) lists.set(a, [...(lists.get(a) ?? []), v]);
      else options.set(a, v);
      i++;
    } else if (boolean.includes(a)) {
      flags.add(a);
    } else if (a.startsWith("--")) {
      throw new MaintainError(`unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { positional, options, lists, flags };
}

export function loadSeed(keyPath: string): Uint8Array {
  let seed: Uint8Array;
  try {
    seed = decodeBase64(readFileSync(keyPath, "utf8").trim());
  } catch (e) {
    throw new MaintainError(
      `could not read key file ${keyPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (seed.length !== 32) throw new MaintainError(`key file ${keyPath} did not decode to 32 bytes`);
  return seed;
}

export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Fixed files of the gh-pages site. `.nojekyll` stops GitHub Pages' Jekyll from dropping paths
 * that start with `_` or `.`; `.gitattributes` keeps git from rewriting the line endings of the
 * hashed and signed bytes the site serves. The sign action builds on the previous site tree, so
 * both survive every sign run.
 */
export const SITE_FILES: ReadonlyArray<readonly [string, string]> = [
  [".nojekyll", ""],
  [".gitattributes", "* -text\n"],
];

export function resolveActionPin(p: ParsedArgs, build: MaintainBuild): ActionPin {
  const given = p.options.get("--action-ref");
  const commit = given ?? build.releaseCommit;
  if (commit === undefined) {
    throw new MaintainError(
      "--github needs a Nimbus commit to pin the registry action to, and this build has no embedded release commit: pass --action-ref <40-hex commit SHA>",
    );
  }
  if (!COMMIT_SHA_RE.test(commit)) {
    throw new MaintainError(
      given === undefined
        ? `this build's embedded release commit is not a 40-hex SHA (${commit}); pass --action-ref <40-hex commit SHA>`
        : "--action-ref must be a 40-hex lowercase commit SHA",
    );
  }
  return { commit, version: build.version };
}

export function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * A conservative subset of git's ref-format rules, so the name is safe both as a branch and inside
 * the emitted YAML: ASCII letters, digits, `.`, `_`, `-` and `/`; no leading `-` or `.`; no `..`,
 * `//`, `/.`, trailing `/` or `.`, or `.lock` suffix.
 */
export const BRANCH_RE = /^\w[\w./-]{0,99}$/;

export function resolveDefaultBranch(p: ParsedArgs): string {
  const branch = p.options.get("--default-branch") ?? "main";
  const unsafe =
    !BRANCH_RE.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("/.") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock");
  if (unsafe) {
    throw new MaintainError(
      "--default-branch must be a plain branch name (letters, digits, . _ - /; no leading - or ., no .., no trailing / or .)",
    );
  }
  return branch;
}

export function writeRootKey(keyPath: string, privkey: Uint8Array, force: boolean): void {
  mkdirSync(dirname(keyPath), { recursive: true });
  try {
    writeFileSync(keyPath, `${encodeBase64(privkey)}\n`, { flag: force ? "w" : "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MaintainError(`refusing to overwrite ${keyPath} without --force`);
    }
    throw e;
  }
  if (process.platform !== "win32") chmodSync(keyPath, 0o600);
}

export function splitIdVersion(ref: string): { id: string; version: string | undefined } {
  const at = ref.lastIndexOf("@");
  if (at > 0 && isValidSemver(ref.slice(at + 1))) {
    return { id: ref.slice(0, at), version: ref.slice(at + 1) };
  }
  return { id: ref, version: undefined };
}

/** An `https:` URL, or a refusal naming the option. */
export function httpsUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MaintainError(`${what} is not a URL`);
  }
  if (url.protocol !== "https:") throw new MaintainError(`${what} must be an https: URL`);
  return url.toString();
}

/**
 * A file-name-safe slug of an extension id (`/` becomes `-`), short enough that
 * `takedown-<slug>-<8-char hash>` stays within REQUEST_NAME_RE's 64 characters.
 */
export const slugOf = (id: string): string =>
  id
    .toLowerCase()
    .replaceAll("/", "-")
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 64 - "takedown-".length - "-".length - 8);

/** The request a `revoke-key` / `takedown` invocation describes, checked by the format's rules. */
export function requestFrom(
  kind: "key.revoke" | "extension.takedown",
  p: ParsedArgs,
  subject: string,
  requirePublisher = false,
): RegistryRequest {
  const reason = p.options.get("--reason");
  if (reason === undefined) throw new MaintainError("--reason <text> is required");
  const publisher = p.options.get("--publisher");
  if (kind === "key.revoke") {
    if (publisher === undefined) throw new MaintainError("revoke-key needs --publisher <id>");
    return parseRegistryRequest({ kind, publisherId: publisher, keyFingerprint: subject, reason });
  }
  if (requirePublisher && publisher === undefined) {
    throw new MaintainError("takedown needs --publisher <id>");
  }
  const { id, version } = splitIdVersion(subject);
  return parseRegistryRequest({
    kind,
    extensionId: id,
    ...(publisher === undefined ? {} : { publisherId: publisher }),
    versions: version === undefined ? "*" : [version],
    reason,
  });
}

/**
 * Writes `req` as `<root>/<dir>/<name>.json`, named `revoke-<fp12>-<hash8>` / `takedown-<slug>-<hash8>`
 * (the subject plus a short hash of the request: a second block for the same id gets its own file,
 * and the identical request maps to the same name). Exclusive create (`wx`), so nothing can appear
 * between a check for the file and the write; an identical existing file is `"same"`.
 */
export function writeRequestJson(
  root: string,
  dir: string,
  req: RegistryRequest,
): { path: string; status: "written" | "same" } {
  const text = `${JSON.stringify(req, null, 2)}\n`;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  const subject =
    req.kind === "key.revoke"
      ? `revoke-${req.keyFingerprint.slice(0, 12)}`
      : `takedown-${slugOf(req.extensionId)}`;
  const name = `${subject}-${hash}`;
  if (!REQUEST_NAME_RE.test(name)) {
    throw new MaintainError(`cannot name a request file for ${name}`);
  }
  const path = join(root, dir, `${name}.json`);
  mkdirSync(join(root, dir), { recursive: true });
  try {
    writeFileSync(path, text, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (readFileSync(path, "utf8") === text) return { path, status: "same" };
    throw new MaintainError(`${path} exists with different content; remove it first`);
  }
  return { path, status: "written" };
}
