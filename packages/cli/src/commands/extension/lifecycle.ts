import { confirm, isCancel } from "@clack/prompts";
import type { IPCClient } from "../../ipc-client/index.ts";
import { readLine } from "../../lib/read-line.ts";
import { stripControl } from "../captures-format.ts";
import { hasFlag } from "./flags.ts";

export async function runExtensionEnable(client: IPCClient, rest: string[]): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension enable <id>");
  }
  const out = await client.call<{ ok: boolean }>("extension.enable", { id });
  console.log(JSON.stringify(out, undefined, 2));
}

export async function runExtensionDisable(client: IPCClient, rest: string[]): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension disable <id>");
  }
  const out = await client.call<{ ok: boolean }>("extension.disable", { id });
  console.log(JSON.stringify(out, undefined, 2));
}

/** The removal's one prompt beyond the confirmation: the offer to remove orphaned members. */
export type ExtensionRemoveIo = {
  readonly confirm: (question: string) => Promise<boolean>;
};

/** The offer's question goes to stderr: stdout carries the removal's JSON result. */
const defaultRemoveIo: ExtensionRemoveIo = {
  confirm: async (q) => /^y(es)?$/i.test(await readLine(q, undefined, process.stderr)),
};

type ExtensionRemoveResult = { ok: boolean; orphanedDependencies?: unknown };

/** An older gateway returns no `orphanedDependencies`; anything not a string list reads as none. */
function orphansOf(out: ExtensionRemoveResult): string[] {
  const raw = out.orphanedDependencies;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

export async function runExtensionRemove(
  client: IPCClient,
  args: string[],
  rest: string[],
  io: ExtensionRemoveIo = defaultRemoveIo,
): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension remove <id> [--yes] [--force] [--clean-deps]");
  }
  const accept = hasFlag(args, "--yes") || hasFlag(args, "-y");
  const force = hasFlag(args, "--force");
  const cleanDeps = hasFlag(args, "--clean-deps");

  if (force) {
    process.stderr.write(
      "--force: will remove even if other installed extensions depend on this.\n",
    );
  }

  if (!accept) {
    if (process.stdout.isTTY !== true) {
      throw new Error(
        "Refusing to remove without confirmation in non-TTY mode. Pass --yes to proceed.",
      );
    }
    const ok = await confirm({
      message: `Remove extension "${id}" from the registry and delete its files?`,
    });
    if (isCancel(ok) || ok !== true) {
      console.log("Cancelled.");
      return;
    }
  }

  let out: ExtensionRemoveResult;
  const payload: { id: string; force?: true } = force ? { id, force: true } : { id };
  try {
    out = await client.call<ExtensionRemoveResult>("extension.remove", payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("reverse_dep_blocked")) {
      process.stderr.write(`${msg}\nRe-run with --force to override.\n`);
      process.exit(1);
    }
    throw e;
  }
  console.log(JSON.stringify(out, undefined, 2));
  await handleOrphanedDependencies(client, id, orphansOf(out), {
    cleanDeps,
    attended: !accept && process.stdin.isTTY === true && process.stdout.isTTY === true,
    io,
  });
}

/**
 * After a removal: the members installed only for `id` are removed with `--clean-deps`, offered at
 * an attended terminal, and otherwise only named. Each goes through its own `extension.remove`, in
 * the gateway's order (dependents first), with no second confirmation and no further offer; one
 * that fails is reported and the rest still go, and the command then exits 1. Every line here goes
 * to stderr, so stdout stays the removal's JSON result.
 */
async function handleOrphanedDependencies(
  client: IPCClient,
  id: string,
  orphans: readonly string[],
  opts: { cleanDeps: boolean; attended: boolean; io: ExtensionRemoveIo },
): Promise<void> {
  if (orphans.length === 0) return;
  const safeId = stripControl(id);
  const list = orphans.map((o) => stripControl(o)).join(", ");
  const say = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  if (!opts.cleanDeps) {
    const question = `Also remove ${orphans.length} package(s) installed only for ${safeId}: ${list}? [y/N] `;
    if (!opts.attended || !(await opts.io.confirm(question))) {
      // Not `--clean-deps`: `id` is already gone, so naming it again fails, and nothing offers
      // these packages later. Name the removals that work now, dependents first.
      const commands = orphans
        .map((o) => `nimbus extension remove ${stripControl(o)}`)
        .join(" && ");
      say(`Kept ${list}, installed only for ${safeId}; remove them with: ${commands}`);
      return;
    }
  }
  let failed = 0;
  for (const orphan of orphans) {
    try {
      await client.call<ExtensionRemoveResult>("extension.remove", { id: orphan });
      say(`Removed ${stripControl(orphan)}.`);
    } catch (e) {
      failed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      say(`Could not remove ${stripControl(orphan)}: ${stripControl(msg)}`);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

/**
 * `nimbus extension keygen`. All of the work is synchronous; `Promise.try` keeps the contract an
 * `async` function had — the body still runs at call time, and a filesystem error REJECTS rather
 * than throwing at the caller.
 */
