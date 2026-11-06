// packages/gateway/src/connectors/connector-writes/files.ts
import {
  beforeReplyJson,
  excerptHead,
  listAt,
  requiredStringAt,
  stringAt,
} from "./before-select.ts";
import {
  type BeforeStateField,
  type BeforeStateRead,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withConfirm,
  withPreview,
} from "./types.ts";

// Drive file create (B4a, plan R2/R3): the content is shown in full, never cut (owner ruling
// OR-B4-3). The connector has no sharing parameter: the new file inherits the sharing of the folder
// it lands in, and with no `parentId` it lands in the root of My Drive. It sends no
// `supportsAllDrives`, so a shared-drive folder is unreachable (stated bound). Since B3r (owner
// ruling OR-B3r-2, and the coordinator's ruling on the review) both doors refuse remote content in
// a markup file: its `mimeType` is HTML, XHTML, SVG or other markup (`driveMimeTypeScans`), or its
// `name` ends in `.html`, `.htm`, `.xhtml`, `.svg`, `.xml`, `.mht` or `.mhtml`; a `.md` name is
// scanned as Markdown (`driveContentFormats`). A `text/plain` file with a plain name is not scanned.
//
// The before reads the folder the file lands in (`gdrive_file_metadata` on `parentId`, or on
// Drive's `root` alias when it is unset): its name, whether it is a folder, whether it is shared
// (the warning for a create into a shared folder, which is allowed: owner ruling OR-B4-4, no
// guard), its owner, and whether it is in the trash. Every value goes through `excerptHead`.
// Stated bound: the folder can be re-shared between the read and the write.

/** Drive's MIME type for a folder. */
export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

/** The first owner's e-mail address (or display name), with ` and <k> more` for the rest. */
function driveOwner(j: unknown): string | undefined {
  const owners: unknown =
    typeof j === "object" && j !== null && Object.hasOwn(j, "owners")
      ? (j as Record<string, unknown>)["owners"]
      : undefined;
  if (!Array.isArray(owners) || owners.length === 0) return undefined;
  const list = owners as unknown[];
  const first = stringAt(list[0], ["emailAddress"]) ?? stringAt(list[0], ["displayName"]);
  if (first === undefined) return undefined;
  const more = list.length - 1;
  return more > 0 ? `${first} and ${String(more)} more` : first;
}

/**
 * Drive `gdrive_file_metadata` (before-state), for a file create: the folder the file lands in.
 * `Folder` (its name; absent: throws, so the prompt reads `unavailable (failed)`), `Folder type`,
 * `Shared`, `Owner` (when the reply names one) and `In trash` (only when `trashed` is `true`).
 */
export function selectDriveParentFolder(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const name = requiredStringAt(j, ["name"]);
  const mime = stringAt(j, ["mimeType"]);
  const own = (key: string): unknown =>
    typeof j === "object" && j !== null && Object.hasOwn(j, key)
      ? (j as Record<string, unknown>)[key]
      : undefined;
  const out: BeforeStateField[] = [
    { label: "Folder", value: excerptHead(name) },
    {
      label: "Folder type",
      value:
        mime === DRIVE_FOLDER_MIME
          ? "folder"
          : excerptHead(`not a folder (${mime ?? "unknown type"}): Drive will refuse the create`),
    },
    {
      label: "Shared",
      value:
        own("shared") === true
          ? "yes: the new file is visible to everyone this folder is shared with"
          : "no",
    },
  ];
  const owner = driveOwner(j);
  if (owner !== undefined) out.push({ label: "Owner", value: excerptHead(owner) });
  if (own("trashed") === true) out.push({ label: "In trash", value: "yes" });
  return out;
}

/** Whether `j` has an own property `key` holding exactly `true`. */
function isTrueAt(j: unknown, key: string): boolean {
  return typeof j === "object" && j !== null && Object.hasOwn(j, key)
    ? (j as Record<string, unknown>)[key] === true
    : false;
}

/** Whether `j` has an own property `key` that is a non-null object (a Graph facet). */
function hasFacet(j: unknown, key: string): boolean {
  if (typeof j !== "object" || j === null || !Object.hasOwn(j, key)) return false;
  const v = (j as Record<string, unknown>)[key];
  return typeof v === "object" && v !== null;
}

