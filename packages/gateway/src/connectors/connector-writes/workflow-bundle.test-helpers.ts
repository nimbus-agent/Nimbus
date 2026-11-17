// Test support for the signed workflow bundle: builds and signs bundles with a throwaway key. Imported by
// tests only (never by production code).
import nacl from "tweetnacl";
import {
  BUNDLE_SIGN_TAG,
  type BundleBody,
  buildBundleBody,
} from "../../automation/workflow-bundle.ts";
import { canonicalJson } from "../../util/canonical-json.ts";

export const FIXTURE_NOW = 1_763_300_000_000;

export const FIXTURE_STEPS: readonly unknown[] = [
  {
    kind: "query",
    label: "old-mail",
    query: {
      service: "gmail",
      type: "email",
      where: [{ metadata: "labelIds", notContains: "UNREAD" }, { olderThanDays: 60 }],
      select: "metadata.threadId",
      distinct: true,
      limit: 200,
    },
  },
  {
    kind: "write",
    label: "archive",
    tool: "gmail_thread_archive",
    input: { threadId: { from: "old-mail", column: "metadata.threadId" } },
  },
];

export function fixtureKey(seedByte = 7): nacl.SignKeyPair {
  return nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
}

export function pubB64(kp: nacl.SignKeyPair): string {
  return Buffer.from(kp.publicKey).toString("base64");
}

/** A canonical body for `steps` (default {@link FIXTURE_STEPS}); `over` replaces body fields. */
export function fixtureBody(
  over: Partial<Record<keyof BundleBody, unknown>> = {},
  steps: readonly unknown[] = FIXTURE_STEPS,
): BundleBody {
  const base = buildBundleBody(
    {
      name: "weekly-cleanup",
      description: "archive old mail",
      author: "team lead",
      issuedAt: FIXTURE_NOW - 1000,
      stepsJson: JSON.stringify(steps),
    },
    FIXTURE_NOW,
  );
  return { ...base, ...over } as BundleBody;
}

/** Signs `body` exactly as an export does (tag + canonical body); returns the file text. */
export function signFixture(
  body: unknown,
  kp: nacl.SignKeyPair = fixtureKey(),
  extraSig: Record<string, unknown> = {},
  extraTop: Record<string, unknown> = {},
): string {
  const bytes = new TextEncoder().encode(BUNDLE_SIGN_TAG + canonicalJson(body));
  const signature = Buffer.from(nacl.sign.detached(bytes, kp.secretKey)).toString("base64");
  return JSON.stringify({
    body,
    sig: { alg: "ed25519", pubkey: pubB64(kp), signature, ...extraSig },
    ...extraTop,
  });
}
