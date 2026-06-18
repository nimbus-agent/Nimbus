// packages/gateway/src/share/share-forwarding.ts
import nacl from "tweetnacl";
import type { ShareFile, ShareForwardingHop } from "./share-format.ts";

/**
 * Canonical bytes a forwarding hop signs over: the immutable `contentHash`, the hop's own identity
 * (`gatewayLabel` + `pubkey`), and a stable serialization of the PRIOR chain entries. Binding the
 * hop's own label+pubkey means mutating either field invalidates the sig. Binding the prior chain
 * means hops cannot be reordered or truncated without invalidating later hops. Pure + deterministic.
 * (spec §9.2)
 */
export function hopSigningMessage(
  contentHash: string,
  priorChain: readonly ShareForwardingHop[],
  self: { gatewayLabel: string; pubkey: string },
): Uint8Array {
  const stablePrior = priorChain.map((h) => ({
    gatewayLabel: h.gatewayLabel,
    pubkey: h.pubkey,
    sig: h.sig,
  }));
  const selfPart = `${self.gatewayLabel}\n${self.pubkey}\n`;
  return new TextEncoder().encode(`${contentHash}\n${selfPart}${JSON.stringify(stablePrior)}`);
}

/**
 * Append ONE forwarding hop. The inner `body` + origin `sig` + `contentHash` are returned untouched
 * (byte-identical) — a forwarder NEVER re-signs or mutates content. Only the top-level `forwarding`
 * envelope grows: one `{ gatewayLabel, pubkey, sig }` entry signed with the forwarder's Ed25519
 * share key (same primitive as `buildShareFile`) over `hopSigningMessage(contentHash, priorChain)`.
 */
export function appendForwardingHop(
  share: ShareFile,
  signer: { gatewayLabel: string; pubkeyB64: string; privkeyB64: string },
): ShareFile {
  const seed = new Uint8Array(Buffer.from(signer.privkeyB64, "base64"));
  if (seed.length !== 32) {
    throw new TypeError(`hop signing key must be a 32-byte seed, got ${seed.length}`);
  }
  const kp = nacl.sign.keyPair.fromSeed(seed);
  // Bind the hop's recorded pubkey to the ACTUAL signing key (derived from the seed), not a
  // caller-supplied value — a mismatched input pair would otherwise emit a self-invalid hop.
  const derivedPubkeyB64 = Buffer.from(kp.publicKey).toString("base64");
  if (signer.pubkeyB64 !== derivedPubkeyB64) {
    throw new TypeError("hop signer pubkey does not match the private-key seed");
  }
  const priorChain = share.forwarding.chain;
  const self = { gatewayLabel: signer.gatewayLabel, pubkey: derivedPubkeyB64 };
  const msg = hopSigningMessage(share.contentHash, priorChain, self);
  const sig = Buffer.from(nacl.sign.detached(msg, kp.secretKey)).toString("base64");
  const hop: ShareForwardingHop = {
    gatewayLabel: signer.gatewayLabel,
    pubkey: derivedPubkeyB64,
    sig,
  };
  const chain = [...priorChain, hop];
  return {
    // `hops` is derived from the chain length so it can never drift from the actual chain.
    ...share,
    forwarding: { hops: chain.length, chain },
  };
}

export interface ForwardingChainResult {
  readonly valid: boolean;
  readonly hopsValid: number;
  readonly hopsTotal: number;
  readonly errors: readonly string[];
}

/**
 * Validate the advisory hop chain: each hop's `sig` must verify against its claimed `pubkey` over
 * `hopSigningMessage(contentHash, chain[0..i-1])`. Never touches content/origin verification — a
 * bad hop is reported here while the inner `body`/`sig` remain independently verifiable.
 */
export function verifyForwardingChain(share: ShareFile): ForwardingChainResult {
  const chain = share.forwarding.chain;
  const errors: string[] = [];
  let hopsValid = 0;
  for (const [i, hop] of chain.entries()) {
    try {
      const pub = new Uint8Array(Buffer.from(hop.pubkey, "base64"));
      const sig = new Uint8Array(Buffer.from(hop.sig, "base64"));
      // Each hop binds its own pubkey into the signed message AND uses it as the verify key by design:
      // this dual use means a pubkey swap invalidates the signature.
      const self = { gatewayLabel: hop.gatewayLabel, pubkey: hop.pubkey };
      const msg = hopSigningMessage(share.contentHash, chain.slice(0, i), self);
      if (pub.length === 32 && sig.length === 64 && nacl.sign.detached.verify(msg, sig, pub)) {
        hopsValid++;
      } else {
        errors.push(`hop ${i} (${hop.gatewayLabel}): signature invalid`);
      }
    } catch {
      errors.push(`hop ${i} (${hop.gatewayLabel}): malformed key/signature`);
    }
  }
  return { valid: errors.length === 0, hopsValid, hopsTotal: chain.length, errors };
}
