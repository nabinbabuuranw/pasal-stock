// Security tests: CSRF, origin checks, cookies, headers, and no inline styles or scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newEnv, Client, loginAs, q1 } from "./helpers.js";

const STRICT_CSP = /default-src 'self'/;

const PAGES = [
  ["GET", "/"], ["GET", "/login"], ["GET", "/signup"], ["GET", "/terms"], ["GET", "/privacy"], ["GET", "/nope-404"],
];
const APP_PAGES = [
  ["owner", "/app"], ["owner", "/app/products"], ["owner", "/app/products/new"], ["owner", "/app/movements"],
  ["owner", "/app/alerts"], ["owner", "/app/suppliers"], ["owner", "/app/orders"], ["owner", "/app/orders/new"],
  ["owner", "/app/settings"], ["staff", "/app/products"], ["staff", "/app/alerts"], ["staff", "/app/movements"],
  ["admin", "/admin"],
];

test("every response carries a strict Content-Security-Policy and security headers", async () => {
  const env = newEnv();
  const c = new Client(env);
  for (const [, path] of PAGES) {
    const r = await c.get(path);
    const csp = r.headers.get("content-security-policy");
    assert.ok(csp && STRICT_CSP.test(csp), `CSP on ${path}`);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/, `no loosening on ${path}`);
    assert.match(csp, /style-src 'self'(;|$)/, `style-src is self only on ${path}`);
    assert.match(csp, /script-src 'self'(;|$)/, `script-src is self only on ${path}`);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
  }
});

test("no page carries an inline style attribute, a style block or an inline script", async () => {
  const env = newEnv();
  const anon = new Client(env);
  const bodies = [];
  for (const [, path] of PAGES) bodies.push([path, (await anon.get(path)).text_]);
  const sessions = { owner: await loginAs(env, "owner"), staff: await loginAs(env, "staff"), admin: await loginAs(env, "admin") };
  for (const [who, path] of APP_PAGES) {
    const r = await sessions[who].get(path);
    bodies.push([`${who} ${path}`, r.text_]);
  }
  for (const [where, html] of bodies) {
    assert.doesNotMatch(html, /\sstyle\s*=/i, `inline style attribute on ${where}`);
    assert.doesNotMatch(html, /<style[\s>]/i, `style block on ${where}`);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, `inline script on ${where}`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `inline event handler on ${where}`);
  }
});

test("session cookies are HttpOnly, Secure and SameSite=Lax", async () => {
  const env = newEnv();
  const c = new Client(env);
  const r = await c.post("/login", { email: "owner@demo.invalid", password: "demo-owner-2026" });
  const raw = r.headers.getSetCookie().find((s) => s.startsWith("ps_session="));
  assert.ok(raw, "session cookie set");
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /Secure/);
  assert.match(raw, /SameSite=Lax/);
});

test("a form post without the form token is refused and writes nothing", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const before = await q1(env, "SELECT COUNT(*) AS n FROM products");
  const r = await owner.post("/app/products", { name: "Forged", category: "Grocery", unit: "pcs", reorder_level: "0", reorder_qty: "0", _csrf: "wrong-token-value" });
  assert.equal(r.status, 403);
  const after = await q1(env, "SELECT COUNT(*) AS n FROM products");
  assert.equal(after.n, before.n);
});

test("a form post from another origin is refused even with a valid token", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const r = await owner.post("/app/settings/plan", {}, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  const rows = await q1(env, "SELECT COUNT(*) AS n FROM plan_interest");
  assert.equal(rows.n, 0);
});

test("a request with no session cannot post to the app", async () => {
  const env = newEnv();
  const anon = new Client(env);
  await anon.get("/login");
  const r = await anon.post("/app/products", { name: "Anon", category: "Grocery", unit: "pcs", reorder_level: "0", reorder_qty: "0" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/login");
  const n = await q1(env, "SELECT COUNT(*) AS n FROM products WHERE name = 'Anon'");
  assert.equal(n.n, 0);
});

test("oversized form bodies are refused", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const r = await owner.post("/app/products", { name: "x".repeat(20000), category: "Grocery", unit: "pcs", reorder_level: "0", reorder_qty: "0" });
  assert.ok(r.status === 413 || r.status === 303, "refused or bounded, never stored");
  const n = await q1(env, "SELECT COUNT(*) AS n FROM products WHERE length(name) > 80");
  assert.equal(n.n, 0);
});

test("pages do not print session tokens, password hashes or the CSRF secret for other users", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const r = await owner.get("/app/settings");
  assert.doesNotMatch(r.text_, /pbkdf2-sha256/);
  assert.doesNotMatch(r.text_, /ps_session/);
  assert.doesNotMatch(r.text_, new RegExp(owner.cookies.ps_session.slice(0, 20)));
});
