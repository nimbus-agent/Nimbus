// packages/gateway/src/connectors/connector-writes/files.ts
import { type ConnectorWriteRow, row, textField, withPreview } from "./types.ts";

// Drive file create (B4a, plan R2): the content is shown in full, never cut (owner ruling
// OR-B4-3). The connector has no sharing parameter: the new file inherits the sharing of the folder
// it lands in, and with no `parentId` it lands in the root of My Drive. It sends no
// `supportsAllDrives`, so a shared-drive folder is unreachable (stated bound). A `text/html` or
// `image/svg+xml` file can reference remote content that loads only when someone opens it in a
// browser; the preview shows its type and content verbatim (it does not join B3r).

export const FILES_ROWS: readonly ConnectorWriteRow[] = [
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
  row("gdrive_file_move", "google_drive.file.move", "mesh", 3),
  row("gdrive_file_rename", "google_drive.file.rename", "mesh", 3),
  row("gdrive_file_trash", "google_drive.file.trash", "mesh", 3, "read"),
  row("onedrive_item_move", "onedrive.item.move", "mesh", 3),
  row("onedrive_item_delete", "onedrive.item.delete", "mesh", 4),
];
