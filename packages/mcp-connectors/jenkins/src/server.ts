import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import {
  getJenkinsCrumb,
  jenkinsAuthHeader,
  jenkinsBaseUrl,
  jenkinsFetchJson,
  jenkinsPost,
  jobApiRoot,
} from "./jenkins-api.ts";

const mcp = new McpServer({ name: "nimbus-jenkins", version: "0.1.0" });

import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

/**
 * Every MUTATING jenkins tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(mcp, {
  connector: "jenkins",
  scopeEnv: "NIMBUS_MCP_JENKINS_WRITE_SCOPE",
  scopeKinds: ["job"],
});

const JOBS_TREE =
  "jobs[name,fullname,url,jobs[name,fullname,url,jobs[name,fullname,url,jobs[name,fullname,url]]]]";

type JobNode = {
  name?: string;
  fullName?: string;
  url?: string;
  jobs?: JobNode[];
};

function jenkinsJobNodeDisplayName(n: JobNode): string {
  if (typeof n.fullName === "string" && n.fullName !== "") {
    return n.fullName;
  }
  if (typeof n.name === "string") {
    return n.name;
  }
  return "";
}

function flattenJobs(
  nodes: JobNode[] | undefined,
  out: { fullName: string; url?: string }[],
): void {
  if (nodes === undefined) {
    return;
  }
  for (const n of nodes) {
    const fn = jenkinsJobNodeDisplayName(n);
    if (fn !== "") {
      if (typeof n.url === "string") {
        out.push({ fullName: fn, url: n.url });
      } else {
        out.push({ fullName: fn });
      }
    }
    flattenJobs(n.jobs, out);
  }
}

reg(
  "jenkins_job_list",
  "List Jenkins jobs (nested folders, limited depth).",
  z.object({}),
  async () => {
    const base = jenkinsBaseUrl();
    const url = `${base}/api/json?tree=${encodeURIComponent(JOBS_TREE)}`;
    const root = await jenkinsGetJsonExpectOk(url);
    if (root === null || typeof root !== "object" || Array.isArray(root)) {
      throw new Error("Jenkins: invalid jobs response");
    }
    const jobsRaw = (root as Record<string, unknown>)["jobs"];
    const list: { fullName: string; url?: string }[] = [];
    flattenJobs(Array.isArray(jobsRaw) ? (jobsRaw as JobNode[]) : undefined, list);
    return jsonResult({ jobs: list });
  },
);

async function jenkinsGetJsonExpectOk(url: string): Promise<unknown> {
  const auth = jenkinsAuthHeader();
  const res = await jenkinsFetchJson(url, { method: "GET", authHeader: auth });
  if (!res.ok) {
    throw new Error(`Jenkins ${String(res.status)}: ${res.text.slice(0, 400)}`);
  }
  return res.json;
}

const jobNameSchema = z.object({
  jobName: z.string().min(1).describe("Job full name (e.g. folder/sub/job)"),
});

reg("jenkins_job_get", "Get Jenkins job metadata by full name.", jobNameSchema, async (parsed) => {
  const base = jenkinsBaseUrl();
  const root = jobApiRoot(base, parsed.jobName);
  const url = `${root}/api/json`;
  return jsonResult(await jenkinsGetJsonExpectOk(url));
});

reg(
  "jenkins_build_list",
  "List recent builds for a job.",
  z.object({
    jobName: z.string().min(1),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async (parsed) => {
    const base = jenkinsBaseUrl();
    const lim = parsed.limit ?? 20;
    const tree = encodeURIComponent(
      `builds[number,url,result,duration,timestamp,building]{0,${String(lim)}}`,
    );
    const url = `${jobApiRoot(base, parsed.jobName)}/api/json?tree=${tree}`;
    return jsonResult(await jenkinsGetJsonExpectOk(url));
  },
);

reg(
  "jenkins_build_get",
  "Get a single build by job name and build number.",
  z.object({
    jobName: z.string().min(1),
    buildNumber: z.number().int().min(1),
  }),
  async (parsed) => {
    const base = jenkinsBaseUrl();
    const url = `${jobApiRoot(base, parsed.jobName)}/${String(parsed.buildNumber)}/api/json`;
    return jsonResult(await jenkinsGetJsonExpectOk(url));
  },
);

registerWriteTool(
  "jenkins_build_trigger",
  {
    mutates: "jenkins.build.trigger",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "job", value: p.jobName }),
  },
  "Trigger a new build for a job.",
  jobNameSchema,
  async (parsed) => {
    const base = jenkinsBaseUrl();
    const auth = jenkinsAuthHeader();
    const crumb = await getJenkinsCrumb(base, auth);
    const url = `${jobApiRoot(base, parsed.jobName)}/build`;
    const res = await jenkinsPost(url, auth, crumb);
    if (!res.ok) {
      throw new Error(`Jenkins trigger ${String(res.status)}: ${res.text.slice(0, 400)}`);
    }
    return jsonResult({ ok: true, jobName: parsed.jobName });
  },
);

registerWriteTool(
  "jenkins_build_abort",
  {
    mutates: "jenkins.build.abort",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "job", value: p.jobName }),
  },
  "Abort/stop a running build.",
  z.object({
    jobName: z.string().min(1),
    buildNumber: z.number().int().min(1),
  }),
  async (parsed) => {
    const base = jenkinsBaseUrl();
    const auth = jenkinsAuthHeader();
    const crumb = await getJenkinsCrumb(base, auth);
    const url = `${jobApiRoot(base, parsed.jobName)}/${String(parsed.buildNumber)}/stop`;
    const res = await jenkinsPost(url, auth, crumb);
    if (!res.ok) {
      throw new Error(`Jenkins abort ${String(res.status)}: ${res.text.slice(0, 400)}`);
    }
    return jsonResult({ ok: true, jobName: parsed.jobName, buildNumber: parsed.buildNumber });
  },
);

reg(
  "jenkins_build_log_tail",
  "Fetch console text for a build (full log; tail client-side).",
  z.object({
    jobName: z.string().min(1),
    buildNumber: z.number().int().min(1),
    maxLines: z.number().int().min(1).max(5000).optional(),
  }),
  async (parsed) => {
    const base = jenkinsBaseUrl();
    const auth = jenkinsAuthHeader();
    const url = `${jobApiRoot(base, parsed.jobName)}/${String(parsed.buildNumber)}/consoleText`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Jenkins log ${String(res.status)}: ${text.slice(0, 400)}`);
    }
    const maxLines = parsed.maxLines ?? 200;
    const lines = text.split(/\r?\n/);
    const tail = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
    return jsonResult({
      jobName: parsed.jobName,
      buildNumber: parsed.buildNumber,
      lineCount: lines.length,
      tail,
    });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
