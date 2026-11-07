// packages/gateway/src/connectors/connector-writes/gitops-readers.ts
// The before-state readers of the Wave 4 GitOps, ML and warehouse writes (Phase 9.7 D1, group C):
// the Argo CD sync and rollback, the Flux reconciles, the MLflow promote and stage transition and
// the Snowflake tag and comment writes. The reply shapes are the services' own JSON as the
// connectors hand it back (`argocd_get`, `flux_get`, `mlflow_get`) and the Snowflake connector's
// `{object, objectType, comment, tags}` projection. Imported BY `gitops-ml.ts` and
// `warehouse-bi.ts`, so it imports nothing from the row table.
import {
  arrayAt,
  beforeReplyJson,
  boolAt,
  excerptHead,
  listAt,
  nonEmptyString,
  presentFields,
  requiredStringAt,
  stringAt,
  yesNo,
} from "./before-select.ts";
import type { BeforeStateField, BeforeStateGuard } from "./types.ts";

type Picked = Readonly<Record<string, unknown>>;
type Input = Readonly<Record<string, unknown>>;

function shown(v: string | undefined): string | undefined {
  return v === undefined ? undefined : excerptHead(v);
}

/** `argocd_get` input: the application name. */
export function argocdReadArgs(input: Input): Record<string, unknown> | undefined {
  const name = nonEmptyString(input["name"]);
  return name === undefined ? undefined : { name };
}

/** Where the application deploys: `server` (or `name`) and namespace. */
function argocdDestination(j: unknown): string | undefined {
  const where =
    stringAt(j, ["spec", "destination", "server"]) ?? stringAt(j, ["spec", "destination", "name"]);
  const ns = stringAt(j, ["spec", "destination", "namespace"]);
  if (where === undefined) return ns;
  return ns === undefined ? where : `${where} / ${ns}`;
}

/** The auto-sync policy: `off`, or `on` with its prune setting. */
function argocdAutoSync(j: unknown): { readonly on: boolean; readonly text: string } {
  // `automated` is an object ({} when on with defaults): its presence is what turns auto-sync on.
  if (!hasObject(j, ["spec", "syncPolicy", "automated"])) return { on: false, text: "off" };
  const prune = yesNo(boolAt(j, ["spec", "syncPolicy", "automated", "prune"])) ?? "no";
  return { on: true, text: `on (prune: ${prune})` };
}

function hasObject(j: unknown, path: readonly string[]): boolean {
  let cur: unknown = j;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null || !Object.hasOwn(cur, key)) return false;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "object" && cur !== null;
}

/** The deployment history entry whose `id` is `id` (compared as text), else `undefined`. */
function historyEntry(j: unknown, id: unknown): unknown {
  const history = arrayAt(j, ["status", "history"]);
  const want = typeof id === "number" ? String(id) : typeof id === "string" ? id : undefined;
  if (history === undefined || want === undefined) return undefined;
  return history.find((e) => stringAt(e, ["id"]) === want);
}

/** Argo CD `argocd_get` (before-state), shared by the sync and the rollback. */
function argocdFields(j: unknown): BeforeStateField[] {
  const name = requiredStringAt(j, ["metadata", "name"]);
  const auto = argocdAutoSync(j);
  const phase = stringAt(j, ["status", "operationState", "phase"]);
  return [
    { label: "Application", value: excerptHead(name) },
    ...presentFields([
      ["Sync status", shown(stringAt(j, ["status", "sync", "status"]))],
      ["Health", shown(stringAt(j, ["status", "health", "status"]))],
      ["Synced revision", shown(stringAt(j, ["status", "sync", "revision"]))],
      ["Target revision", shown(stringAt(j, ["spec", "source", "targetRevision"]))],
      ["Repo", shown(stringAt(j, ["spec", "source", "repoURL"]))],
      ["Destination", shown(argocdDestination(j))],
      ["Auto-sync", auto.text],
      ["Last operation", shown(phase)],
    ]),
  ];
}

/** Argo CD `argocd_get` (before-state) for a sync. */
export function selectArgocdSync(reply: unknown): readonly BeforeStateField[] {
  return argocdFields(beforeReplyJson(reply));
}

