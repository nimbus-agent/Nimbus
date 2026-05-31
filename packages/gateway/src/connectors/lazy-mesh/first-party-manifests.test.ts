import { describe, expect, test } from "bun:test";

import {
  FIRST_PARTY_MANIFESTS,
  hostnameFromUrl,
  manifestForFirstParty,
  manifestWithExtraNetworkHosts,
} from "./first-party-manifests.ts";

describe("manifestForFirstParty", () => {
  test("returns the registered manifest for a known service id", () => {
    const m = manifestForFirstParty("github");
    expect(m.id).toBe("com.nimbus.github");
    expect(m.permissions.network).toContain("api.github.com");
    expect(m.permissions.filesystem.read).toEqual([]);
    expect(m.permissions.filesystem.write).toEqual([]);
  });

  test("returns default-deny under com.nimbus.<id> for an unknown service id", () => {
    const m = manifestForFirstParty("unknown-future-service");
    expect(m.id).toBe("com.nimbus.unknown-future-service");
    expect(m.permissions.network).toEqual([]);
    expect(m.permissions.filesystem.read).toEqual([]);
    expect(m.permissions.filesystem.write).toEqual([]);
  });

  test("filesystem connector has default-deny (paths threaded at spawn time)", () => {
    const m = manifestForFirstParty("filesystem");
    expect(m.permissions.network).toEqual([]);
    expect(m.permissions.filesystem.read).toEqual([]);
  });

  test("user-configured connectors (jenkins/grafana/kubernetes) have empty network", () => {
    expect(manifestForFirstParty("jenkins").permissions.network).toEqual([]);
    expect(manifestForFirstParty("grafana").permissions.network).toEqual([]);
    expect(manifestForFirstParty("kubernetes").permissions.network).toEqual([]);
  });

  test("microsoft bundle shares graph.microsoft.com + login.microsoftonline.com", () => {
    for (const id of ["onedrive", "outlook", "teams"]) {
      const m = manifestForFirstParty(id);
      expect(m.permissions.network).toContain("graph.microsoft.com");
      expect(m.permissions.network).toContain("login.microsoftonline.com");
    }
  });

  test("FIRST_PARTY_MANIFESTS contains the spec's enumerated connectors", () => {
    const expected = [
      "filesystem",
      "github",
      "github_actions",
      "gitlab",
      "bitbucket",
      "slack",
      "discord",
      "linear",
      "jira",
      "notion",
      "confluence",
      "google_drive",
      "gmail",
      "google_photos",
      "onedrive",
      "outlook",
      "teams",
      "jenkins",
      "circleci",
      "pagerduty",
      "aws",
      "azure",
      "gcp",
      "iac",
      "grafana",
      "sentry",
      "newrelic",
      "datadog",
      "snyk",
      "kubernetes",
      "obsidian",
      "bitrise",
      "sonarqube",
      "semgrep",
      "wiz",
      "launchdarkly",
      "flagsmith",
      "argocd",
      "flux",
      "dbt",
      "metabase",
      "superset",
      "databricks",
      "mlflow",
      "vercel",
      "netlify",
      "stripe",
      "mercury",
      "readwise",
      "raindrop",
      "intercom",
      "zendesk",
      "lever",
      "greenhouse",
      "pipedrive",
      "stackoverflow",
      "zotero",
      "dependencytrack",
      "airflow",
      "prefect",
      "dagster",
      "ramp",
      "zoom",
      "hubspot",
    ];
    for (const id of expected) {
      expect(FIRST_PARTY_MANIFESTS[id]).toBeDefined();
    }
  });
});

