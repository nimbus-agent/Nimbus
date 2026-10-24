// What each built-in connector IS, in words a person choosing one can read: a product name, a
// category, and one sentence about the SERVICE (never about what Nimbus indexes from it).
//
// Presentation only, like `agent-catalog.ts` beside it. The record is keyed by the same id unions
// the connector catalog and the gateway-side syncables use, so a connector added to either fails
// the build until it is described here.

import type { ConnectorServiceId } from "../connectors/connector-catalog.ts";
import type { GatewaySyncableServiceId } from "../connectors/gateway-syncable-ids.ts";

export type ConnectorCategory =
  | "storage"
  | "email"
  | "calendar"
  | "chat"
  | "meetings"
  | "code"
  | "ci-cd"
  | "issues"
  | "docs"
  | "cloud"
  | "observability"
  | "security"
  | "feature-flags"
  | "gitops"
  | "data"
  | "ml"
  | "deploy"
  | "finance"
  | "support"
  | "sales"
  | "design"
  | "hr"
  | "reading"
  | "research"
  | "local";

export type ConnectorMeta = {
  readonly displayName: string;
  readonly category: ConnectorCategory;
  readonly description: string;
};

function m(displayName: string, category: ConnectorCategory, description: string): ConnectorMeta {
  return Object.freeze({ displayName, category, description });
}