/** A non-empty string input, else `undefined`: the reads never run on a number, null or "". */
function idArg(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * The part of a Drive file's `gdrive_file_metadata` reply every file write shows (rename, trash,
 * move): `Current name` (required: absent throws), `Type`, `Shared` (the wording is the write's
 * own), `Owner` and `In trash` (only when `trashed` is `true`).
 */
function driveFileFields(j: unknown, sharedYes: string): BeforeStateField[] {
  const name = requiredStringAt(j, ["name"]);
  const mime = stringAt(j, ["mimeType"]);
  const out: BeforeStateField[] = [
    { label: "Current name", value: excerptHead(name) },
    {
      label: "Type",
      value: mime === DRIVE_FOLDER_MIME ? "folder" : excerptHead(mime ?? "unknown type"),
    },
    { label: "Shared", value: isTrueAt(j, "shared") ? sharedYes : "no" },
  ];
  const owner = driveOwner(j);
  if (owner !== undefined) out.push({ label: "Owner", value: excerptHead(owner) });
  if (isTrueAt(j, "trashed")) out.push({ label: "In trash", value: "yes" });
  return out;
}

/** Drive `gdrive_file_metadata` (before-state) for a rename: the file as it is named now. */
export function selectDriveFileRename(reply: unknown): readonly BeforeStateField[] {
  return driveFileFields(beforeReplyJson(reply), "yes");
}

/** Drive `gdrive_file_metadata` (before-state) for a trash: who loses access until it is restored. */
export function selectDriveFileTrash(reply: unknown): readonly BeforeStateField[] {
  return driveFileFields(
    beforeReplyJson(reply),
    "yes: everyone it is shared with loses access until it is restored",
  );
}

/**
 * Drive before-state for a move: the file (`Current name`, `Type`, `Shared`, `Owner`, `In trash`),
 * its current `Folders` (parent ids, capped by `listAt`; absent when the reply has no `parents`),
 * then the destination from the second read (`Destination folder`, `Destination type`, and
 * `Destination shared`, the warning that the moved file becomes visible to everyone the folder is
 * shared with). A reply with no `name` throws, so the prompt reads `unavailable (failed)`.
 */
export function selectDriveFileMove(
  reply: unknown,
  _picked: unknown,
  alsoReply: unknown,
): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const dest = beforeReplyJson(alsoReply);
  const out = driveFileFields(j, "yes");
  const folders = listAt(j, ["parents"]);
  if (folders !== undefined) out.push({ label: "Folders", value: excerptHead(folders) });
  const destMime = stringAt(dest, ["mimeType"]);
  out.push(
    { label: "Destination folder", value: excerptHead(requiredStringAt(dest, ["name"])) },
    {
      label: "Destination type",
      value:
        destMime === DRIVE_FOLDER_MIME
          ? "folder"
          : excerptHead(`not a folder (${destMime ?? "unknown type"}): Drive will refuse the move`),
    },
    {
      label: "Destination shared",
      value: isTrueAt(dest, "shared")
        ? "yes: the moved file becomes visible to everyone this folder is shared with"
        : "no",
    },
  );
  return out;
}

/** The parent reference of a Graph driveItem: its path when it has one, else its id. */
function onedriveParent(j: unknown): string | undefined {
  return stringAt(j, ["parentReference", "path"]) ?? stringAt(j, ["parentReference", "id"]);
}

/**
 * OneDrive `onedrive_item_get` (before-state) for a move: the item (`Name`, `Type` from the
 * `folder`/`file` facet, `Parent`, `Shared`), then the destination from the second read
 * (`Destination folder`, `Destination type`). A reply with no `name` throws.
 */
export function selectOnedriveItemMove(
  reply: unknown,
  _picked: unknown,
  alsoReply: unknown,
): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const dest = beforeReplyJson(alsoReply);
  let kind = "item";
  if (hasFacet(j, "folder")) kind = "folder";
  else if (hasFacet(j, "file")) kind = "file";
  const parent = onedriveParent(j);
  const out: BeforeStateField[] = [
    { label: "Name", value: excerptHead(requiredStringAt(j, ["name"])) },
    { label: "Type", value: kind },
  ];
  if (parent !== undefined) out.push({ label: "Parent", value: excerptHead(parent) });
  out.push(
    { label: "Shared", value: hasFacet(j, "shared") ? "yes: others can open it" : "no" },
    { label: "Destination folder", value: excerptHead(requiredStringAt(dest, ["name"])) },
    {
      label: "Destination type",
      value: hasFacet(dest, "folder") ? "folder" : "not a folder: OneDrive will refuse the move",
    },
  );
  return out;
}

