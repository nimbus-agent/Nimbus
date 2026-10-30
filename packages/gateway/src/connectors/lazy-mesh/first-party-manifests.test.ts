import { describe, expect, test } from "bun:test";

import {
  FIRST_PARTY_MANIFESTS,
  manifestForFirstParty,
  manifestWithExtraNetworkHosts,
  networkEntryFromUrl,
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

  test("powerbi manifest declares static hosts login.microsoftonline.com + api.powerbi.com", () => {
    const m = manifestForFirstParty("powerbi");
    expect(m.id).toBe("com.nimbus.powerbi");
    expect(m.permissions.network).toContain("login.microsoftonline.com");
    expect(m.permissions.network).toContain("api.powerbi.com");
    expect(m.permissions.filesystem.read).toEqual([]);
    expect(m.permissions.filesystem.write).toEqual([]);
  });

  test("apple manifest declares the static caldav.icloud.com host (imap/smtp host:port added at spawn)", () => {
    const m = manifestForFirstParty("apple");
    expect(m.id).toBe("com.nimbus.apple");
    expect(m.permissions.network).toEqual(["caldav.icloud.com"]);
    expect(m.permissions.filesystem.read).toEqual([]);
    expect(m.permissions.filesystem.write).toEqual([]);
    // The non-443 IMAP/SMTP host:port endpoints are folded in at spawn.
    const spawned = manifestWithExtraNetworkHosts("apple", [
      "imap.mail.me.com:993",
      "smtp.mail.me.com:587",
    ]);
    expect(spawned.permissions.network).toContain("caldav.icloud.com");
    expect(spawned.permissions.network).toContain("imap.mail.me.com:993");
    expect(spawned.permissions.network).toContain("smtp.mail.me.com:587");
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
      "google_meet",
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
      "codemagic",
      "testflight",
      "firebase",
      "sonarqube",
      "semgrep",
      "wiz",
      "launchdarkly",
      "flagsmith",
      "argocd",
      "flux",
      "dbt",
      "metabase",
      "snowflake",
      "tableau",
      "looker",
      "superset",
      "databricks",
      "mlflow",
      "vercel",
      "netlify",
      "stripe",
      "mercury",
      "raindrop",
      "intercom",
      "zendesk",
      "lever",
      "greenhouse",
      "pipedrive",
      "stackoverflow",
      "zotero",
      "mendeley",
      "dependencytrack",
      "airflow",
      "prefect",
      "dagster",
      "ramp",
      "zoom",
      "hubspot",
      "miro",
      "canva",
      "figma",
      "powerbi",
      "montecarlo",
      "bigeye",
    ];
    for (const id of expected) {
      expect(FIRST_PARTY_MANIFESTS[id]).toBeDefined();
    }
  });
});

describe("networkEntryFromUrl", () => {
  test("a bare host when the port is the https default", () => {
    expect(networkEntryFromUrl("https://jenkins.corp")).toBe("jenkins.corp");
    expect(networkEntryFromUrl("https://api.github.com/repos")).toBe("api.github.com");
    expect(networkEntryFromUrl("https://jenkins.corp:443/x")).toBe("jenkins.corp");
  });

  test("keeps a non-443 port", () => {
    expect(networkEntryFromUrl("https://jenkins.corp:8443/x")).toBe("jenkins.corp:8443");
    expect(networkEntryFromUrl("http://jenkins:8080")).toBe("jenkins:8080");
    expect(networkEntryFromUrl("https://grafana.example.com:3000/d/abc")).toBe(
      "grafana.example.com:3000",
    );
    expect(networkEntryFromUrl("http://localhost:9090/api")).toBe("localhost:9090");
  });

  test("plain http with no port is port 80, not a bare host", () => {
    expect(networkEntryFromUrl("http://jenkins")).toBe("jenkins:80");
    expect(networkEntryFromUrl("http://jenkins:80")).toBe("jenkins:80");
  });

  test("lowercases the host and trims whitespace", () => {
    expect(networkEntryFromUrl("https://JENKINS.corp")).toBe("jenkins.corp");
    expect(networkEntryFromUrl("  https://api.github.com  ")).toBe("api.github.com");
  });

  test("returns null for an unparseable URL or an empty host", () => {
    expect(networkEntryFromUrl("not a url")).toBeNull();
    expect(networkEntryFromUrl("")).toBeNull();
    expect(networkEntryFromUrl("http://")).toBeNull();
    expect(networkEntryFromUrl("file:///etc/passwd")).toBeNull();
  });

  test("IPv6 literals stay refused", () => {
    expect(networkEntryFromUrl("https://[::1]:8080")).toBeNull();
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
    expect(out.permissions.network).toHaveLength(4);
  });

  test("dedupes against existing entries", () => {
    const out = manifestWithExtraNetworkHosts("github", ["api.github.com", "uploads.github.com"]);
    expect(out.permissions.network).toHaveLength(3);
  });

  test("dedupes case-insensitively + trims whitespace", () => {
    const out = manifestWithExtraNetworkHosts("github", ["  API.GITHUB.COM  ", "api.github.com"]);
    expect(out.permissions.network).toHaveLength(3);
  });

  test("treats host and host:port as separate entries", () => {
    const out = manifestWithExtraNetworkHosts("jenkins", ["jenkins.corp", "jenkins.corp:8443"]);
    expect(out.permissions.network).toEqual(["jenkins.corp", "jenkins.corp:8443"]);
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
    out.permissions.filesystem.read.push("/etc");
    expect(FIRST_PARTY_MANIFESTS["obsidian"]?.permissions.filesystem.read).toEqual([]);
  });

  test("falls back through the default-deny path for unknown service ids", () => {
    const out = manifestWithExtraNetworkHosts("unknown-svc", ["host.example.com"]);
    expect(out.id).toBe("com.nimbus.unknown-svc");
    expect(out.permissions.network).toEqual(["host.example.com"]);
  });
});
