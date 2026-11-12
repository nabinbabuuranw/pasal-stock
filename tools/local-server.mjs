// Local development and QA server: runs the same Worker over an in-memory D1 stand-in
// and serves site/static from disk. Development only; production is the published Worker.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { D1Like } from "../tests/d1-node.js";
import { handle } from "../site/_worker.js";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "..", "site");
const port = Number(process.env.PORT || 8787);
const env = { DB: new D1Like(":memory:") };
const TYPES = { ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain" };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/static/") || url.pathname === "/robots.txt") {
      const rel = normalize(url.pathname.replace(/^\//, "")).replace(/^(\.\.[/\\])+/, "");
      const file = url.pathname === "/robots.txt" ? join(siteDir, "robots.txt") : join(siteDir, rel);
      if (!file.startsWith(siteDir)) { res.writeHead(404); return res.end(); }
      const body = await readFile(file).catch(() => null);
      if (!body) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      return res.end(body);
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const init = { method: req.method, headers: req.headers };
    if (chunks.length) init.body = Buffer.concat(chunks);
    const request = new Request(url.toString(), init);
    const response = await handle(request, env);
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    const setCookies = response.headers.getSetCookie?.() || [];
    if (setCookies.length) headers["set-cookie"] = setCookies;
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("local server error: " + err.message);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Pasal Stock local server on http://127.0.0.1:${port}`);
});
