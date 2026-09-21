import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const staticEntries = [
  "index.html",
  "privacy.html",
  "terms.html",
  "styles.css",
  "src",
  "icons",
  "manifest.webmanifest",
  "sw.js"
];

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await Promise.all(staticEntries.map((entry) => {
  const source = path.join(projectRoot, entry);
  const destination = path.join(distDir, entry);

  return cp(source, destination, { recursive: true });
}));

console.log(`Cloudflare Pages static export written to ${path.relative(projectRoot, distDir)}/`);
