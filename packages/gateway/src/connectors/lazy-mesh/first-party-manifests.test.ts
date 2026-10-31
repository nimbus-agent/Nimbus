import { describe, expect, spyOn, test } from "bun:test";
import { validateAndNormalizePermissions } from "@nimbus-dev/registry-format";

import { isValidWildcardHost } from "../../platform/sandbox/net-wildcard-hosts.ts";
import {
  FIRST_PARTY_MANIFESTS,
  FIRST_PARTY_WILDCARD_HOSTS,
  manifestForFirstParty,
  manifestRefusals,
  manifestWithExtraNetworkHosts,
  networkEntryFromUrl,
  siteUrlWithScheme,
  storedUrlHosts,
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
    expect(m.permissions.network).toContain("caldav.icloud.com");
    // The connector's own extension manifest names these ten partitions. See the manifest note.
    expect(m.permissions.network).toContain("p01-caldav.icloud.com");
    expect(m.permissions.network).toContain("p10-caldav.icloud.com");
    expect(m.permissions.network).toHaveLength(11);
    expect(m.permissions.filesystem.read).toEqual([]);
    expect(m.permissions.filesystem.write).toEqual([]);
    // The non-443 IMAP/SMTP host:port endpoints are folded in at spawn.
    const spawned = manifestWithExtraNetworkHosts(
      "apple",
      ["imap.mail.me.com:993", "smtp.mail.me.com:587"],
      NONE,
    );
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

describe("firstPartyPolicy", () => {
  test("a known service, the default-deny fallback and a run-time merge all carry it", () => {
    expect(manifestForFirstParty("github").firstPartyPolicy).toBe(true);
    expect(manifestForFirstParty("no-such-service").firstPartyPolicy).toBe(true);
    const merged = manifestWithExtraNetworkHosts("jenkins", ["a.example.com"], {
      ownerConfigured: [],
      onDropped: () => {},
    });
    expect(merged.firstPartyPolicy).toBe(true);
    expect(manifestWithExtraNetworkHosts("jenkins", [], NONE).firstPartyPolicy).toBe(true);
  });
});

describe("firstPartyWildcardHosts", () => {
  const aws = (service: string) => [`${service}.*.amazonaws.com`, `${service}.*.amazonaws.com.cn`];

  test("the table is exactly the spec's", () => {
    expect(FIRST_PARTY_WILDCARD_HOSTS).toEqual({
      github_actions: ["*.blob.core.windows.net"],
      onedrive: ["*.sharepoint.com"],
      gcp: ["*-run.googleapis.com"],
      vertex_ai: ["*-aiplatform.googleapis.com"],
      apple: ["p*-caldav.icloud.com"],
      aws: [...aws("ecs"), ...aws("lambda"), ...aws("ec2"), ...aws("sts")],
      athena: [...aws("athena"), ...aws("sts")],
      cloudwatch: [...aws("logs"), ...aws("sts")],
      sagemaker: [...aws("api.sagemaker"), ...aws("sts")],
    });
  });

  test("every pattern is valid, and every key is a manifest key", () => {
    for (const [key, patterns] of Object.entries(FIRST_PARTY_WILDCARD_HOSTS)) {
      expect(FIRST_PARTY_MANIFESTS[key]).toBeDefined();
      for (const pattern of patterns) expect(isValidWildcardHost(pattern)).toBe(true);
    }
  });

  test("manifestForFirstParty attaches the table's entry under the underscore key", () => {
    expect(manifestForFirstParty("github_actions").firstPartyWildcardHosts).toEqual([
      "*.blob.core.windows.net",
    ]);
    expect(manifestForFirstParty("vertex_ai").firstPartyWildcardHosts).toEqual([
      "*-aiplatform.googleapis.com",
    ]);
    // The hyphenated connector name is not the manifest key, so it reaches no table entry.
    expect("firstPartyWildcardHosts" in manifestForFirstParty("github-actions")).toBe(false);
  });

  test("a run-time merge keeps it", () => {
    const merged = manifestWithExtraNetworkHosts("github_actions", ["a.example.com"], {
      ownerConfigured: [],
      onDropped: () => {},
    });
    expect(merged.firstPartyWildcardHosts).toEqual(["*.blob.core.windows.net"]);
    expect(merged.permissions.network).toContain("a.example.com");
    expect(manifestWithExtraNetworkHosts("onedrive", [], NONE).firstPartyWildcardHosts).toEqual([
      "*.sharepoint.com",
    ]);
  });

  test("a service outside the table has no such field", () => {
    expect("firstPartyWildcardHosts" in manifestForFirstParty("slack")).toBe(false);
    expect("firstPartyWildcardHosts" in manifestForFirstParty("no-such-service")).toBe(false);
  });

  test("the manifest's list is a copy, so a caller cannot edit the table", () => {
    const m = manifestForFirstParty("onedrive");
    (m.firstPartyWildcardHosts as string[]).push("*.evil.example");
    expect(manifestForFirstParty("onedrive").firstPartyWildcardHosts).toEqual(["*.sharepoint.com"]);
  });

  test("permissions.network never holds a wildcard, for any manifest", () => {
    for (const key of Object.keys(FIRST_PARTY_MANIFESTS)) {
      for (const host of manifestForFirstParty(key).permissions.network) {
        expect(host.includes("*")).toBe(false);
      }
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

  test("an IPv6 literal yields no entry (no network is granted for it)", () => {
    expect(networkEntryFromUrl("https://[::1]:8080")).toBeNull();
  });

  test("a trailing dot is the same name as without it", () => {
    expect(networkEntryFromUrl("https://jenkins.corp./")).toBe("jenkins.corp");
    expect(networkEntryFromUrl("https://jenkins.corp.:8080")).toBe("jenkins.corp:8080");
    expect(networkEntryFromUrl("http://jenkins.corp./")).toBe("jenkins.corp:80");
  });
});

describe("storedUrlHosts", () => {
  test("warns by service, never by value, when a non-empty URL yields no entry", () => {
    const warn = spyOn(manifestRefusals, "warn").mockImplementation(() => {});
    try {
      expect(storedUrlHosts("jenkins", "https://[::1]:8080")).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const fields = warn.mock.calls[0]?.[0];
      expect(fields).toEqual({ serviceId: "jenkins" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("::1");
    } finally {
      warn.mockRestore();
    }
  });

  test("an empty URL and a good URL stay silent", () => {
    const warn = spyOn(manifestRefusals, "warn").mockImplementation(() => {});
    try {
      expect(storedUrlHosts("jenkins", "")).toEqual([]);
      expect(storedUrlHosts("jenkins", "https://jenkins.corp:8080")).toEqual(["jenkins.corp:8080"]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

const NONE = { ownerConfigured: [] } as const;

describe("manifestWithExtraNetworkHosts", () => {
  test("labels only the owner-configured entries, normalised like the merged list", () => {
    const out = manifestWithExtraNetworkHosts(
      "jenkins",
      ["Jenkins.Corp:8080", "other.example.com"],
      {
        ownerConfigured: ["  JENKINS.corp:8080 "],
      },
    );
    expect(out.permissions.network).toEqual(["jenkins.corp:8080", "other.example.com"]);
    expect(out.ownerConfiguredNetwork).toEqual(["jenkins.corp:8080"]);
  });

  test("a trailing dot is dropped from the grant and from the owner label", () => {
    const out = manifestWithExtraNetworkHosts("jenkins", ["jenkins.corp.:8080"], {
      ownerConfigured: ["Jenkins.corp.:8080"],
    });
    expect(out.permissions.network).toEqual(["jenkins.corp:8080"]);
    expect(out.ownerConfiguredNetwork).toEqual(["jenkins.corp:8080"]);
    const bare = manifestWithExtraNetworkHosts("jenkins", ["jenkins.corp."], NONE);
    expect(bare.permissions.network).toEqual(["jenkins.corp"]);
  });

  test("never labels an entry that is not among the extra hosts", () => {
    const out = manifestWithExtraNetworkHosts("jenkins", ["a.example.com"], {
      ownerConfigured: ["b.example.com"],
    });
    expect(out.ownerConfiguredNetwork).toBeUndefined();
  });

  test("no label key at all when nothing is owner-configured", () => {
    expect(
      "ownerConfiguredNetwork" in manifestWithExtraNetworkHosts("jenkins", ["a.example.com"], NONE),
    ).toBe(false);
    expect("ownerConfiguredNetwork" in manifestWithExtraNetworkHosts("github", [], NONE)).toBe(
      false,
    );
  });

  test("returns the base manifest verbatim when extra is empty", () => {
    const out = manifestWithExtraNetworkHosts("github", [], NONE);
    expect(out.permissions.network).toEqual([
      "api.github.com",
      "uploads.github.com",
      "raw.githubusercontent.com",
    ]);
  });

  test("appends a new host", () => {
    const out = manifestWithExtraNetworkHosts("jenkins", ["jenkins.internal.example.com"], NONE);
    expect(out.permissions.network).toEqual(["jenkins.internal.example.com"]);
  });

  test("extends an existing connector's network list without duplicating", () => {
    const out = manifestWithExtraNetworkHosts("github", ["enterprise.github.example.com"], NONE);
    expect(out.permissions.network).toContain("api.github.com");
    expect(out.permissions.network).toContain("enterprise.github.example.com");
    expect(out.permissions.network).toHaveLength(4);
  });

  test("dedupes against existing entries", () => {
    const out = manifestWithExtraNetworkHosts(
      "github",
      ["api.github.com", "uploads.github.com"],
      NONE,
    );
    expect(out.permissions.network).toHaveLength(3);
  });

  test("dedupes case-insensitively + trims whitespace", () => {
    const out = manifestWithExtraNetworkHosts(
      "github",
      ["  API.GITHUB.COM  ", "api.github.com"],
      NONE,
    );
    expect(out.permissions.network).toHaveLength(3);
  });

  test("treats host and host:port as separate entries", () => {
    const out = manifestWithExtraNetworkHosts(
      "jenkins",
      ["jenkins.corp", "jenkins.corp:8443"],
      NONE,
    );
    expect(out.permissions.network).toEqual(["jenkins.corp", "jenkins.corp:8443"]);
  });

  test("drops empty / whitespace-only entries", () => {
    const out = manifestWithExtraNetworkHosts("jenkins", ["", "   ", "jenkins.example.com"], NONE);
    expect(out.permissions.network).toEqual(["jenkins.example.com"]);
  });

  test("lowercases extra hosts", () => {
    const out = manifestWithExtraNetworkHosts("jenkins", ["JENKINS.EXAMPLE.COM"], NONE);
    expect(out.permissions.network).toEqual(["jenkins.example.com"]);
  });

  test("does not mutate the base manifest in FIRST_PARTY_MANIFESTS", () => {
    const before = [...(FIRST_PARTY_MANIFESTS["github"]?.permissions.network ?? [])];
    manifestWithExtraNetworkHosts("github", ["mutator.example.com"], NONE);
    const after = FIRST_PARTY_MANIFESTS["github"]?.permissions.network ?? [];
    expect(after).toEqual(before);
  });

  test("preserves filesystem permissions from the base manifest as a deep clone", () => {
    const out = manifestWithExtraNetworkHosts("obsidian", ["sync.obsidian.example.com"], NONE);
    expect(out.permissions.filesystem.read).toEqual([]);
    expect(out.permissions.filesystem.write).toEqual([]);
    out.permissions.filesystem.read.push("/etc");
    expect(FIRST_PARTY_MANIFESTS["obsidian"]?.permissions.filesystem.read).toEqual([]);
  });

  test("falls back through the default-deny path for unknown service ids", () => {
    const out = manifestWithExtraNetworkHosts("unknown-svc", ["host.example.com"], NONE);
    expect(out.id).toBe("com.nimbus.unknown-svc");
    expect(out.permissions.network).toEqual(["host.example.com"]);
  });
});

describe("siteUrlWithScheme", () => {
  test("a schemeless Atlassian site gets the https the connector will use", () => {
    expect(networkEntryFromUrl(siteUrlWithScheme("acme.atlassian.net"))).toBe("acme.atlassian.net");
    expect(networkEntryFromUrl(siteUrlWithScheme(" acme.atlassian.net/wiki "))).toBe(
      "acme.atlassian.net",
    );
  });

  test("a url with a scheme is kept, port and all", () => {
    expect(siteUrlWithScheme("http://jira.corp:8080")).toBe("http://jira.corp:8080");
    expect(networkEntryFromUrl(siteUrlWithScheme("http://jira.corp:8080"))).toBe("jira.corp:8080");
  });
});

describe("manifestWithExtraNetworkHosts drops an entry that is not a valid network entry", () => {
  const BAD = [
    'a"b.com',
    'a"b.com:443',
    'x")) (allow network*) (host "y',
    "a\nb.com",
    "a b.com",
    "a.com:notaport",
    "a.com:70000",
    "a.com:",
  ];

  for (const entry of BAD) {
    test(`${JSON.stringify(entry)} reaches neither the list nor the label`, () => {
      const out = manifestWithExtraNetworkHosts("jenkins", [entry, "ok.example.com"], {
        ownerConfigured: [entry, "ok.example.com"],
        onDropped: () => {},
      });
      expect(out.permissions.network).toEqual(["ok.example.com"]);
      expect(out.ownerConfiguredNetwork).toEqual(["ok.example.com"]);
    });
  }

  test("valid host, host:port and a loopback address survive, labelled", () => {
    const valid = ["jenkins.corp", "jenkins.corp:8443", "127.0.0.1:1143", "jenkins:8080"];
    const out = manifestWithExtraNetworkHosts("jenkins", valid, { ownerConfigured: valid });
    expect(out.permissions.network).toEqual(valid);
    expect(out.ownerConfiguredNetwork).toEqual(valid);
  });

  test("a connector whose only entry is dropped has no network and no label", () => {
    const out = manifestWithExtraNetworkHosts("jenkins", ['a"b.com'], {
      ownerConfigured: ['a"b.com'],
      onDropped: () => {},
    });
    expect(out.permissions.network).toEqual([]);
    expect("ownerConfiguredNetwork" in out).toBe(false);
  });

  test("the fixed list is kept when an extra is dropped", () => {
    const out = manifestWithExtraNetworkHosts("github", ['a"b.com'], {
      ownerConfigured: [],
      onDropped: () => {},
    });
    expect(out.permissions.network).toEqual(manifestForFirstParty("github").permissions.network);
  });

  test("the drop is reported by service and count, never by value", () => {
    const seen: unknown[] = [];
    manifestWithExtraNetworkHosts("jenkins", ['secret"value.com', "a b", "ok.example.com"], {
      ownerConfigured: [],
      onDropped: (fields) => seen.push(fields),
    });
    expect(seen).toEqual([{ serviceId: "jenkins", dropped: 2 }]);
    expect(JSON.stringify(seen)).not.toContain("secret");
  });

  test("nothing is reported when nothing is dropped, blanks included", () => {
    const seen: unknown[] = [];
    manifestWithExtraNetworkHosts("jenkins", ["", "   ", "ok.example.com"], {
      ownerConfigured: [],
      onDropped: (fields) => seen.push(fields),
    });
    expect(seen).toEqual([]);
  });

  test("a stored URL carrying a quote cannot pass through networkEntryFromUrl and in", () => {
    const entry = networkEntryFromUrl('https://a"b.com');
    expect(entry).not.toBeNull();
    const out = manifestWithExtraNetworkHosts("jenkins", [entry ?? ""], {
      ownerConfigured: [entry ?? ""],
      onDropped: () => {},
    });
    expect(out.permissions.network).toEqual([]);
  });
});

describe("manifestWithExtraNetworkHosts keeps an underscore in a run-time hostname", () => {
  test("my_jenkins:8080 and my_jenkins.local survive into the list and the label", () => {
    const hosts = ["my_jenkins:8080", "my_jenkins.local"];
    const out = manifestWithExtraNetworkHosts("jenkins", hosts, { ownerConfigured: hosts });
    expect(out.permissions.network).toEqual(hosts);
    expect(out.ownerConfiguredNetwork).toEqual(hosts);
  });

  test("a stored URL with an underscore host reaches the list", () => {
    const entry = networkEntryFromUrl("http://my_jenkins:8080");
    expect(entry).toBe("my_jenkins:8080");
    const out = manifestWithExtraNetworkHosts("jenkins", [entry ?? ""], NONE);
    expect(out.permissions.network).toEqual(["my_jenkins:8080"]);
  });

  for (const bad of [
    'my_"jenkins',
    'my_jenkins":8080',
    "my_ jenkins",
    "my_\tjenkins",
    "my_\njenkins",
    "my_\u0001jenkins",
    "my_(jenkins)",
    "my_;jenkins",
    "my_\\jenkins",
    "my_jenkins:80_80",
  ]) {
    test(`${JSON.stringify(bad)} is still dropped from the list and the label`, () => {
      const out = manifestWithExtraNetworkHosts("jenkins", [bad], {
        ownerConfigured: [bad],
        onDropped: () => {},
      });
      expect(out.permissions.network).toEqual([]);
      expect("ownerConfiguredNetwork" in out).toBe(false);
    });
  }

  test("the shared manifest rule still refuses an underscore", () => {
    expect(() => validateAndNormalizePermissions({ network: ["my_jenkins"] })).toThrow();
  });
});

describe("the log line for a dropped entry", () => {
  test("is at warn level, names the service, and carries no value", () => {
    const moduleUrl = new URL("./first-party-manifests.ts", import.meta.url).href;
    const script = `const { manifestWithExtraNetworkHosts: m } = await import(${JSON.stringify(moduleUrl)});
m("jenkins", ['secret"value.com'], { ownerConfigured: [] });`;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, NIMBUS_LOG_LEVEL: "warn" },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const stderr = child.stderr.toString();
    const line = JSON.parse(stderr.trim()) as Record<string, unknown>;
    expect(line["level"]).toBe(40);
    expect(line["serviceId"]).toBe("jenkins");
    expect(line["msg"]).toBe("ignored a stored host that is not a valid hostname");
    expect(stderr).not.toContain("secret");
    expect(child.stdout.toString()).toBe("");
  });
});
