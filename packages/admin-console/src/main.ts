// Admin console entry point. DOM mount + routing land in Task 18.
import { renderOverview } from "./render.ts";

const el = document.getElementById("app");
if (el !== null) {
  el.innerHTML = "<p>Nimbus Admin Console — loading…</p>";
  void renderOverview; // referenced so the import isn't dead before Task 18
}
