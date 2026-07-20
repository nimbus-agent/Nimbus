import { describe, expect, test } from "bun:test";
import { enumerateSecrets } from "./credential-enumerate";

type Handler = (url: string) => { status: number; body: unknown };

function fetcher(handler: Handler) {
  return async (url: string): Promise<Response> => {
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Default handler: an installation covering one repo, everything else empty. */
function baseHandler(repoNames: string[]): Handler {
  return (url) => {
    if (url.includes("/installation/repositories")) {
      return { status: 200, body: { repositories: repoNames.map((name) => ({ name })) } };
    }
    return { status: 200, body: { secrets: [] } };
  };
}

describe("enumerateSecrets", () => {
  test("tags org secrets with scope, product and visibility", async () => {
    const { secrets, errors } = await enumerateSecrets({
      token: "t",
      fetchFn: fetcher((url) => {
        if (url.includes("/installation/repositories")) {
          return { status: 200, body: { repositories: [] } };
        }
        return {
          status: 200,
          body: {
            secrets: [{ name: "ORG_ONE", updated_at: "2026-01-01T00:00:00Z", visibility: "all" }],
          },
        };
      }),
    });
    expect(errors).toEqual([]);
    expect(secrets).toEqual([
      {
        name: "ORG_ONE",
        scope: "org",
        product: "actions",
        updatedAt: "2026-01-01T00:00:00Z",
        visibility: "all",
      },
    ]);
  });

  test("scans EVERY repo the installation covers, not a caller-supplied list", async () => {
    const asked: string[] = [];
    await enumerateSecrets({
      token: "t",
      fetchFn: fetcher((url) => {
        if (url.includes("/installation/repositories")) {
          return {
            status: 200,
            body: {
              repositories: [
                { name: "Nimbus" },
                { name: "nimbus-benchmarks" },
                { name: "awesome-nimbus" },
              ],
            },
          };
        }
        asked.push(url);
        return { status: 200, body: { secrets: [] } };
      }),
    });
    // Every discovered repo is queried for both products; none may be skipped.
    for (const repo of ["Nimbus", "nimbus-benchmarks", "awesome-nimbus"]) {
      expect(asked.some((u) => u.includes(`/repos/nimbus-agent/${repo}/actions/secrets`))).toBe(
        true,
      );
      expect(asked.some((u) => u.includes(`/repos/nimbus-agent/${repo}/dependabot/secrets`))).toBe(
        true,
      );
    }
  });

  test("a repo with no secrets returns 200 and an empty list, not an error", async () => {
    const { secrets, errors } = await enumerateSecrets({
      token: "t",
      fetchFn: fetcher(baseHandler(["Nimbus"])),
    });
    expect(secrets).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("enumerates both Actions and Dependabot secrets per repo", async () => {
    const { secrets } = await enumerateSecrets({
      token: "t",
      fetchFn: fetcher((url) => {
        if (url.includes("/installation/repositories")) {
          return { status: 200, body: { repositories: [{ name: "Nimbus" }] } };
        }
        if (url.includes("orgs/")) return { status: 200, body: { secrets: [] } };
        const name = url.includes("dependabot") ? "DEP" : "ACT";
        return { status: 200, body: { secrets: [{ name, updated_at: "2026-01-01T00:00:00Z" }] } };
      }),
    });
    expect(secrets.map((s) => `${s.product}:${s.name}`).sort()).toEqual([
      "actions:ACT",
      "dependabot:DEP",
    ]);
  });

  test("a 403 is reported as an error, never silently treated as an empty repo", async () => {
    const { secrets, errors } = await enumerateSecrets({
      token: "t",
      fetchFn: fetcher((url) => {
        if (url.includes("/installation/repositories")) {
          return { status: 200, body: { repositories: [{ name: "Nimbus" }] } };
        }
        return url.includes("dependabot")
          ? { status: 403, body: { message: "Resource not accessible by integration" } }
          : { status: 200, body: { secrets: [] } };
      }),
    });
    expect(secrets).toEqual([]);
    expect(errors.join(" ")).toContain("403");
    expect(errors.join(" ")).toContain("dependabot");
  });

  test("a 404 on a repo is tolerated — the App may not be installed there", async () => {
    const { errors } = await enumerateSecrets({
      token: "t",
      fetchFn: fetcher((url) => {
        if (url.includes("/installation/repositories")) {
          return { status: 200, body: { repositories: [{ name: "ghost" }] } };
        }
        return url.includes("orgs/")
          ? { status: 200, body: { secrets: [] } }
          : { status: 404, body: {} };
      }),
    });
    expect(errors).toEqual([]);
  });

  test("a failure to discover repos is an error, never a silent empty scan", async () => {
    const { errors } = await enumerateSecrets({
      token: "t",
      fetchFn: fetcher((url) =>
        url.includes("/installation/repositories")
          ? { status: 403, body: {} }
          : { status: 200, body: { secrets: [] } },
      ),
    });
    expect(errors.join(" ")).toContain("installation repositories");
  });

  test("never puts the token in a URL", async () => {
    const seen: string[] = [];
    await enumerateSecrets({
      token: "super-secret-token",
      fetchFn: async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify({ repositories: [], secrets: [] }), { status: 200 });
      },
    });
    expect(seen.join(" ")).not.toContain("super-secret-token");
  });
});
