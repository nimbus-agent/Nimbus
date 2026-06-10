import type { ChatIdentity, ChatPlatform } from "./types.ts";

/** A SCIM-backed identity row, as the mapper needs it. */
export interface ScimMatch {
  readonly externalId: string;
  readonly email: string;
  readonly active: boolean;
  readonly issuer: string;
}

export interface IdentityMapperDeps {
  /** Cloud round-trip: platform userId -> email (read-only connector tool). */
  readonly lookupEmail: (platform: ChatPlatform, userId: string) => Promise<string | undefined>;
  /** Local lookup: email -> SCIM identity (Slice 3). */
  readonly findScimByEmail: (email: string) => ScimMatch | undefined;
  /** I18 operator validity for the identity's issuer (live, local, synchronous). */
  readonly isOperatorValid: (issuer: string) => boolean;
  readonly nowMs: () => number;
  readonly ttlSeconds: number;
}

export type ResolveResult =
  | { readonly kind: "mapped"; readonly identity: ChatIdentity }
  | { readonly kind: "unmapped" };

interface CacheEntry {
  readonly email: string;
  readonly expiresMs: number;
}

/**
 * Resolves a chat user to a Nimbus identity. The userId->email mapping (a cloud round-trip) is cached
 * with a TTL; authorization (SCIM active + I18 operator validity) is re-evaluated LIVE and LOCALLY on
 * every call, so a deprovision takes effect on the next message with no stale-auth window (review Q1).
 */
export class ChatopsIdentityMapper {
  private readonly cache = new Map<string, CacheEntry>();
  constructor(private readonly deps: IdentityMapperDeps) {}

  private cacheKey(platform: ChatPlatform, userId: string): string {
    return `${platform}:${userId}`;
  }

  /** Drop a cached email (called from the deprovision hook, keyed by email). */
  evict(email: string): void {
    for (const [k, v] of this.cache) if (v.email === email) this.cache.delete(k);
  }

  async resolve(platform: ChatPlatform, userId: string): Promise<ResolveResult> {
    const key = this.cacheKey(platform, userId);
    const now = this.deps.nowMs();
    let email: string | undefined;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresMs > now) {
      email = cached.email;
    } else {
      email = await this.deps.lookupEmail(platform, userId);
      if (email === undefined) {
        this.cache.delete(key);
        return { kind: "unmapped" };
      }
      this.cache.set(key, { email, expiresMs: now + this.deps.ttlSeconds * 1000 });
    }

    // Authorization is ALWAYS live + local — never cached.
    const scim = this.deps.findScimByEmail(email);
    if (!scim?.active) return { kind: "unmapped" };
    if (!this.deps.isOperatorValid(scim.issuer)) return { kind: "unmapped" };
    return {
      kind: "mapped",
      identity: { externalId: scim.externalId, email: scim.email, issuer: scim.issuer },
    };
  }
}
