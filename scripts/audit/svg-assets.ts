import { readFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

export interface SvgAuditResult {
  ok: boolean;
  width?: number;
  height?: number;
  reason?: string;
}

export async function auditSvgFile(path: string): Promise<SvgAuditResult> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    return { ok: false, reason: `read failed: ${(err as Error).message}` };
  }

  let resvg: Resvg;
  try {
    resvg = new Resvg(content);
  } catch (err) {
    const message = (err as Error).message;
    if (/invalid size/i.test(message)) {
      return { ok: false, reason: `zero dimension: ${message}` };
    }
    return { ok: false, reason: `parse failed: ${message}` };
  }

  const bbox = resvg.innerBBox() ?? { width: 0, height: 0 };
  const svgWidth = resvg.width || bbox.width;
  const svgHeight = resvg.height || bbox.height;

  if (svgWidth <= 0 || svgHeight <= 0) {
    return { ok: false, reason: `zero dimension: ${svgWidth}x${svgHeight}` };
  }

  return { ok: true, width: svgWidth, height: svgHeight };
}

if (import.meta.main) {
  const { glob } = await import("node:fs/promises");
  const paths: string[] = [];
  for await (const p of glob("docs/assets/**/*.svg")) paths.push(p);

  let failures = 0;
  for (const p of paths) {
    const result = await auditSvgFile(p);
    if (!result.ok) {
      console.error(`FAIL ${p}: ${result.reason}`);
      failures++;
    } else {
      console.log(`OK ${p} (${result.width}x${result.height})`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} SVG file(s) failed audit`);
    process.exit(1);
  }
  console.log(`\n${paths.length} SVG file(s) passed audit`);
}