/**
 * Argo CD `argocd_get` (before-state) for a rollback: the application, then the history entry the
 * write names (its revision and deploy time), and a note that auto-sync makes Argo CD refuse it.
 */
export function selectArgocdRollback(reply: unknown, picked: Picked): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const fields = argocdFields(j);
  const entry = historyEntry(j, picked["id"]);
  const id = picked["id"];
  const idText = typeof id === "number" || typeof id === "string" ? String(id) : "(unknown)";
  if (entry === undefined) {
    fields.push({
      label: `History entry ${excerptHead(idText)}`,
      value: "not in the deployment history",
    });
  } else {
    const revision = stringAt(entry, ["revision"]) ?? "(unknown revision)";
    const at = stringAt(entry, ["deployedAt"]);
    fields.push({
      label: `History entry ${excerptHead(idText)}`,
      value: excerptHead(at === undefined ? revision : `${revision} (deployed ${at})`),
    });
  }
  if (argocdAutoSync(j).on) {
    fields.push({
      label: "Note",
      value: "auto-sync is on: Argo CD refuses a rollback while it is on",
    });
  }
  return fields;
}

/** The Argo CD rollback guard: the history id must be an entry of the application's own history. */
export const ARGOCD_ROLLBACK_HISTORY_GUARD: BeforeStateGuard = {
  reason: "the history id is not in the application's deployment history",
  appliesTo: () => true,
  allows: (reply, picked) => historyEntry(beforeReplyJson(reply), picked["id"]) !== undefined,
};

/** `flux_get` input for a reconcile of `kind`: the namespace and the name. */
export function fluxReadArgs(
  kind: "kustomization" | "helm_release",
): (input: Input) => Record<string, unknown> | undefined {
  return (input) => {
    const namespace = nonEmptyString(input["namespace"]);
    const name = nonEmptyString(input["name"]);
    return namespace === undefined || name === undefined ? undefined : { kind, namespace, name };
  };
}

/** Flux `flux_get` (before-state) for a reconcile: Ready, suspended, the last applied revision, the interval. */
export function selectFluxResource(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const name = requiredStringAt(j, ["metadata", "name"]);
  const conditions = arrayAt(j, ["status", "conditions"]);
  const ready = conditions?.find((c) => stringAt(c, ["type"]) === "Ready");
  const readyStatus = ready === undefined ? undefined : stringAt(ready, ["status"]);
  const reason = ready === undefined ? undefined : stringAt(ready, ["reason"]);
  const message = ready === undefined ? undefined : stringAt(ready, ["message"]);
  const readyText =
    readyStatus === undefined
      ? undefined
      : reason === undefined
        ? readyStatus
        : `${readyStatus} (${reason})`;
  return [
    { label: "Resource", value: excerptHead(name) },
    ...presentFields([
      ["Ready", shown(readyText)],
      ["Ready message", shown(message)],
      ["Suspended", yesNo(boolAt(j, ["spec", "suspend"]))],
      [
        "Last applied revision",
        shown(
          stringAt(j, ["status", "lastAppliedRevision"]) ??
            stringAt(j, ["status", "lastAttemptedRevision"]),
        ),
      ],
      ["Interval", shown(stringAt(j, ["spec", "interval"]))],
    ]),
  ];
}

/** `mlflow_get` input: the registered model's name. */
export function mlflowReadArgs(input: Input): Record<string, unknown> | undefined {
  const name = nonEmptyString(input["name"]);
  return name === undefined ? undefined : { name };
}

/** The latest versions of each stage that are in `stage`, as `v<version>` joined. */
function versionsInStage(latest: readonly unknown[], stage: string): string {
  const versions = latest.flatMap((v) => {
    const version = stringAt(v, ["version"]);
    return stringAt(v, ["current_stage"]) === stage && version !== undefined ? [`v${version}`] : [];
  });
  return versions.length === 0 ? "(none)" : versions.join(", ");
}

/**
 * MLflow `mlflow_get` (before-state) for a promote or a stage transition: the model, the version it
 * moves (its stage now, when the model's `latest_versions` lists it), the versions in Production
 * now (a promote, or a move to Production) and whether the incumbents are archived. The default of
 * `archiveExisting` is the connector's own (promote: true, transition: false).
 */
