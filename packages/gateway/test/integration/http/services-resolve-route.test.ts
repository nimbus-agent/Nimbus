/**
 * End-to-end tests for `GET /v1/services/resolve` — the repo-URN-to-service lookup a browser
 * client uses to learn which service id to pass `/v1/metrics/dora` and `/v1/preflight/deploy`.
 *
 * Sibling of `items-resolve-ids-route.test.ts`: same harness, same inline-bearer-read seam, same
 * `resolve` scope. The design doc was pruned with the rest of the delivered set; the shipped
 * behaviour — the resolve form and its cardinality rule — is described in `docs/CHANGELOG.md`'s
 * 2026-09-11 entry.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_SCOPES } from "../../../src/clips/api-scopes.ts";
import {
  startServerWithClipToken,
  startServerWithoutClipsVault,
} from "../../../src/ipc/http-api-test-server.ts";

type ResolveBody = {
  readonly service: string | null;
  readonly ambiguous: boolean;
  readonly candidates: readonly string[];
};

/** A config dir holding one `nimbus.toml` with the given body. */
function configDirWith(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-services-resolve-"));
  writeFileSync(join(dir, "nimbus.toml"), toml, "utf8");
  return dir;
}

function get(port: number, token: string | undefined, query: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/services/resolve?${query}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

function repoQuery(repo: string): string {
  return new URLSearchParams({ repo }).toString();
}

const ONE_SERVICE = `
[metrics.dora.payment-service]
repos = ["github:acme/payments-api", "jenkins:platform/payments"]
`;

describe("GET /v1/services/resolve (integration)", () => {
  test("resolves a repo URN to the service that claims it", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      configDir: configDirWith(ONE_SERVICE),
    });
    try {
      const res = await get(port, token, repoQuery("github:acme/payments-api"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        service: "payment-service",
        ambiguous: false,
        candidates: ["payment-service"],
      });
    } finally {
      stop();
    }
  });

  test("resolves a non-forge provider from the same service's repo list", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      configDir: configDirWith(ONE_SERVICE),
    });
    try {
      const res = await get(port, token, repoQuery("jenkins:platform/payments"));
      expect(((await res.json()) as ResolveBody).service).toBe("payment-service");
    } finally {
      stop();
    }
  });

  // C6. The item-shaped matcher (`repoMetadataMatchesUrn`) returns false for EVERY circleci URN,
  // because an indexed item carries no external id to match on. A URN-to-URN query has no such
  // gap. This test is the contract: `circleci` is not a second-class provider on this route.
  test("resolves a circleci URN, which the item-shaped matcher cannot", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      configDir: configDirWith(`
[metrics.dora.builds]
repos = ["circleci:gh/acme/builds"]
`),
    });
    try {
      const res = await get(port, token, repoQuery("circleci:gh/acme/builds"));
      expect(((await res.json()) as ResolveBody).service).toBe("builds");
    } finally {
      stop();
    }
  });

  test("answers a total shape with service null when nothing claims the repo", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      configDir: configDirWith(ONE_SERVICE),
    });
    try {
      const res = await get(port, token, repoQuery("github:acme/unclaimed"));
      expect(res.status).toBe(200);
      // `ambiguous` and `candidates` are present even here: a client must never have to read
      // their ABSENCE as "uncontested".
      expect(await res.json()).toEqual({ service: null, ambiguous: false, candidates: [] });
    } finally {
      stop();
    }
  });

  // §5.1: first claimant wins — matching the binding the rest of the DORA pipeline already makes
  // for the same repo — and every claimant is disclosed, because the caller is about to gate a
  // deployment on the answer and cannot see the resolver's stderr ambiguity warning.
  test("discloses every claimant when two services claim one repo, first still winning", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      configDir: configDirWith(`
[metrics.dora.payments]
repos = ["github:acme/shared"]

[metrics.dora.billing]
repos = ["github:acme/shared"]
`),
    });
    try {
      const res = await get(port, token, repoQuery("github:acme/shared"));
      expect(await res.json()).toEqual({
        service: "payments",
        ambiguous: true,
        candidates: ["payments", "billing"],
      });
    } finally {
      stop();
    }
  });

  test("refuses a malformed URN rather than answering a confident null", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      configDir: configDirWith(ONE_SERVICE),
    });
    try {
      for (const bad of ["githu:acme/web", "acme/web", "github:"]) {
        const res = await get(port, token, repoQuery(bad));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_repo_urn" });
      }
    } finally {
      stop();
    }
  });

  test("refuses an absent or blank repo parameter", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      configDir: configDirWith(ONE_SERVICE),
    });
    try {
      expect((await get(port, token, "")).status).toBe(400);
      expect((await get(port, token, repoQuery("   "))).status).toBe(400);
    } finally {
      stop();
    }
  });

  test("answers the total empty shape when no config dir is wired", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"]);
    try {
      const res = await get(port, token, repoQuery("github:acme/payments-api"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ service: null, ambiguous: false, candidates: [] });
    } finally {
      stop();
    }
  });

  test("answers the total empty shape when nimbus.toml is absent", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      configDir: mkdtempSync(join(tmpdir(), "nimbus-services-resolve-empty-")),
    });
    try {
      const res = await get(port, token, repoQuery("github:acme/payments-api"));
      expect(res.status).toBe(200);
      expect(((await res.json()) as ResolveBody).service).toBeNull();
    } finally {
      stop();
    }
  });

  // The malformed-config row the spec left to the gateway. SURFACED, not degraded: a `service:
  // null` here is indistinguishable from "no service claims this repo", which is a confident wrong
  // answer about the owner's own configuration.
  test("surfaces a malformed nimbus.toml instead of degrading to null", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      configDir: configDirWith(`
[metrics.dora.payments]
repos = ["github:acme/payments-api"]
deploy_environments = ["staging-EU!"]
`),
    });
    try {
      const res = await get(port, token, repoQuery("github:acme/payments-api"));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "config_unreadable" });
    } finally {
      stop();
    }
  });

  // The parse-failure messages embed the service id AND the offending value verbatim. A client
  // token is not the owner, so none of it may cross the wire.
  test("the malformed-config body echoes no config value", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      configDir: configDirWith(`
[metrics.dora.super-secret-service]
repos = ["github:acme/payments-api"]
deploy_environments = ["staging-EU!"]
`),
    });
    try {
      const body = await (await get(port, token, repoQuery("github:acme/payments-api"))).text();
      expect(body).not.toContain("super-secret-service");
      expect(body).not.toContain("staging-EU");
    } finally {
      stop();
    }
  });

  test("403 for a token without the resolve scope", async () => {
    const { port, token, stop } = await startServerWithClipToken(LEGACY_SCOPES, {
      configDir: configDirWith(ONE_SERVICE),
    });
    try {
      expect((await get(port, token, repoQuery("github:acme/payments-api"))).status).toBe(403);
    } finally {
      stop();
    }
  });

  test("401 with no bearer at all", async () => {
    const { port, stop } = await startServerWithClipToken(["resolve"], {
      configDir: configDirWith(ONE_SERVICE),
    });
    try {
      expect((await get(port, undefined, repoQuery("github:acme/payments-api"))).status).toBe(401);
    } finally {
      stop();
    }
  });

  // The capability signal, and the ambiguity named in the handler: this 404 tests that the CLIPS
  // SURFACE is mounted, not that the route exists — so it is also what a gateway too old to carry
  // the route answers. Both readings lead the client to the same fallback.
  test("404 services_disabled when the clips surface is not mounted", async () => {
    const { port, stop } = await startServerWithoutClipsVault({
      configDir: configDirWith(ONE_SERVICE),
    });
    try {
      const res = await get(port, "irrelevant", repoQuery("github:acme/payments-api"));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "services_disabled" });
    } finally {
      stop();
    }
  });

  // The surface-unmounted check runs BEFORE the auth check, so an unmounted gateway answers 404
  // rather than 401 even to a caller with no credential at all. Pinned because the ORDER is the
  // contract: a 401 here would tell an unauthenticated caller that the surface exists.
  test("the unmounted 404 precedes the auth check", async () => {
    const { port, stop } = await startServerWithoutClipsVault({
      configDir: configDirWith(ONE_SERVICE),
    });
    try {
      expect((await get(port, undefined, repoQuery("github:acme/payments-api"))).status).toBe(404);
    } finally {
      stop();
    }
  });

  test("the wire shape carries exactly three keys", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      configDir: configDirWith(ONE_SERVICE),
    });
    try {
      const body = (await (
        await get(port, token, repoQuery("github:acme/payments-api"))
      ).json()) as Record<string, unknown>;
      // Pins the WIRE key set. `ServiceConfig` also carries `pagerdutyServices`,
      // `deployEnvironments` and a `deployWorkflowPattern` RegExp that JSON.stringify renders as
      // `{}` — a spread would look harmless in a fixture while shipping the first two.
      expect(Object.keys(body).sort()).toEqual(["ambiguous", "candidates", "service"]);
    } finally {
      stop();
    }
  });
});
