export function escapeDriveQueryLiteral(value: string): string {
  return value.replaceAll("\u005c", "\u005c\u005c").replaceAll("'", "\u005c'");
}
