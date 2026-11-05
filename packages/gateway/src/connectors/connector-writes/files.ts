// packages/gateway/src/connectors/connector-writes/files.ts
import { beforeReplyJson, excerptHead, requiredStringAt, stringAt } from "./before-select.ts";
import {
  type BeforeStateField,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withPreview,
} from "./types.ts";

// Drive file create (B4a, plan R2/R3): the content is shown in full, never cut (owner ruling
// OR-B4-3). The connector has no sharing parameter: the new file inherits the sharing of the folder
// it lands in, and with no `parentId` it lands in the root of My Drive. It sends no
// `supportsAllDrives`, so a shared-drive folder is unreachable (stated bound). Since B3r (owner
// ruling OR-B3r-2, and the coordinator's ruling on the review) both doors refuse remote content in
// a markup file: its `mimeType` is HTML, XHTML, SVG or other markup (`driveMimeTypeScans`), or its
// `name` ends in `.html`, `.htm`, `.xhtml`, `.svg`, `.xml`, `.mht` or `.mhtml`; a `.md` name is
// scanned as Markdown (`driveContentFormat`). A `text/plain` file with a plain name is not scanned.
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
  row("gdrive_file_move", "google_drive.file.move", "mesh", 3),
  row("gdrive_file_rename", "google_drive.file.rename", "mesh", 3),
  row("gdrive_file_trash", "google_drive.file.trash", "mesh", 3, "read"),
  row("onedrive_item_move", "onedrive.item.move", "mesh", 3),
  row("onedrive_item_delete", "onedrive.item.delete", "mesh", 4),
];
