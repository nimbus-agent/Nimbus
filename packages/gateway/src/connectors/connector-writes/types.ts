// packages/gateway/src/connectors/connector-writes/types.ts

/** `write` rows have a dispatch path (the credential-aware transport); `mesh` rows are refused by
 *  the I26 predicate and run only through the executor's mesh path behind the owner's HITL gate. */
export type ConnectorWriteTransport = "write" | "mesh";

/** The migration wave the row was classified in. */
export type ConnectorWriteWave = 2 | 3 | 4;

export interface ConnectorWriteRow {
  readonly toolId: string;
  readonly actionType: string;
  readonly transport: ConnectorWriteTransport;
  readonly wave: ConnectorWriteWave;
  /** Set only for a tool that mutates while upstream registers it as a READ (invisible to the scanner). */
  readonly registeredAs?: "read";
  /** How the owner's consent prompt shows this write's input; absent = today's raw prompt. */
  readonly preview?: ConnectorWritePreviewTemplate;
}

export type PreviewFieldKind = "text" | "markdown" | "list" | "secret";

export interface PreviewFieldTemplate {
  readonly key: string;
  readonly label: string;
  readonly kind: PreviewFieldKind;
  /** Text shown when the input omits the key (its real default), instead of `(not set)`. */
  readonly whenUnset?: string;
}

export interface ConnectorWritePreviewTemplate {
  /** `{key}` placeholders over top-level input keys, e.g. "{namespace}/{name}". */
  readonly target: string;
  readonly summary: string;
  readonly fields: readonly PreviewFieldTemplate[];
}

/** A frozen copy of `r` carrying `preview`. */
export function withPreview(
  r: ConnectorWriteRow,
  preview: ConnectorWritePreviewTemplate,
): ConnectorWriteRow {
  const secrets = new Set(preview.fields.filter((f) => f.kind === "secret").map((f) => f.key));
  for (const text of [preview.target, preview.summary]) {
    for (const m of text.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
      if (m[1] !== undefined && secrets.has(m[1])) {
        throw new Error(
          `connector write preview: placeholder {${m[1]}} names a secret field (row ${r.toolId})`,
        );
      }
    }
  }
  return Object.freeze({ ...r, preview });
}

/** One-line builder. Argument order: tool id FIRST, then action type. */
export function row(
  toolId: string,
  actionType: string,
  transport: ConnectorWriteTransport,
  wave: ConnectorWriteWave,
  registeredAs?: "read",
): ConnectorWriteRow {
  return Object.freeze(
    registeredAs === undefined
      ? { toolId, actionType, transport, wave }
      : { toolId, actionType, transport, wave, registeredAs },
  );
}

/** One dispatchable connector write: its HITL action.type, its MCP tool id, and its service id.
 *  Derived from the `write`-transport rows (`CONNECTOR_WRITES` in `connector-write-registry.ts`). */
export interface ConnectorWrite {
  readonly actionType: string;
  readonly toolId: string;
  readonly service: string;
}