export function selectMlflowModel(
  mode: "promote" | "transition",
): (reply: unknown, picked: Picked) => readonly BeforeStateField[] {
  return (reply, picked) => {
    const j = beforeReplyJson(reply);
    const name = requiredStringAt(j, ["registered_model", "name"]);
    const latest = arrayAt(j, ["registered_model", "latest_versions"]) ?? [];
    const version = picked["version"];
    const versionText = typeof version === "string" ? version : undefined;
    const entry = latest.find((v) => stringAt(v, ["version"]) === versionText);
    const stageNow =
      entry === undefined
        ? "(not among the latest version of each stage)"
        : (stringAt(entry, ["current_stage"]) ?? "(unknown)");
    const target = mode === "promote" ? "Production" : picked["stage"];
    const archive = picked["archiveExisting"];
    const archives = typeof archive === "boolean" ? archive : mode === "promote";
    const fields: BeforeStateField[] = [
      { label: "Model", value: excerptHead(name) },
      {
        label: `Version ${versionText === undefined ? "(unknown)" : excerptHead(versionText)} stage now`,
        value: excerptHead(stageNow),
      },
    ];
    if (target === "Production") {
      fields.push({
        label: "Production now",
        value: excerptHead(versionsInStage(latest, "Production")),
      });
    }
    fields.push({
      label: "Archives incumbent versions",
      value: archives
        ? `yes: the versions already in ${typeof target === "string" ? excerptHead(target) : "the target stage"} become Archived`
        : "no",
    });
    return fields;
  };
}

/** `snowflake_object_metadata_get` input: the table (the tag and comment writes support tables only). */
export function snowflakeMetadataReadArgs(input: Input): Record<string, unknown> | undefined {
  const object = nonEmptyString(input["object"]);
  return object === undefined ? undefined : { object };
}

/** The last dot-separated segment of an identifier, unquoted and upper-cased (Snowflake folds case). */
function lastSegment(identifier: string): string {
  const parts = identifier.split(".");
  const last = parts[parts.length - 1] ?? identifier;
  return (last.startsWith('"') && last.endsWith('"') ? last.slice(1, -1) : last).toUpperCase();
}

/**
 * Snowflake `snowflake_object_metadata_get` (before-state) for a tag set or removal: the table, the
 * tag's value now (matched case-insensitively on its last name segment; the read returns direct AND
 * inherited tags, so the value may be inherited) and every tag on the table, capped.
 */
export function selectSnowflakeTag(reply: unknown, picked: Picked): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const object = requiredStringAt(j, ["object"]);
  const tags = arrayAt(j, ["tags"]);
  if (tags === undefined) throw new Error("before reply: no tags");
  const want = typeof picked["tag"] === "string" ? lastSegment(picked["tag"]) : undefined;
  const hit = tags.find((t) => {
    const n = stringAt(t, ["name"]);
    return n !== undefined && want !== undefined && lastSegment(n) === want;
  });
  const value = hit === undefined ? undefined : (stringAt(hit, ["value"]) ?? "(no value)");
  const all = listAt(
    {
      tags: tags.flatMap((t) => {
        const n = stringAt(t, ["name"]);
        return n === undefined ? [] : [`${n}=${stringAt(t, ["value"]) ?? ""}`];
      }),
    },
    ["tags"],
  );
  return [
    { label: "Table", value: excerptHead(object) },
    {
      label: "Tag now",
      value:
        value === undefined
          ? "(not set)"
          : excerptHead(
              `${value} (the read also returns tags inherited from the schema or database)`,
            ),
    },
    ...presentFields([["All tags on the table", shown(all)]]),
  ];
}

/** Snowflake `snowflake_object_metadata_get` (before-state) for a comment set: the comment now. */
export function selectSnowflakeComment(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const object = requiredStringAt(j, ["object"]);
  const comment = stringAt(j, ["comment"]);
  return [
    { label: "Table", value: excerptHead(object) },
    {
      label: "Current comment",
      value: comment === undefined || comment === "" ? "(none)" : excerptHead(comment),
    },
  ];
}