describe("hostnameFromUrl", () => {
  test("extracts the hostname from a well-formed https URL", () => {
    expect(hostnameFromUrl("https://api.github.com/repos")).toBe("api.github.com");
  });

  test("extracts the hostname from a well-formed http URL", () => {
    expect(hostnameFromUrl("http://localhost:9090/api")).toBe("localhost");
  });

  test("lowercases the hostname", () => {
    expect(hostnameFromUrl("https://API.GITHUB.COM/x")).toBe("api.github.com");
  });

  test("trims surrounding whitespace", () => {
    expect(hostnameFromUrl("  https://api.github.com  ")).toBe("api.github.com");
  });

  test("returns null for an unparseable URL", () => {
    expect(hostnameFromUrl("not a url")).toBeNull();
    expect(hostnameFromUrl("")).toBeNull();
    expect(hostnameFromUrl("http://")).toBeNull();
  });

  test("returns null when the URL's hostname is empty", () => {
    expect(hostnameFromUrl("file:///etc/passwd")).toBeNull();
  });

  test("works for non-standard ports + paths", () => {
    expect(hostnameFromUrl("https://grafana.example.com:3000/d/abc")).toBe("grafana.example.com");
  });
});

describe("manifestWithExtraNetworkHosts", () => {
  test("returns the base manifest verbatim when extra is empty", () => {
    const out = manifestWithExtraNetworkHosts("github", []);
    expect(out.permissions.network).toEqual([
      "api.github.com",
      "uploads.github.com",
      "raw.githubusercontent.com",
    ]);
  });

  test("appends a new host", () => {
    const out = manifestWithExtraNetworkHosts("jenkins", ["jenkins.internal.example.com"]);
    expect(out.permissions.network).toEqual(["jenkins.internal.example.com"]);
  });

  test("extends an existing connector's network list without duplicating", () => {
    const out = manifestWithExtraNetworkHosts("github", ["enterprise.github.example.com"]);
    expect(out.permissions.network).toContain("api.github.com");
    expect(out.permissions.network).toContain("enterprise.github.example.com");
    expect(out.permissions.network.length).toBe(4);
  });

  test("dedupes against existing entries", () => {
    const out = manifestWithExtraNetworkHosts("github", ["api.github.com", "uploads.github.com"]);
    expect(out.permissions.network.length).toBe(3);
  });

  test("dedupes case-insensitively + trims whitespace", () => {
    const out = manifestWithExtraNetworkHosts("github", ["  API.GITHUB.COM  ", "api.github.com"]);
    expect(out.permissions.network.length).toBe(3);
  });

  test("drops empty / whitespace-only entries", () => {
    const out = manifestWithExtraNetworkHosts("jenkins", ["", "   ", "jenkins.example.com"]);
    expect(out.permissions.network).toEqual(["jenkins.example.com"]);
  });

  test("lowercases extra hosts", () => {
    const out = manifestWithExtraNetworkHosts("jenkins", ["JENKINS.EXAMPLE.COM"]);
    expect(out.permissions.network).toEqual(["jenkins.example.com"]);
  });

  test("does not mutate the base manifest in FIRST_PARTY_MANIFESTS", () => {
    const before = [...(FIRST_PARTY_MANIFESTS["github"]?.permissions.network ?? [])];
    manifestWithExtraNetworkHosts("github", ["mutator.example.com"]);
    const after = FIRST_PARTY_MANIFESTS["github"]?.permissions.network ?? [];
    expect(after).toEqual(before);
  });

  test("preserves filesystem permissions from the base manifest as a deep clone", () => {
    const out = manifestWithExtraNetworkHosts("obsidian", ["sync.obsidian.example.com"]);
    expect(out.permissions.filesystem.read).toEqual([]);
    expect(out.permissions.filesystem.write).toEqual([]);
    (out.permissions.filesystem.read as string[]).push("/etc");
    expect(FIRST_PARTY_MANIFESTS["obsidian"]?.permissions.filesystem.read).toEqual([]);
  });

  test("falls back through the default-deny path for unknown service ids", () => {
    const out = manifestWithExtraNetworkHosts("unknown-svc", ["host.example.com"]);
    expect(out.id).toBe("com.nimbus.unknown-svc");
    expect(out.permissions.network).toEqual(["host.example.com"]);
  });
});
