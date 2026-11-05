/**
 * Plan R7 (owner ruling: Discord user mentions only). The gateway does not refuse `@everyone`,
 * `@here` or `<@&role>` in a Discord post: the INSTALLED connector neutralises them by sending
 * `allowed_mentions: { parse: ["users"] }`, so they arrive as plain text and notify nobody. This
 * pins that behaviour, so a connectors bump that loosens it fails CI here instead of pinging a
 * whole guild.
 */
import { describe, expect, test } from "bun:test";

import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";

const SOURCES = readConnectorPackageSources(installedConnectorsPackageRoot());
const SCAN = scanWriteToolRegistrations(SOURCES);

/** The mesh server a registration belongs to: its origin connector directory, `-` to `_`. */
function serverOf(origin: string): string {
  return (origin.split("/")[1] ?? "").replaceAll("-", "_");
}

const USERS_ONLY = /allowed_mentions\s*:\s*\{\s*parse\s*:\s*\[\s*"users"\s*\]\s*\}/;
const BROADER = /["'](everyone|roles)["']/;

/** Whether a registering call's comment-free text sends user mentions only. */
function sendsUserMentionsOnly(call: string): boolean {
  return USERS_ONLY.test(call) && !BROADER.test(call);
}

describe("Discord posts notify users only (connector-enforced, pinned here)", () => {
  test("the installed discord_message_post sends allowed_mentions parse users, nothing broader", () => {
    const hits = SCAN.registrations.filter(
      (r) => r.id === "discord_message_post" && serverOf(r.origin) === "discord",
    );
    expect(hits).toHaveLength(1);
    const r = hits[0];
    if (r === undefined) throw new Error("unreachable");
    const src = SOURCES.find((s) => s.rel === r.file);
    const call = stripComments(src?.text ?? "").slice(r.span[0], r.span[1] + 1);
    expect(call).toContain('"discord_message_post"');
    expect(call).toContain("/messages");
    expect(sendsUserMentionsOnly(call)).toBe(true);
  });

  test("guard: the matcher fails a broader parse list and a call with no allowed_mentions", () => {
    expect(sendsUserMentionsOnly('body: { content, allowed_mentions: { parse: ["users"] } }')).toBe(
      true,
    );
    expect(
      sendsUserMentionsOnly(
        'body: { content, allowed_mentions: { parse: ["users", "everyone"] } }',
      ),
    ).toBe(false);
    expect(
      sendsUserMentionsOnly(
        'body: { content, allowed_mentions: { parse: ["users"] }, x: { parse: ["roles"] } }',
      ),
    ).toBe(false);
    expect(sendsUserMentionsOnly("body: { content }")).toBe(false);
  });
});