/** A read whose only input is `key`, taken from the write's `key` (a non-empty string). */
function readOf(tool: string, key: string, fromKey: string): BeforeStateRead {
  return {
    tool,
    argKeys: [fromKey],
    args: (input) => {
      const id = idArg(input[fromKey]);
      return id === undefined ? undefined : { [key]: id };
    },
  };
}

export const FILES_ROWS: readonly ConnectorWriteRow[] = [
  withBefore(
    withPreview(row("gdrive_file_create", "google_drive.file.create", "mesh", 2), {
      target: "{name}",
      summary: "Create a Google Drive file named {name}",
      fields: [
        textField("name", "File name"),
        textField("mimeType", "Type", "text/plain"),
        textField("parentId", "Folder id", "(not set: the root of My Drive)"),
        textField("content", "Content (sent as is, shown in full)", "(not set: an empty file)"),
      ],
    }),
    {
      tool: "gdrive_file_metadata",
      argKeys: ["parentId"],
      // Unset: Drive's `root` alias (My Drive, where the connector creates the file). Present
      // but not a non-empty string (a number, null, ""): no read, so `unavailable (failed)`,
      // never "My Drive".
      args: (input) => {
        const id = input["parentId"];
        if (id === undefined) return { fileId: "root" };
        return typeof id === "string" && id !== "" ? { fileId: id } : undefined;
      },
      select: selectDriveParentFolder,
    },
  ),
  // Drive move: the connector sends `addParents` and `removeParents`. With no `removeParentId` it
  // lists the file's parents and removes the FIRST one (it refuses a file with no parent), a hidden
  // effect the preview states. Recoverable: the file can be moved back.
  withBefore(
    withPreview(row("gdrive_file_move", "google_drive.file.move", "mesh", 3), {
      target: "{fileId}",
      summary: "Move Google Drive file {fileId} into folder {newParentId}",
      fields: [
        textField("fileId", "File id"),
        textField("newParentId", "New folder id"),
        textField(
          "removeParentId",
          "Folder to remove it from",
          "(not set: the connector removes the file's FIRST current folder)",
        ),
      ],
    }),
    {
      ...readOf("gdrive_file_metadata", "fileId", "fileId"),
      also: readOf("gdrive_file_metadata", "fileId", "newParentId"),
      select: selectDriveFileMove,
    },
  ),
  withBefore(
    withPreview(row("gdrive_file_rename", "google_drive.file.rename", "mesh", 3), {
      target: "{fileId}",
      summary: "Rename Google Drive file {fileId}",
      fields: [textField("fileId", "File id"), textField("newName", "New name")],
    }),
    { ...readOf("gdrive_file_metadata", "fileId", "fileId"), select: selectDriveFileRename },
  ),
  // Drive trash: PATCH `trashed: true`. Drive keeps a trashed file for 30 days and it can be
  // restored from the trash (the connector marks it recoverable). Registered as a write since
  // connectors 0.6.0.
  withBefore(
    withPreview(row("gdrive_file_trash", "google_drive.file.trash", "mesh", 3), {
      target: "{fileId}",
      summary:
        "Move Google Drive file {fileId} to the Drive trash (it can be restored from the trash for 30 days)",
      fields: [textField("fileId", "File id")],
    }),
    { ...readOf("gdrive_file_metadata", "fileId", "fileId"), select: selectDriveFileTrash },
  ),
  withBefore(
    withPreview(row("onedrive_item_move", "onedrive.item.move", "mesh", 3), {
      target: "{itemId}",
      summary: "Move OneDrive item {itemId} into folder {newParentId}",
      fields: [
        textField("itemId", "Item id"),
        textField("newParentId", "New folder id"),
        textField("newName", "New name", "(not set: keeps its name)"),
      ],
    }),
    {
      ...readOf("onedrive_item_get", "itemId", "itemId"),
      also: readOf("onedrive_item_get", "itemId", "newParentId"),
      select: selectOnedriveItemMove,
    },
  ),
  withConfirm(row("onedrive_item_delete", "onedrive.item.delete", "mesh", 4), {
    template: "delete {itemId:tail8}",
  }),
];
