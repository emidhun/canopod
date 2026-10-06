// Dev server for the docs site — rebuilds on every navigation, so editing a
// markdown file and hitting reload is the whole loop. Zero dependencies.
//
//   node scripts/serve.mjs [port]      default 4180
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const PORT = Number(process.argv[2] || 4180);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function rebuild() {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "build.mjs"), "--quiet"], { encoding: "utf8" });
  if (r.status !== 0) console.error(r.stderr || r.stdout);
  return r.status === 0;
}

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/" || path === "") path = "/index.html";
  // rebuild only for page loads, not for every asset in the page
  if (path.endsWith(".html")) rebuild();
  const file = join(SITE, normalize(path).replace(/^(\.\.[/\\])+/, ""));
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end("<h1>404</h1><p><a href='/index.html'>Back to the docs</a></p>");
  }
}).listen(PORT, () => {
  rebuild();
  console.log(`Canopod docs on http://localhost:${PORT}/`);
});
