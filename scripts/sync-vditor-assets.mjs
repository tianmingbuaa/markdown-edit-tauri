/**
 * Vditor lazy-loads its parser (Lute), icon sprite, i18n bundle and code
 * highlighting assets at runtime. Desktop builds must stay fully offline, so
 * we vendor just the assets this app can request into `public/vditor`.
 *
 * Generated files are intentionally ignored by git. Both `npm run dev` and
 * `npm run build` copy them first via the package pre-scripts.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "vditor", "dist");
const target = join(root, "public", "vditor", "dist");

const assets = [
  "js/lute/lute.min.js",
  "js/icons/material.js",
  "js/i18n/zh_CN.js",
  "js/i18n/en_US.js",
  "js/highlight.js/highlight.min.js",
  "js/highlight.js/third-languages.js",
  "js/highlight.js/styles/github.min.css",
  "js/highlight.js/styles/github-dark.min.css",
  "css/content-theme/light.css",
  "css/content-theme/dark.css",
  "images/emoji",
];

rmSync(join(root, "public", "vditor"), { recursive: true, force: true });

let copied = 0;
for (const asset of assets) {
  const from = join(source, asset);
  const to = join(target, asset);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  copied += 1;
}

console.log(`[vditor] synced ${copied} offline asset groups to public/vditor`);
