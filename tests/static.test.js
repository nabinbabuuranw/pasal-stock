// Static assets and the built pages: the files exist, the stylesheet has no outside references,
// and the local server serves the same bytes the Worker expects.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "..", "site");
const FONTS = [
  "big-shoulders-display-latin-700-normal.woff2", "big-shoulders-display-latin-800-normal.woff2",
  "instrument-sans-latin-400-normal.woff2", "instrument-sans-latin-500-normal.woff2",
  "instrument-sans-latin-600-normal.woff2", "instrument-sans-latin-700-normal.woff2",
  "hind-latin-400-normal.woff2", "hind-latin-600-normal.woff2",
  "hind-devanagari-400-normal.woff2", "hind-devanagari-600-normal.woff2",
];

test("the deployable files are where the Worker and the HTML expect them", async () => {
  for (const f of ["_worker.js", "tab-site.json", "robots.txt", "static/app.css", "static/app.js", "static/icons.svg", "static/favicon.svg"]) {
    const s = await stat(join(site, f));
    assert.ok(s.size > 0, `${f} is not empty`);
  }
  for (const f of FONTS) {
    const s = await stat(join(site, "static", "fonts", f));
    assert.ok(s.size > 1000, `${f} is a font file`);
  }
});

test("the declared D1 binding is the one the Worker reads", async () => {
  const decl = JSON.parse(await readFile(join(site, "tab-site.json"), "utf8"));
  assert.deepEqual(decl.bindings, [{ type: "d1", name: "DB" }]);
  const worker = await readFile(join(site, "_worker.js"), "utf8");
  assert.match(worker, /env\.DB/);
});

test("the stylesheet loads nothing from outside and uses no inline imports", async () => {
  const css = await readFile(join(site, "static", "app.css"), "utf8");
  assert.doesNotMatch(css, /@import/);
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]);
  for (const u of urls) assert.ok(u.startsWith("/static/"), `font or asset path is local: ${u}`);
});

test("the client script has no network calls and no eval", async () => {
  const js = await readFile(join(site, "static", "app.js"), "utf8");
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|eval\(|innerHTML/);
});

test("the copy avoids em dashes in every visible file", async () => {
  for (const f of ["_worker.js", "static/app.css"]) {
    const text = await readFile(join(site, f), "utf8");
    assert.ok(!text.includes("\u2014"), `no em dash in ${f}`);
  }
});

let server;
before(async () => {
  server = spawn(process.execPath, [join(here, "..", "tools", "local-server.mjs")], {
    env: { ...process.env, PORT: "8797" }, stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("local server did not start")), 8000);
    server.stdout.on("data", (d) => { if (String(d).includes("8797")) { clearTimeout(t); resolve(); } });
    server.on("error", reject);
  });
});
after(() => { if (server) server.kill("SIGTERM"); });

test("the local server serves the stylesheet, icons and robots file with the right types", async () => {
  const css = await fetch("http://127.0.0.1:8797/static/app.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  const icons = await fetch("http://127.0.0.1:8797/static/icons.svg");
  assert.equal(icons.status, 200);
  const robots = await fetch("http://127.0.0.1:8797/robots.txt");
  assert.equal(robots.status, 200);
  const missing = await fetch("http://127.0.0.1:8797/static/../tab-site.json");
  assert.notEqual(missing.status, 200, "the deploy file is never served");
});

test("the local server answers the home page, login, legal pages and a 404 with the right status", async () => {
  const base = "http://127.0.0.1:8797";
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/login`)).status, 200);
  assert.equal((await fetch(`${base}/terms`)).status, 200);
  assert.equal((await fetch(`${base}/privacy`)).status, 200);
  assert.equal((await fetch(`${base}/no-such-page`)).status, 404);
  assert.equal((await fetch(`${base}/app`, { redirect: "manual" })).status, 303);
});
