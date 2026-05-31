import { readFile, writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

const SRC = "docs/assets/og-card.svg";
const OUT = "docs/og-card.png";
const FONT_DIR = "docs/assets/fonts";

const svg = await readFile(SRC, "utf-8");
const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 1200 },
  background: "rgba(0, 0, 0, 0)",
  font: {
    loadSystemFonts: false,
    fontFiles: [`${FONT_DIR}/JetBrainsMono-Regular.ttf`, `${FONT_DIR}/JetBrainsMono-Bold.ttf`],
    defaultFontFamily: "JetBrains Mono",
  },
});
const png = resvg.render().asPng();
await writeFile(OUT, png);
console.log(`Rendered ${SRC} → ${OUT} (${png.byteLength} bytes)`);
