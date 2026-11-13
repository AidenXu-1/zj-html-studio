import { readFileSync } from "node:fs";

// Shared by browser, server and native Obsidian regression checks.
export const FIXED_CANVAS_HTML = readFileSync(new URL("./fixed-canvas.html", import.meta.url), "utf8");
