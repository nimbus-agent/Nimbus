// packages/gateway/src/connectors/connector-writes/files.ts
import { type ConnectorWriteRow, row } from "./types.ts";

export const FILES_ROWS: readonly ConnectorWriteRow[] = [
  row("gdrive_file_create", "google_drive.file.create", "mesh", 2),
  row("gdrive_file_move", "google_drive.file.move", "mesh", 3),
  row("gdrive_file_rename", "google_drive.file.rename", "mesh", 3),
  row("gdrive_file_trash", "google_drive.file.trash", "mesh", 3, "read"),
  row("onedrive_item_move", "onedrive.item.move", "mesh", 3),
  row("onedrive_item_delete", "onedrive.item.delete", "mesh", 4),
];
