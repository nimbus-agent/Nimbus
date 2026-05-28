export const JENKINS_JOBS_API_TREE =
  "jobs[name,fullname,url,jobs[name,fullname,url,jobs[name,fullname,url,jobs[name,fullname,url]]]]";

export type JenkinsApiJobNode = {
  name?: string;
  fullName?: string;
  url?: string;
  jobs?: JenkinsApiJobNode[];
};

export function jenkinsApiJobNodeDisplayName(n: JenkinsApiJobNode): string {
  if (typeof n.fullName === "string" && n.fullName !== "") {
    return n.fullName;
  }
  if (typeof n.name === "string") {
    return n.name;
  }
  return "";
}

export function flattenJenkinsApiJobs(
  nodes: JenkinsApiJobNode[] | undefined,
  out: { fullName: string; url?: string }[],
): void {
  if (nodes === undefined) {
    return;
  }
  for (const n of nodes) {
    const fn = jenkinsApiJobNodeDisplayName(n);
    if (fn !== "") {
      if (typeof n.url === "string") {
        out.push({ fullName: fn, url: n.url });
      } else {
        out.push({ fullName: fn });
      }
    }
    flattenJenkinsApiJobs(n.jobs, out);
  }
}
