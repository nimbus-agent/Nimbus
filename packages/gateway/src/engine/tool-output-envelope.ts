export interface ToolOutputContext {
  service: string;
  tool: string;
}

function escapeAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function wrapToolOutput(ctx: ToolOutputContext, result: unknown): string {
  const body = JSON.stringify(result ?? null);
  const safeBody = body.replaceAll("</tool_output>", String.raw`<\/tool_output>`);
  return `<tool_output service="${escapeAttr(ctx.service)}" tool="${escapeAttr(ctx.tool)}">${safeBody}</tool_output>`;
}