export const CONNECTOR_CATALOG_META = Object.freeze({
  google_drive: m("Google Drive", "storage", "Google's cloud file storage and document service"),
  gmail: m("Gmail", "email", "Google's email service"),
  google_photos: m("Google Photos", "storage", "Google's photo and video storage service"),
  google_meet: m("Google Meet", "meetings", "Google's video meeting service"),
  onedrive: m("OneDrive", "storage", "Microsoft's cloud file storage service"),
  outlook: m("Outlook", "email", "Microsoft's email and calendar service"),
  teams: m("Microsoft Teams", "chat", "Microsoft's team chat and meeting service"),
  slack: m("Slack", "chat", "A team chat and messaging platform"),
  github: m("GitHub", "code", "A code hosting and collaboration platform built on Git"),
  github_actions: m(
    "GitHub Actions",
    "ci-cd",
    "GitHub's built-in workflow automation and CI service",
  ),
  gitlab: m("GitLab", "code", "A code hosting and DevOps platform built on Git"),
  bitbucket: m("Bitbucket", "code", "Atlassian's Git code hosting service"),
  linear: m("Linear", "issues", "An issue and project tracker for software teams"),
  jira: m("Jira", "issues", "Atlassian's issue and project tracker"),
  notion: m("Notion", "docs", "A workspace for notes, documents and databases"),
  confluence: m("Confluence", "docs", "Atlassian's team wiki and documentation tool"),
  discord: m("Discord", "chat", "A chat platform for communities and teams"),
  jenkins: m("Jenkins", "ci-cd", "An open-source automation server for builds and pipelines"),
  circleci: m("CircleCI", "ci-cd", "A hosted continuous integration and delivery service"),
  pagerduty: m("PagerDuty", "observability", "An incident response and on-call alerting service"),
  kubernetes: m("Kubernetes", "cloud", "An open-source system for running containerised workloads"),
  aws: m("AWS", "cloud", "Amazon's cloud computing platform"),
  azure: m("Microsoft Azure", "cloud", "Microsoft's cloud computing platform"),
  gcp: m("Google Cloud", "cloud", "Google's cloud computing platform"),
  iac: m(
    "Infrastructure as Code",
    "cloud",
    "Terraform and similar tools that define infrastructure in files",
  ),
  grafana: m(
    "Grafana",
    "observability",
    "A dashboard and monitoring platform for metrics and logs",
  ),
  sentry: m("Sentry", "observability", "An application error and performance monitoring service"),
  newrelic: m("New Relic", "observability", "An application performance monitoring platform"),
  datadog: m("Datadog", "observability", "A monitoring and analytics platform for cloud systems"),
  snyk: m("Snyk", "security", "A scanner for vulnerabilities in code and dependencies"),
  bitrise: m("Bitrise", "ci-cd", "A CI/CD service for mobile apps"),
  codemagic: m("Codemagic", "ci-cd", "A CI/CD service for mobile apps"),
  testflight: m("TestFlight", "deploy", "Apple's beta testing service for iOS and macOS apps"),
  firebase: m("Firebase", "deploy", "Google's app development and hosting platform"),
  sonarqube: m("SonarQube", "security", "A code quality and security analysis tool"),
  semgrep: m("Semgrep", "security", "A static analysis tool that finds bugs and security issues"),
  wiz: m("Wiz", "security", "A cloud security platform that finds risks across cloud accounts"),
  launchdarkly: m("LaunchDarkly", "feature-flags", "A feature flag and rollout management service"),
  flagsmith: m(
    "Flagsmith",
    "feature-flags",
    "An open-source feature flag and remote config service",
  ),
  argocd: m("Argo CD", "gitops", "A GitOps continuous delivery tool for Kubernetes"),
  flux: m("Flux", "gitops", "A GitOps toolkit that syncs Kubernetes clusters from Git"),
  dbt: m("dbt", "data", "A tool for transforming data in a warehouse with SQL models"),
  metabase: m("Metabase", "data", "An open-source business intelligence and dashboard tool"),
  superset: m("Apache Superset", "data", "An open-source data exploration and dashboard platform"),
  databricks: m("Databricks", "data", "A data and analytics platform built around Apache Spark"),
  mlflow: m("MLflow", "ml", "An open-source platform for tracking machine learning experiments"),
  vercel: m("Vercel", "deploy", "A hosting and deployment platform for web frontends"),
  netlify: m("Netlify", "deploy", "A hosting and deployment platform for web sites"),
  stripe: m("Stripe", "finance", "An online payment processing platform"),
  mercury: m("Mercury", "finance", "A banking service for startups"),
  readwise: m("Readwise", "reading", "A service that collects highlights from books and articles"),
  raindrop: m("Raindrop.io", "reading", "A bookmark manager for saving web pages"),
  intercom: m("Intercom", "support", "A customer messaging and support platform"),
  zendesk: m("Zendesk", "support", "A customer support ticketing platform"),
  lever: m("Lever", "hr", "A recruiting and applicant tracking system"),
  greenhouse: m("Greenhouse", "hr", "A recruiting and applicant tracking system"),
  pipedrive: m("Pipedrive", "sales", "A sales pipeline and CRM tool"),
  stackoverflow: m("Stack Overflow", "research", "A question and answer site for programmers"),
  zotero: m("Zotero", "research", "A reference manager for research papers and sources"),
  mendeley: m("Mendeley", "research", "Elsevier's reference manager for research papers"),
  dependencytrack: m(
    "Dependency-Track",
    "security",
    "An open-source tracker of software component vulnerabilities",
  ),
  airflow: m("Apache Airflow", "data", "An open-source scheduler for data pipelines"),
  prefect: m("Prefect", "data", "A workflow orchestration platform for data pipelines"),
  dagster: m("Dagster", "data", "A data orchestration platform for building data pipelines"),
  ramp: m("Ramp", "finance", "A corporate card and spend management platform"),
  zoom: m("Zoom", "meetings", "A video meeting and webinar service"),
  hubspot: m("HubSpot", "sales", "A CRM and marketing platform"),
  miro: m("Miro", "design", "An online whiteboard for team collaboration"),
  canva: m("Canva", "design", "An online graphic design tool"),
  figma: m("Figma", "design", "A collaborative interface design tool"),
  salesforce: m("Salesforce", "sales", "A cloud CRM platform"),
  bigquery: m("BigQuery", "data", "Google Cloud's data warehouse"),
  athena: m("Amazon Athena", "data", "AWS's service for running SQL queries on data in S3"),
  cloudwatch: m("Amazon CloudWatch", "observability", "AWS's monitoring and logging service"),
  sagemaker: m(
    "Amazon SageMaker",
    "ml",
    "AWS's service for building and deploying machine learning models",
  ),
  cloud_logging: m(
    "Google Cloud Logging",
    "observability",
    "Google Cloud's log storage and search service",
  ),
  vertex_ai: m("Vertex AI", "ml", "Google Cloud's machine learning platform"),
  elasticsearch: m("Elasticsearch", "data", "A search and analytics engine"),
  great_expectations: m(
    "Great Expectations",
    "data",
    "An open-source framework for testing data quality",
  ),
  imap: m("IMAP Email", "email", "Any email account reachable over the standard IMAP protocol"),
  fastmail: m("Fastmail", "email", "A paid email, calendar and contacts service"),
  protonmail: m("Proton Mail", "email", "An end-to-end encrypted email service"),
  localdb: m("Local Database", "local", "A database file on this machine, such as SQLite"),
  storybook: m("Storybook", "design", "A workshop for building and documenting UI components"),
  dataprofile: m("Data Profile", "data", "A tool that profiles the contents and shape of datasets"),
  snowflake: m("Snowflake", "data", "A cloud data warehouse"),
  tableau: m("Tableau", "data", "A business intelligence and data visualisation platform"),
  looker: m("Looker", "data", "Google's business intelligence platform"),
  powerbi: m("Power BI", "data", "Microsoft's business intelligence and reporting platform"),
  montecarlo: m("Monte Carlo", "data", "A data observability platform"),
  bigeye: m("Bigeye", "data", "A data quality monitoring platform"),
  workday: m("Workday", "hr", "A cloud platform for HR and finance"),
  apple: m("Apple iCloud", "email", "Apple's iCloud Mail and Calendar services"),
  blame: m("Git Blame", "local", "Git blame history of code repositories on this machine"),
  filesystem: m("Local Files", "local", "Folders and files on this machine"),
  obsidian: m("Obsidian", "local", "A local Obsidian note vault on this machine"),
  openapi: m("OpenAPI Specs", "local", "OpenAPI specification files on this machine"),
}) satisfies Readonly<Record<ConnectorServiceId | GatewaySyncableServiceId, ConnectorMeta>>;
