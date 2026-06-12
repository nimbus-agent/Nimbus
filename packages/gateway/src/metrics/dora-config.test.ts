import { describe, expect, it } from "bun:test";
import {
  DEFAULT_DEPLOY_ENVIRONMENTS,
  DEFAULT_DEPLOY_WORKFLOW_PATTERN,
  DEFAULT_EXCLUDE_PR_LABELS,
  DEFAULT_INCIDENT_WINDOW_MINUTES,
  isValidDeployEnvironmentName,
  parseDoraRepoUrn,
  providerServiceColumns,
} from "./dora-config.ts";

// ---------------------------------------------------------------------------
// parseDoraRepoUrn
// ---------------------------------------------------------------------------

describe("parseDoraRepoUrn", () => {
  describe("happy-path: valid URNs", () => {
    it("parses a github URN", () => {
      const result = parseDoraRepoUrn("github:acme/api");
      expect(result.provider).toBe("github");
      expect(result.providerId).toBe("acme/api");
    });

    it("parses a gitlab URN", () => {
      const result = parseDoraRepoUrn("gitlab:group/project");
      expect(result.provider).toBe("gitlab");
      expect(result.providerId).toBe("group/project");
    });

    it("parses a bitbucket URN", () => {
      const result = parseDoraRepoUrn("bitbucket:workspace/repo");
      expect(result.provider).toBe("bitbucket");
      expect(result.providerId).toBe("workspace/repo");
    });

    it("parses a jenkins URN", () => {
      const result = parseDoraRepoUrn("jenkins:my-pipeline");
      expect(result.provider).toBe("jenkins");
      expect(result.providerId).toBe("my-pipeline");
    });

    it("parses a circleci URN", () => {
      const result = parseDoraRepoUrn("circleci:gh/acme/api");
      expect(result.provider).toBe("circleci");
      expect(result.providerId).toBe("gh/acme/api");
    });

    it("preserves a provider-id that itself contains colons", () => {
      // slice(colon+1) includes everything after the first colon
      const result = parseDoraRepoUrn("github:org:repo");
      expect(result.provider).toBe("github");
      expect(result.providerId).toBe("org:repo");
    });
  });

  describe("error: missing or misplaced colon separator", () => {
    it("throws when there is no colon at all", () => {
      expect(() => parseDoraRepoUrn("github")).toThrow("missing 'provider:id' separator");
    });

    it("throws when the colon is the first character (colon === 0)", () => {
      // indexOf(':') === 0, so colon <= 0 is true
      expect(() => parseDoraRepoUrn(":someid")).toThrow("missing 'provider:id' separator");
    });
  });

  describe("error: unknown provider", () => {
    it("throws for a completely unknown provider", () => {
      expect(() => parseDoraRepoUrn("travisci:repo")).toThrow("unknown provider 'travisci'");
    });

    it("error message lists all known providers", () => {
      let message = "";
      try {
        parseDoraRepoUrn("travisci:repo");
      } catch (e) {
        if (e instanceof Error) message = e.message;
      }
      expect(message).toContain("github");
      expect(message).toContain("gitlab");
      expect(message).toContain("bitbucket");
      expect(message).toContain("jenkins");
      expect(message).toContain("circleci");
    });
  });

  describe("error: empty provider-specific id", () => {
    it("throws when the part after the colon is empty", () => {
      expect(() => parseDoraRepoUrn("github:")).toThrow("empty provider-specific id");
    });
  });
});

// ---------------------------------------------------------------------------
// isValidDeployEnvironmentName
// ---------------------------------------------------------------------------

describe("isValidDeployEnvironmentName", () => {
  it("accepts a simple lowercase word", () => {
    expect(isValidDeployEnvironmentName("prod")).toBe(true);
  });

  it("accepts names that start with a digit", () => {
    expect(isValidDeployEnvironmentName("0staging")).toBe(true);
  });

  it("accepts names with dots, dashes, and underscores after first char", () => {
    expect(isValidDeployEnvironmentName("prod.us-east_1")).toBe(true);
  });

  it("accepts a name that is a single lowercase letter", () => {
    expect(isValidDeployEnvironmentName("a")).toBe(true);
  });

  it("accepts a name that is a single digit", () => {
    expect(isValidDeployEnvironmentName("9")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidDeployEnvironmentName("")).toBe(false);
  });

  it("rejects names starting with a hyphen", () => {
    expect(isValidDeployEnvironmentName("-prod")).toBe(false);
  });

  it("rejects names starting with a dot", () => {
    expect(isValidDeployEnvironmentName(".prod")).toBe(false);
  });

  it("rejects names starting with an underscore", () => {
    expect(isValidDeployEnvironmentName("_prod")).toBe(false);
  });

  it("rejects names with uppercase letters", () => {
    expect(isValidDeployEnvironmentName("Prod")).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(isValidDeployEnvironmentName("prod env")).toBe(false);
  });

  it("rejects names with special characters", () => {
    expect(isValidDeployEnvironmentName("prod!")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// providerServiceColumns
// ---------------------------------------------------------------------------

describe("providerServiceColumns", () => {
  it("returns github PR and CI services for github", () => {
    const result = providerServiceColumns("github");
    expect(result.prServices).toEqual(["github"]);
    expect(result.ciServices).toEqual(["github_actions"]);
  });

  it("returns gitlab PR and CI services for gitlab", () => {
    const result = providerServiceColumns("gitlab");
    expect(result.prServices).toEqual(["gitlab"]);
    expect(result.ciServices).toEqual(["gitlab"]);
  });

  it("returns bitbucket PR and CI services for bitbucket", () => {
    const result = providerServiceColumns("bitbucket");
    expect(result.prServices).toEqual(["bitbucket"]);
    expect(result.ciServices).toEqual(["bitbucket"]);
  });

  it("returns empty prServices and jenkins ciServices for jenkins", () => {
    const result = providerServiceColumns("jenkins");
    expect(result.prServices).toEqual([]);
    expect(result.ciServices).toEqual(["jenkins"]);
  });

  it("returns empty prServices and circleci ciServices for circleci", () => {
    const result = providerServiceColumns("circleci");
    expect(result.prServices).toEqual([]);
    expect(result.ciServices).toEqual(["circleci"]);
  });
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  it("DEFAULT_DEPLOY_WORKFLOW_PATTERN is the expected pattern string", () => {
    expect(DEFAULT_DEPLOY_WORKFLOW_PATTERN).toBe("^[Dd]eploy");
  });

  it("DEFAULT_INCIDENT_WINDOW_MINUTES is 60", () => {
    expect(DEFAULT_INCIDENT_WINDOW_MINUTES).toBe(60);
  });

  it("DEFAULT_EXCLUDE_PR_LABELS contains 'revert'", () => {
    expect(DEFAULT_EXCLUDE_PR_LABELS).toContain("revert");
  });

  it("DEFAULT_DEPLOY_ENVIRONMENTS contains 'prod'", () => {
    expect(DEFAULT_DEPLOY_ENVIRONMENTS).toContain("prod");
  });
});
