const STEP_HITL_RULES: ReadonlyArray<{ pattern: RegExp; actions: readonly string[] }> = [
  { pattern: /\bterraform\s+apply\b/i, actions: ["iac.terraform.apply"] },
  { pattern: /\bterraform\s+destroy\b/i, actions: ["iac.terraform.destroy"] },
  { pattern: /\bpulumi\s+up\b/i, actions: ["iac.pulumi.up"] },
  {
    pattern: /\bcloudformation\b.*\bdeploy\b|\bdeploy\b.*\bcloudformation\b/i,
    actions: ["iac.cloudformation.deploy"],
  },
  {
    pattern: /\bsend\b.*\b(e-?mail|message)\b|\b(e-?mail|email)\b.*\bsend\b/i,
    actions: ["email.send"],
  },
  { pattern: /\bdelete\b.*\bfile|\bremove\b.*\bfile/i, actions: ["file.delete"] },
  { pattern: /\bmove\b.*\bfile|\brename\b.*\bfile/i, actions: ["file.move", "file.rename"] },
  { pattern: /\b(create|write)\b.*\bfile\b/i, actions: ["file.create"] },
  {
    pattern: /\bslack\b.*\b(post|send|message)\b|\bpost\b.*\bslack\b/i,
    actions: ["slack.message.post"],
  },
  {
    pattern: /\bteams\b.*\b(post|send|message)\b/i,
    actions: ["teams.message.post", "teams.message.postChat"],
  },
  {
    pattern: /\bjenkins\b.*\b(build|trigger)\b|\btrigger\b.*\bjenkins\b/i,
    actions: ["jenkins.build.trigger"],
  },
  { pattern: /\babort\b.*\bjenkins\b|\bjenkins\b.*\babort\b/i, actions: ["jenkins.build.abort"] },
  {
    pattern: /\bgithub\s*actions\b.*\b(run|trigger|workflow)\b|\bworkflow\s+run\b.*\btrigger\b/i,
    actions: ["github_actions.run.trigger"],
  },
  {
    pattern: /\bcancel\b.*\b(workflow|github\s*actions)\b/i,
    actions: ["github_actions.run.cancel"],
  },
  {
    pattern: /\bcircleci\b.*\b(trigger|pipeline|run)\b|\btrigger\b.*\bcircleci\b/i,
    actions: ["circleci.pipeline.trigger"],
  },
  {
    pattern: /\bcircleci\b.*\bcancel\b|\bcancel\b.*\bcircleci\b/i,
    actions: ["circleci.job.cancel"],
  },
  {
    pattern: /\bgitlab\b.*\b(retry|cancel)\s+pipeline\b|\bpipeline\b.*\b(retry|cancel)\b/i,
    actions: ["gitlab.pipeline.retry", "gitlab.pipeline.cancel"],
  },
  {
    pattern: /\becs\b.*\b(update|deploy)\b|\bupdate\b.*\becs\s+service\b/i,
    actions: ["aws.ecs.service.update"],
  },
  { pattern: /\binvoke\b.*\blambda\b|\blambda\b.*\binvoke\b/i, actions: ["aws.lambda.invoke"] },
  {
    pattern: /\b(stop|start)\b.*\bec2\b|\bec2\b.*\binstance\b.*\b(stop|start)\b/i,
    actions: ["aws.ec2.instance.stop", "aws.ec2.instance.start"],
  },
  {
    pattern: /\brestart\b.*\bapp\s*service\b|\bazure\b.*\brestart\b/i,
    actions: ["azure.app_service.restart"],
  },
  {
    pattern: /\baks\b.*\bscale\b|\bscale\b.*\bnode\s+pool\b/i,
    actions: ["azure.aks.node_pool.scale"],
  },
  {
    pattern: /\bcloud\s*run\b.*\bdeploy\b|\bdeploy\b.*\bcloud\s*run\b/i,
    actions: ["gcp.cloud_run.deploy"],
  },
  { pattern: /\bgke\b.*\brestart\b|\brestart\b.*\bgke\b/i, actions: ["gcp.gke.workload.restart"] },
  {
    pattern: /\bkubectl\b.*\brollout\s+restart\b|\brollout\s+restart\b/i,
    actions: ["kubernetes.rollout.restart"],
  },
  { pattern: /\bdelete\b.*\bpod\b|\bpod\b.*\bdelete\b/i, actions: ["kubernetes.pod.delete"] },
  {
    pattern: /\bscale\b.*\bdeployment\b|\bdeployment\b.*\bscale\b/i,
    actions: ["kubernetes.deployment.scale"],
  },
  { pattern: /\bpagerduty\b.*\b(ack|acknowledge)\b/i, actions: ["pagerduty.incident.acknowledge"] },
  {
    pattern: /\bpagerduty\b.*\bresolve\b|\bresolve\b.*\bincident\b/i,
    actions: ["pagerduty.incident.resolve"],
  },
  { pattern: /\bpagerduty\b.*\bescalate\b/i, actions: ["pagerduty.incident.escalate"] },
  { pattern: /\bmerge\b.*\b(pull\s+request|pr)\b/i, actions: ["repo.pr.merge"] },
  {
    pattern: /\blinear\b.*\b(create|update)\b.*\bissue\b|\bcreate\b.*\blinear\b.*\bissue\b/i,
    actions: ["linear.issue.create", "linear.issue.update"],
  },
  {
    pattern: /\bjira\b.*\b(create|update)\b.*\bissue\b/i,
    actions: ["jira.issue.create", "jira.issue.update"],
  },
  {
    pattern: /\bnotion\b.*\b(create|update)\b.*\bpage\b/i,
    actions: ["notion.page.create", "notion.page.update"],
  },
];

export function previewHitlActionsForStepText(runText: string): string[] {
  const t = runText.trim();
  if (t === "") {
    return [];
  }
  const out = new Set<string>();
  for (const rule of STEP_HITL_RULES) {
    if (rule.pattern.test(t)) {
      for (const a of rule.actions) {
        out.add(a);
      }
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}
