// Pasal Stock: stock, reorder alerts and supplier purchase orders for small shops (demo only).
// One Cloudflare Worker over D1. Every page is rendered on the server. Forms post back with a
// CSRF token and redirect (POST, redirect, GET). No payment is taken anywhere in this app.
// All shops, people, suppliers and items in the demo are made up or illustrative.

const SESSION_MS = 12 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000;
const NPT_OFFSET_MS = (5 * 60 + 45) * 60 * 1000; // Nepal Time, UTC+05:45, no daylight saving
const FREE_PRODUCT_LIMIT = 40;
const FREE_ACCOUNT_LIMIT = 2;
const SHOP_ACCOUNT_LIMIT = 10;
const MAX_BODY_BYTES = 16 * 1024;
const LOGIN_LIMIT = { max: 8, windowMs: 15 * 60 * 1000 };
const SIGNUP_LIMIT = { max: 5, windowMs: 60 * 60 * 1000 };
const UNITS = ["pcs", "kg", "g", "L", "ml", "packet", "dozen", "bottle", "box", "sack"];
const CATEGORIES = ["Grocery", "Dairy", "Beverages", "Snacks", "Household", "Personal care", "Stationery", "Other"];
const PO_STATUSES = ["draft", "sent", "received", "cancelled"];
const DEMO = {
  shopId: "shop-demo",
  owner: { id: "usr-demo-owner", email: "owner@demo.invalid", password: "demo-owner-2026", name: "Demo Owner" },
  staff: { id: "usr-demo-staff", email: "staff@demo.invalid", password: "demo-staff-2026", name: "Demo Counter Staff" },
  admin: { id: "usr-demo-admin", email: "admin@demo.invalid", password: "demo-admin-2026", name: "Demo Admin" },
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS shops (
     id TEXT PRIMARY KEY, name TEXT NOT NULL,
     plan TEXT NOT NULL CHECK (plan IN ('free','shop')),
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY, shop_id TEXT,
     name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
     role TEXT NOT NULL CHECK (role IN ('owner','staff','admin')),
     pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
     CHECK ((role = 'admin' AND shop_id IS NULL) OR (role <> 'admin' AND shop_id IS NOT NULL)))`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
     key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS suppliers (
     id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, name TEXT NOT NULL,
     contact_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
     email TEXT NOT NULL DEFAULT '', is_sample INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS products (
     id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, name TEXT NOT NULL,
     name_np TEXT NOT NULL DEFAULT '', sku TEXT,
     category TEXT NOT NULL, unit TEXT NOT NULL,
     reorder_level INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
     reorder_qty INTEGER NOT NULL DEFAULT 0 CHECK (reorder_qty >= 0),
     supplier_id TEXT,
     on_hand INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
     is_sample INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     UNIQUE (shop_id, sku))`,
  `CREATE TABLE IF NOT EXISTS stock_movements (
     id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, product_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('OPENING','IN','OUT','COUNT','RECEIPT')),
     delta INTEGER NOT NULL CHECK (delta <> 0),
     balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
     ref_id TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
     actor_id TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS purchase_orders (
     id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, po_no INTEGER NOT NULL,
     supplier_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('draft','sent','received','cancelled')),
     note TEXT NOT NULL DEFAULT '', receive_token TEXT NOT NULL DEFAULT '',
     created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     received_at INTEGER, UNIQUE (shop_id, po_no))`,
  `CREATE TABLE IF NOT EXISTS po_lines (
     id TEXT PRIMARY KEY, po_id TEXT NOT NULL, product_id TEXT NOT NULL,
     qty INTEGER NOT NULL CHECK (qty > 0),
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plan_interest (
     id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, user_id TEXT NOT NULL,
     plan TEXT NOT NULL CHECK (plan IN ('shop')), created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id TEXT PRIMARY KEY, shop_id TEXT, actor_id TEXT,
     action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
];

const schemaReady = new WeakSet();

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function randomHex(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToB64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}

async function verifyPassword(password, stored) {
  const [scheme, iterText, saltB64, hashB64] = String(stored || "").split("$");
  if (scheme !== "pbkdf2-sha256" || !iterText || !saltB64 || !hashB64) return false;
  const expected = b64ToBytes(hashB64);
  const actual = await derive(password, b64ToBytes(saltB64), Number(iterText));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

// Nepal Time wall clock as an ISO-like string (UTC+05:45, no daylight saving).
function nptIso(ms) {
  return new Date(ms + NPT_OFFSET_MS).toISOString();
}

function fmtDateTime(ms) {
  const iso = nptIso(ms);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function dayWindow(dayText) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayText || "");
  const base = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : Math.floor((Date.now() + NPT_OFFSET_MS) / 86400000) * 86400000;
  const start = base - NPT_OFFSET_MS;
  return { start, end: start + 86400000, day: nptIso(start).slice(0, 10) };
}

function clean(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function parseInteger(value, min, max) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

function isEmail(value) {
  return value.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function statusOf(product) {
  if (product.on_hand <= 0) return { cls: "tag-out", label: "Out of stock" };
  if (product.on_hand <= product.reorder_level) return { cls: "tag-low", label: "Low stock" };
  return { cls: "tag-ok", label: "In stock" };
}

function isUniqueError(err) { return /UNIQUE constraint failed/i.test(String(err?.message || err)); }
function isCheckError(err) { return /CHECK constraint failed/i.test(String(err?.message || err)); }

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------- database access ----------

async function ensureSchema(db) {
  if (schemaReady.has(db)) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  await seedDemo(db);
  schemaReady.add(db);
}

let demoHashCache = null;
async function demoHashes() {
  if (!demoHashCache) {
    demoHashCache = {
      owner: await hashPassword(DEMO.owner.password),
      staff: await hashPassword(DEMO.staff.password),
      admin: await hashPassword(DEMO.admin.password),
    };
  }
  return demoHashCache;
}

// Illustrative items: names, units, reorder levels and counts are invented for the demo.
const SAMPLE_PRODUCTS = [
  ["Basmati rice (illustrative)", "SAMPLE-RICE", "Grocery", "kg", 12, 40, 30],
  ["Mustard oil 1 L (illustrative)", "SAMPLE-OIL", "Grocery", "L", 6, 24, 18],
  ["Sugar (illustrative)", "SAMPLE-SUGAR", "Grocery", "kg", 8, 30, 5],
  ["Red lentils (illustrative)", "SAMPLE-DAL", "Grocery", "kg", 10, 30, 22],
  ["Milk pouch 500 ml (illustrative)", "SAMPLE-MILK", "Dairy", "pcs", 10, 40, 4],
  ["Chiura, flattened rice (illustrative)", "SAMPLE-CHIURA", "Grocery", "packet", 6, 20, 9],
  ["Cola can 330 ml (illustrative)", "SAMPLE-COLA", "Beverages", "pcs", 12, 48, 0],
  ["Biscuit pack (illustrative)", "SAMPLE-BISCUIT", "Snacks", "packet", 10, 36, 14],
  ["Washing soap bar (illustrative)", "SAMPLE-SOAP", "Household", "pcs", 8, 24, 3],
  ["Notebook A4 (illustrative)", "SAMPLE-NOTE", "Stationery", "pcs", 5, 20, 26],
];

async function seedDemo(db) {
  const existing = await db.prepare("SELECT id FROM shops WHERE id = ?").bind(DEMO.shopId).first();
  if (existing) return;
  const now = Date.now();
  const h = await demoHashes();
  await db.batch([
    db.prepare("INSERT INTO shops (id, name, plan, created_at) VALUES (?, ?, 'free', ?)")
      .bind(DEMO.shopId, "Demo Kirana (illustrative shop)", now),
    db.prepare("INSERT INTO users (id, shop_id, name, email, role, pw_hash, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)")
      .bind(DEMO.owner.id, DEMO.shopId, DEMO.owner.name, DEMO.owner.email, h.owner, now),
    db.prepare("INSERT INTO users (id, shop_id, name, email, role, pw_hash, created_at) VALUES (?, ?, ?, ?, 'staff', ?, ?)")
      .bind(DEMO.staff.id, DEMO.shopId, DEMO.staff.name, DEMO.staff.email, h.staff, now),
    db.prepare("INSERT INTO users (id, shop_id, name, email, role, pw_hash, created_at) VALUES (?, NULL, ?, ?, 'admin', ?, ?)")
      .bind(DEMO.admin.id, DEMO.admin.name, DEMO.admin.email, h.admin, now),
    db.prepare("INSERT INTO suppliers (id, shop_id, name, contact_name, is_sample, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .bind("sup-sample-1", DEMO.shopId, "Sample wholesaler A (illustrative)", "Sample contact", now),
    db.prepare("INSERT INTO suppliers (id, shop_id, name, contact_name, is_sample, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .bind("sup-sample-2", DEMO.shopId, "Sample distributor B (illustrative)", "Sample contact", now),
  ]);
  for (let i = 0; i < SAMPLE_PRODUCTS.length; i++) {
    const [name, sku, category, unit, reorderLevel, reorderQty, onHand] = SAMPLE_PRODUCTS[i];
    const id = `prd-sample-${i + 1}`;
    const supplier = i % 2 === 0 ? "sup-sample-1" : "sup-sample-2";
    const batch = [
      db.prepare(`INSERT INTO products (id, shop_id, name, sku, category, unit, reorder_level, reorder_qty,
                    supplier_id, on_hand, is_sample, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(id, DEMO.shopId, name, sku, category, unit, reorderLevel, reorderQty, supplier, onHand, now, now),
    ];
    if (onHand > 0) {
      batch.push(db.prepare(`INSERT INTO stock_movements (id, shop_id, product_id, kind, delta, balance_after, note, actor_id, created_at)
                             VALUES (?, ?, ?, 'OPENING', ?, ?, 'Illustrative opening count', ?, ?)`)
        .bind(`mov-sample-${i + 1}`, DEMO.shopId, id, onHand, onHand, DEMO.owner.id, now));
    }
    await db.batch(batch);
  }
}

async function currentUser(db, request) {
  const token = parseCookies(request.headers.get("cookie")).ps_session;
  if (!token) return null;
  const row = await db.prepare(
    `SELECT u.id, u.shop_id, u.name, u.email, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).bind(await sha256Hex(token)).first();
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

async function startSession(db, userId) {
  const token = randomToken(32);
  const now = Date.now();
  await db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now, now + SESSION_MS).run();
  return token;
}

async function audit(db, shopId, actorId, action, detail) {
  await db.prepare("INSERT INTO audit_log (id, shop_id, actor_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(randomHex(12), shopId ?? null, actorId ?? null, action, clean(detail, 200), Date.now()).run();
}

async function rateLimited(db, key, limit) {
  const now = Date.now();
  const row = await db.prepare("SELECT count, window_start FROM rate_limits WHERE key = ?").bind(key).first();
  if (!row || now - row.window_start > limit.windowMs) {
    await db.prepare(`INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
                      ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start`).bind(key, now).run();
    return false;
  }
  if (row.count >= limit.max) return true;
  await db.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").bind(key).run();
  return false;
}

function accountLimitFor(plan) { return plan === "shop" ? SHOP_ACCOUNT_LIMIT : FREE_ACCOUNT_LIMIT; }
function productLimitFor(plan) { return plan === "shop" ? Number.MAX_SAFE_INTEGER : FREE_PRODUCT_LIMIT; }

async function countRows(db, sql, ...args) {
  const row = await db.prepare(sql).bind(...args).first();
  return row ? Number(Object.values(row)[0]) : 0;
}

async function loadShop(db, shopId) {
  return db.prepare("SELECT id, name, plan, created_at FROM shops WHERE id = ?").bind(shopId).first();
}

async function loadProduct(db, shopId, productId) {
  return db.prepare(
    `SELECT p.*, s.name AS supplier_name FROM products p
       LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.shop_id = p.shop_id
      WHERE p.id = ? AND p.shop_id = ?`
  ).bind(productId, shopId).first();
}

async function listProducts(db, shopId, q, lowOnly) {
  const like = `%${q.replace(/[%_]/g, "")}%`;
  return (await db.prepare(
    `SELECT p.*, s.name AS supplier_name FROM products p
       LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.shop_id = p.shop_id
      WHERE p.shop_id = ? AND (? = '' OR p.name LIKE ? OR p.sku LIKE ? OR p.category LIKE ?)
        AND (? = 0 OR p.on_hand <= p.reorder_level)
      ORDER BY (p.on_hand <= p.reorder_level) DESC, p.name COLLATE NOCASE LIMIT 300`
  ).bind(shopId, q, like, like, like, lowOnly ? 1 : 0).all()).results;
}

async function lowStock(db, shopId) {
  return (await db.prepare(
    `SELECT p.*, s.name AS supplier_name FROM products p
       LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.shop_id = p.shop_id
      WHERE p.shop_id = ? AND p.on_hand <= p.reorder_level
      ORDER BY (p.on_hand * 1.0 / MAX(p.reorder_level, 1)) ASC, p.name COLLATE NOCASE`
  ).bind(shopId).all()).results;
}

async function movementsBetween(db, shopId, start, end, productId = null, limit = 500) {
  return (await db.prepare(
    `SELECT m.*, p.name AS product_name, p.unit AS product_unit, u.name AS actor_name
       FROM stock_movements m JOIN products p ON p.id = m.product_id
       LEFT JOIN users u ON u.id = m.actor_id
      WHERE m.shop_id = ? AND m.created_at >= ? AND m.created_at < ? AND (? IS NULL OR m.product_id = ?)
      ORDER BY m.created_at DESC, m.id DESC LIMIT ?`
  ).bind(shopId, start, end, productId, productId, limit).all()).results;
}

async function listSuppliers(db, shopId) {
  return (await db.prepare("SELECT * FROM suppliers WHERE shop_id = ? ORDER BY name COLLATE NOCASE").bind(shopId).all()).results;
}

async function listOrders(db, shopId, status) {
  return (await db.prepare(
    `SELECT po.*, s.name AS supplier_name,
            (SELECT COUNT(*) FROM po_lines l WHERE l.po_id = po.id) AS line_count
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.shop_id = ? AND (? = '' OR po.status = ?) ORDER BY po.po_no DESC LIMIT 200`
  ).bind(shopId, status, status).all()).results;
}

async function loadOrder(db, shopId, orderId) {
  const po = await db.prepare(
    `SELECT po.*, s.name AS supplier_name FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ? AND po.shop_id = ?`
  ).bind(orderId, shopId).first();
  if (!po) return null;
  const lines = (await db.prepare(
    `SELECT l.*, p.name AS product_name, p.unit AS product_unit, p.on_hand AS product_on_hand
       FROM po_lines l JOIN products p ON p.id = l.product_id WHERE l.po_id = ? ORDER BY p.name COLLATE NOCASE`
  ).bind(orderId).all()).results;
  return { po, lines };
}

// ---------- HTTP plumbing ----------

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Frame-Options": "DENY",
};

function htmlResponse(status, body, cookies = []) {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(body, { status, headers });
}

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", ...SECURITY_HEADERS });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
}

function cookieString(name, value, { maxAge, httpOnly = true, sameSite = "Lax" } = {}) {
  let s = `${name}=${value}; Path=/; Secure; SameSite=${sameSite}`;
  if (httpOnly) s += "; HttpOnly";
  if (maxAge !== undefined) s += `; Max-Age=${maxAge}`;
  return s;
}

function flashCookie(kind, message) {
  return cookieString("ps_flash", encodeURIComponent(`${kind}|${message}`), { maxAge: 60 });
}

function readFlash(request) {
  const raw = parseCookies(request.headers.get("cookie")).ps_flash;
  if (!raw) return null;
  const text = decodeURIComponent(raw);
  const i = text.indexOf("|");
  return i > 0 ? { kind: text.slice(0, i), message: text.slice(i + 1) } : null;
}

async function readForm(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "That form is too large.");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "That form is too large.");
  return new URLSearchParams(text);
}

function checkCsrf(request, form, url) {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "This request came from another site and was refused.");
  const cookie = parseCookies(request.headers.get("cookie")).ps_csrf;
  const token = form.get("_csrf") || "";
  if (!cookie || cookie.length < 16 || token !== cookie) throw new HttpError(403, "Your form expired. Reload the page and try again.");
}

function ensureCsrf(request) {
  const existing = parseCookies(request.headers.get("cookie")).ps_csrf;
  if (existing && existing.length >= 16) return { token: existing, cookies: [] };
  const token = randomHex(24);
  return { token, cookies: [cookieString("ps_csrf", token, { httpOnly: false, sameSite: "Strict" })] };
}

// ---------- layout ----------

const ICON_IDS = new Set(["bin", "in", "out", "tag", "order", "ledger", "shop", "gear", "user", "alert", "shelf"]);

function icon(name) {
  const id = ICON_IDS.has(name) ? name : "bin";
  return `<svg class="ic" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-${id}"/></svg>`;
}

function brandMark() {
  return `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect x="4" y="4" width="24" height="24"/><path d="M10 12h12M10 17h8M10 22h10"/></svg>`;
}

function csrfField(csrf) {
  return `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
}

function postButton(action, csrf, label, cls = "btn btn-quiet", confirmText = "") {
  return `<form method="post" action="${esc(action)}" class="inline"${confirmText ? ` data-confirm="${esc(confirmText)}"` : ""}>${csrfField(csrf)}<button class="${cls}" type="submit">${esc(label)}</button></form>`;
}

function flashHtml(flash) {
  if (!flash) return "";
  const kind = ["ok", "warn", "err"].includes(flash.kind) ? flash.kind : "ok";
  return `<div class="flash flash-${kind}" role="status">${esc(flash.message)}</div>`;
}

function appNav(user, active) {
  const items = [
    ["/app", "overview", "Overview", "shelf"],
    ["/app/products", "products", "Items", "bin"],
    ["/app/movements", "movements", "Daily log", "ledger"],
    ["/app/alerts", "alerts", "Reorder", "alert"],
    ["/app/orders", "orders", "Orders", "order"],
  ];
  if (user.role === "owner") items.push(["/app/suppliers", "suppliers", "Suppliers", "user"], ["/app/settings", "settings", "Settings", "gear"]);
  if (user.role === "admin") items.push(["/admin", "admin", "Admin", "shop"]);
  return items.map(([href, key, label, ic]) =>
    `<a class="navlink${active === key ? " is-active" : ""}" href="${href}"${active === key ? ' aria-current="page"' : ""}>${icon(ic)}<span>${esc(label)}</span></a>`
  ).join("");
}

function shell({ title, body, user = null, active = "", csrf, flash = null, description = "" }) {
  const roleLabel = user ? { owner: "Owner", staff: "Counter staff", admin: "Platform admin" }[user.role] : "";
  const header = user
    ? `<header class="appbar"><a class="brand" href="/app">${brandMark()}<span>Pasal Stock</span></a>
         <span class="rolechip">${esc(roleLabel)}</span>
         ${postButton("/logout", csrf, "Log out")}
       </header>
       <nav class="sidenav" aria-label="Main">${appNav(user, active)}</nav>`
    : `<header class="sitebar"><a class="brand" href="/">${brandMark()}<span>Pasal Stock</span></a>
         <nav class="sitenav" aria-label="Site"><a href="/#how">How it works</a><a href="/#plans">Plans</a><a href="/login">Log in</a></nav>
       </header>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Pasal Stock</title>
<meta name="description" content="${esc(description || "Stock in and out, reorder levels, low-stock alerts and supplier purchase orders for a small shop. Demo only.")}">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
</head>
<body class="${user ? "is-app" : "is-site"}">
<a class="skip" href="#main">Skip to content</a>
${header}
<main id="main" tabindex="-1">
${flashHtml(flash)}
${body}
</main>
<footer class="foot">
<p class="demo-note">Demo only. Made-up shops, illustrative items, no real stock, prices or customers. No payment is taken.</p>
<nav aria-label="Legal"><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/">Home</a></nav>
</footer>
</body>
</html>`;
}

function sel(name, options, current, id = name) {
  return `<select name="${name}" id="${id}">${options.map((o) => `<option value="${esc(o)}"${o === current ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
}

// ---------- public pages ----------

function homePage(csrf) {
  const body = `
<section class="hero" aria-labelledby="hero-title">
  <div class="hero-copy">
    <p class="eyebrow">Stock, reorder and purchase orders for a small shop</p>
    <h1 id="hero-title">Know the shelf before it runs empty.</h1>
    <p class="lead">Record what comes in and goes out, see which items are close to their reorder level, and turn that list into a purchase order for your supplier. Built for a counter that runs on a notebook today.</p>
    <div class="cta-row">
      ${postButton("/demo", csrf, "Open the demo shop", "btn btn-primary")}
      <a class="btn btn-quiet" href="/signup">Create a free shop</a>
    </div>
    <p class="fine">The demo shop is illustrative. Nothing in it is a real shop, supplier or price.</p>
  </div>
  <figure class="specimen" data-reveal>
    <figcaption><span class="tag-illus">Illustrative</span> Bin card, sample item</figcaption>
    <div class="bincard">
      <div class="bincard-head"><span>Bin B-07</span><strong>Basmati rice (illustrative)</strong><span>Unit kg · reorder at 12</span></div>
      <table>
        <thead><tr><th>Date</th><th>Ref</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th></tr></thead>
        <tbody>
          <tr><td>Nov 08</td><td>PO-0014</td><td class="num">25</td><td class="num"></td><td class="num">40</td></tr>
          <tr><td>Nov 09</td><td>Counter</td><td class="num"></td><td class="num">6</td><td class="num">34</td></tr>
          <tr><td>Nov 10</td><td>Counter</td><td class="num"></td><td class="num">9</td><td class="num">25</td></tr>
          <tr><td>Nov 11</td><td>Counter</td><td class="num"></td><td class="num">13</td><td class="num is-low">12</td></tr>
        </tbody>
      </table>
      <p class="stamp">Reorder now</p>
    </div>
  </figure>
</section>

<section class="ruled" id="how" aria-labelledby="how-title">
  <header class="sec-head"><p class="sec-no">01</p><h2 id="how-title">How the counter works</h2></header>
  <ol class="steps">
    <li data-reveal><span class="step-no">a</span><div><h3>Count in and out</h3><p>Every receipt, sale or correction is one line in the daily log, with the balance after it. A sale that would take the shelf below zero is refused.</p></div></li>
    <li data-reveal><span class="step-no">b</span><div><h3>Set a reorder level for each item</h3><p>Each item has its own minimum and the quantity you usually order. The reorder list updates as stock moves.</p></div></li>
    <li data-reveal><span class="step-no">c</span><div><h3>Raise a purchase order</h3><p>Pick the low items, choose the supplier, and mark the order sent. Receiving it adds the quantities to the shelf once, and only once.</p></div></li>
    <li data-reveal><span class="step-no">d</span><div><h3>Keep the owner in the loop</h3><p>The overview shows what is out, what is low and what is still on order. Counter staff record the counter; the owner sets items, suppliers and orders.</p></div></li>
  </ol>
</section>

<section class="ruled alt" id="plans" aria-labelledby="plans-title">
  <header class="sec-head"><p class="sec-no">02</p><h2 id="plans-title">Plans</h2></header>
  <div class="plans">
    <article class="plan" data-reveal>
      <h3>Free</h3>
      <p class="plan-state">For one counter</p>
      <ul class="plain">
        <li>One shop, up to ${FREE_PRODUCT_LIMIT} items</li>
        <li>Up to ${FREE_ACCOUNT_LIMIT} accounts: the owner and one counter staff</li>
        <li>Daily log, reorder list and purchase orders</li>
      </ul>
    </article>
    <article class="plan plan-shop" data-reveal>
      <h3>Shop</h3>
      <p class="plan-state">For more items and more hands</p>
      <ul class="plain">
        <li>Items without a fixed limit</li>
        <li>Up to ${SHOP_ACCOUNT_LIMIT} accounts</li>
        <li>Price to be confirmed before launch. Nothing is charged in this demo.</li>
      </ul>
      <p class="fine">Asking about Shop records your interest only.</p>
    </article>
  </div>
</section>`;
  return shell({ title: "Stock and reorder for small shops", body, csrf, description: "Demo of stock in and out, reorder levels, low-stock alerts and supplier purchase orders for a small shop in Nepal." });
}

function loginPage(csrf, { error = "", email = "" } = {}) {
  const body = `
<section class="narrow">
  <header class="page-head"><p class="eyebrow">Log in</p><h1>Open your shop</h1></header>
  ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ""}
  <form method="post" action="/login" class="form stack">
    ${csrfField(csrf)}
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required maxlength="120" value="${esc(email)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200">
    <button class="btn btn-primary" type="submit">Log in</button>
  </form>
  <aside class="demo-accounts" aria-labelledby="demo-title">
    <h2 id="demo-title">Demo accounts</h2>
    <p class="fine">Made-up accounts for this demo only.</p>
    <dl>
      <dt>Owner</dt><dd>${esc(DEMO.owner.email)} · ${esc(DEMO.owner.password)}</dd>
      <dt>Counter staff</dt><dd>${esc(DEMO.staff.email)} · ${esc(DEMO.staff.password)}</dd>
      <dt>Platform admin</dt><dd>${esc(DEMO.admin.email)} · ${esc(DEMO.admin.password)}</dd>
    </dl>
    ${postButton("/demo", csrf, "Open as the demo owner")}
  </aside>
</section>`;
  return shell({ title: "Log in", body, csrf });
}

function signupPage(csrf, { error = "", values = {} } = {}) {
  const body = `
<section class="narrow">
  <header class="page-head"><p class="eyebrow">Free plan</p><h1>Create a shop</h1></header>
  ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ""}
  <form method="post" action="/signup" class="form stack">
    ${csrfField(csrf)}
    <label for="shop_name">Shop name</label>
    <input id="shop_name" name="shop_name" required maxlength="80" value="${esc(values.shop_name || "")}">
    <label for="name">Your name</label>
    <input id="name" name="name" required maxlength="60" autocomplete="name" value="${esc(values.name || "")}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required maxlength="120" autocomplete="email" value="${esc(values.email || "")}">
    <label for="password">Password (at least 10 characters)</label>
    <input id="password" name="password" type="password" required minlength="10" maxlength="200" autocomplete="new-password">
    <button class="btn btn-primary" type="submit">Create shop</button>
  </form>
  <p class="fine">This is a demo. The shop and its data live in the demo database only.</p>
</section>`;
  return shell({ title: "Create a shop", body, csrf });
}

function legalPage(kind, csrf) {
  const terms = kind === "terms";
  const body = terms ? `
<article class="legal">
  <header class="page-head"><p class="eyebrow">Terms</p><h1>Terms of use</h1></header>
  <p>Pasal Stock is a demonstration. It is not a finished commercial service, it takes no payment, and it is not an accounting, tax or invoicing system.</p>
  <h2>Demo data</h2>
  <p>Shops, people, suppliers and stock in the demo are made up or illustrative. Items marked illustrative are sample items, and their quantities are not real counts.</p>
  <h2>Accounts you create</h2>
  <p>Use a password you do not use anywhere else. Do not enter real customer data, bank or card details, or other people's personal information.</p>
  <h2>Availability</h2>
  <p>The demo can be reset, changed or taken down at any time, without notice. It is not guaranteed to keep its data.</p>
  <h2>Use for decisions</h2>
  <p>The demo is provided as it is. Do not rely on it to run a real business or to make purchasing decisions.</p>
  <p class="fine">Last updated 12 November 2026.</p>
</article>` : `
<article class="legal">
  <header class="page-head"><p class="eyebrow">Privacy</p><h1>Privacy notice</h1></header>
  <p>This notice describes what the demo stores and why.</p>
  <h2>What is stored</h2>
  <p>Your name, email address, a salted password hash, the shop name, the items and suppliers you enter, stock movements, purchase orders, and a short audit record of sign-ins and sensitive changes.</p>
  <h2>What is not stored</h2>
  <p>Plain passwords, payment card details, bank or wallet details. No payment is taken.</p>
  <h2>Why it is stored</h2>
  <p>To let you sign in, keep stock counts and orders consistent, and show what happened and when.</p>
  <h2>Who can see it</h2>
  <p>Staff of a shop see that shop's records within their role. The platform admin can see shop names, counts and the audit record. Nothing is sold or shared.</p>
  <h2>Cookies</h2>
  <p>One session cookie keeps you signed in, and one form cookie protects forms against requests from other sites. Both are needed for the app to work. There is no advertising or tracking cookie.</p>
  <h2>Deleting data</h2>
  <p>Ask the person who shared this demo with you to remove an account. Demo data is also removed when the demo is reset.</p>
  <p class="fine">Last updated 12 November 2026.</p>
</article>`;
  return shell({ title: terms ? "Terms" : "Privacy", body, csrf });
}

function notFoundPage(csrf, user = null) {
  return shell({
    title: "Page not found", user, csrf,
    body: `<section class="narrow"><header class="page-head"><p class="eyebrow">404</p><h1>That shelf is empty.</h1></header>
      <p>The page you asked for is not here. <a href="${user ? "/app" : "/"}">Go back to ${user ? "the overview" : "the start"}</a>.</p></section>`,
  });
}

function forbiddenPage(csrf, user) {
  return shell({
    title: "Not allowed", user, csrf,
    body: `<section class="narrow"><header class="page-head"><p class="eyebrow">403</p><h1>Your role does not open this page.</h1></header>
      <p>Counter staff record stock and receive orders. The owner sets items, suppliers, orders and settings. <a href="/app">Back to the overview</a>.</p></section>`,
  });
}

// ---------- app pages ----------

function stockTag(product) {
  const s = statusOf(product);
  return `<span class="${s.cls}">${esc(s.label)}</span>`;
}

function overviewPage(user, csrf, stats, lows, recent, flash) {
  const lowRows = lows.slice(0, 8).map((p) => `
    <li class="tagrow">
      <a href="/app/products/${esc(p.id)}"><span class="tag-hole" aria-hidden="true"></span>${esc(p.name)}</a>
      <span class="qty">${p.on_hand} of ${p.reorder_level} ${esc(p.unit)}</span>
    </li>`).join("");
  const moveRows = recent.map((m) => `
    <tr><td>${esc(fmtDateTime(m.created_at).slice(11))}</td><td><a href="/app/products/${esc(m.product_id)}">${esc(m.product_name)}</a></td>
    <td>${esc(m.kind)}</td><td class="num">${m.delta > 0 ? "+" : ""}${m.delta}</td><td class="num">${m.balance_after}</td></tr>`).join("");
  const body = `
<section class="page">
  <header class="page-head split">
    <div><p class="eyebrow">${user.role === "owner" ? "Owner view" : "Counter view"}</p><h1>Overview</h1></div>
    <div class="actions">
      <a class="btn btn-quiet" href="/app/products">Items</a>
      ${user.role === "owner" ? `<a class="btn btn-primary" href="/app/orders/new">New purchase order</a>` : ""}
    </div>
  </header>
  <dl class="figures">
    <div><dt>Items</dt><dd>${stats.products}</dd></div>
    <div><dt>Low or out</dt><dd class="${stats.low ? "is-low" : ""}">${stats.low}</dd></div>
    <div><dt>Moves today</dt><dd>${stats.today}</dd></div>
    <div><dt>Open orders</dt><dd>${stats.open}</dd></div>
  </dl>
  <div class="two-col">
    <section class="block" aria-labelledby="reorder-title">
      <header class="block-head"><h2 id="reorder-title">Reorder now</h2><a href="/app/alerts">All alerts</a></header>
      ${lows.length ? `<ol class="tagrows">${lowRows}</ol>` : `<p class="empty">Nothing is at or below its reorder level right now.</p>`}
    </section>
    <section class="block" aria-labelledby="recent-title">
      <header class="block-head"><h2 id="recent-title">Latest movements</h2><a href="/app/movements">Daily log</a></header>
      ${recent.length ? `<div class="table-scroll" tabindex="0"><table class="ruled-table"><thead><tr><th>Time</th><th>Item</th><th>Kind</th><th class="num">Change</th><th class="num">Balance</th></tr></thead><tbody>${moveRows}</tbody></table></div>` : `<p class="empty">No movements yet. Record a receipt or a sale from any item.</p>`}
    </section>
  </div>
</section>`;
  return shell({ title: "Overview", user, active: "overview", csrf, body, flash });
}

function productsPage(user, csrf, rows, q, lowOnly, flash) {
  const body = `
<section class="page">
  <header class="page-head split">
    <div><p class="eyebrow">${rows.length} shown</p><h1>Items</h1></div>
    ${user.role === "owner" ? `<a class="btn btn-primary" href="/app/products/new">Add item</a>` : ""}
  </header>
  <form class="filterbar" method="get" action="/app/products" role="search">
    <label for="q" class="visually-hidden">Search items</label>
    <input id="q" name="q" type="search" value="${esc(q)}" maxlength="60" placeholder="Search name, code or category">
    <label class="check"><input type="checkbox" name="low" value="1"${lowOnly ? " checked" : ""}> Low or out only</label>
    <button class="btn btn-quiet" type="submit">Filter</button>
  </form>
  ${rows.length ? `<div class="table-scroll" tabindex="0"><table class="ruled-table">
    <thead><tr><th>Item</th><th>Category</th><th class="num">On hand</th><th class="num">Reorder at</th><th>Status</th></tr></thead>
    <tbody>${rows.map((p) => `<tr>
        <td><a href="/app/products/${esc(p.id)}">${esc(p.name)}</a>${p.is_sample ? ` <span class="tag-illus">Illustrative</span>` : ""}${p.sku ? ` <span class="sku">${esc(p.sku)}</span>` : ""}</td>
        <td>${esc(p.category)}</td>
        <td class="num">${p.on_hand} ${esc(p.unit)}</td>
        <td class="num">${p.reorder_level}</td>
        <td>${stockTag(p)}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="empty">No items match this search.${user.role === "owner" ? ` <a href="/app/products/new">Add an item</a>.` : ""}</p>`}
</section>`;
  return shell({ title: "Items", user, active: "products", csrf, body, flash });
}

function productFields(v, suppliers, isNew) {
  return `
    <div class="grid-2">
      <div><label for="name">Item name</label><input id="name" name="name" required maxlength="80" value="${esc(v.name || "")}"></div>
      <div><label for="name_np">Name in Nepali (optional)</label><input id="name_np" name="name_np" maxlength="80" value="${esc(v.name_np || "")}"></div>
      <div><label for="sku">Item code (optional)</label><input id="sku" name="sku" maxlength="40" value="${esc(v.sku || "")}"></div>
      <div><label for="category">Category</label>${sel("category", CATEGORIES, v.category || "Grocery")}</div>
      <div><label for="unit">Unit</label>${sel("unit", UNITS, v.unit || "pcs")}</div>
      <div><label for="supplier_id">Usual supplier</label>
        <select id="supplier_id" name="supplier_id"><option value="">None yet</option>${suppliers.map((s) => `<option value="${esc(s.id)}"${s.id === v.supplier_id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>
      <div><label for="reorder_level">Reorder when on hand is at or below</label><input id="reorder_level" name="reorder_level" type="number" min="0" max="100000" required inputmode="numeric" value="${esc(v.reorder_level ?? 0)}"></div>
      <div><label for="reorder_qty">Usual order quantity</label><input id="reorder_qty" name="reorder_qty" type="number" min="0" max="100000" required inputmode="numeric" value="${esc(v.reorder_qty ?? 0)}"></div>
      ${isNew ? `<div><label for="opening">Opening count</label><input id="opening" name="opening" type="number" min="0" max="100000" inputmode="numeric" value="0"></div>` : ""}
    </div>`;
}

function productNewPage(user, csrf, suppliers, values, error = "", flash = null) {
  const body = `
<section class="page narrow-wide">
  <header class="page-head"><p class="eyebrow">New item</p><h1>Add an item</h1></header>
  ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ""}
  <form method="post" action="/app/products" class="form">${csrfField(csrf)}${productFields(values, suppliers, true)}
    <button class="btn btn-primary" type="submit">Save item</button> <a href="/app/products">Cancel</a>
  </form>
</section>`;
  return shell({ title: "Add item", user, active: "products", csrf, body, flash });
}

function productDetailPage(user, csrf, product, suppliers, movements, flash) {
  const s = statusOf(product);
  const bin = movements.slice(0, 40).map((m) => `
    <tr><td>${esc(fmtDateTime(m.created_at))}</td><td>${esc(m.kind)}${m.note ? ` · ${esc(m.note)}` : ""}</td>
    <td class="num">${m.delta > 0 ? m.delta : ""}</td><td class="num">${m.delta < 0 ? -m.delta : ""}</td><td class="num">${m.balance_after}</td><td>${esc(m.actor_name || "")}</td></tr>`).join("");
  const gaugePct = product.reorder_level > 0 ? Math.min(100, Math.round((product.on_hand / (product.reorder_level * 3)) * 100)) : 100;
  const body = `
<section class="page">
  <header class="page-head split">
    <div>
      <p class="eyebrow">${esc(product.category)} · ${esc(product.unit)}${product.sku ? ` · ${esc(product.sku)}` : ""}</p>
      <h1>${esc(product.name)}</h1>
      ${product.name_np ? `<p class="np">${esc(product.name_np)}</p>` : ""}
      ${product.is_sample ? `<p><span class="tag-illus">Illustrative sample item</span></p>` : ""}
    </div>
    <div class="stock-read">
      <span class="${s.cls}">${esc(s.label)}</span>
      <p class="big-num">${product.on_hand}<span> ${esc(product.unit)}</span></p>
      <p class="fine">Reorder at ${product.reorder_level} · usual order ${product.reorder_qty}${product.supplier_name ? ` · ${esc(product.supplier_name)}` : ""}</p>
      <div class="gauge" role="img" aria-label="${product.on_hand} on hand against a reorder level of ${product.reorder_level}"><span data-fill="${gaugePct}"></span></div>
    </div>
  </header>
  <div class="two-col">
    <section class="block" aria-labelledby="move-title">
      <header class="block-head"><h2 id="move-title">Record a movement</h2></header>
      <form method="post" action="/app/products/${esc(product.id)}/move" class="form stack">
        ${csrfField(csrf)}
        <fieldset class="segmented">
          <legend>Kind</legend>
          <label><input type="radio" name="kind" value="IN" checked> Stock in</label>
          <label><input type="radio" name="kind" value="OUT"> Stock out</label>
          <label><input type="radio" name="kind" value="COUNT"> Counted total</label>
        </fieldset>
        <label for="qty">Quantity (stock in or out), or the counted total</label>
        <input id="qty" name="qty" type="number" min="0" max="100000" required inputmode="numeric">
        <label for="note">Note (optional)</label>
        <input id="note" name="note" maxlength="120" placeholder="Sale, damage, delivery from supplier">
        <button class="btn btn-primary" type="submit">Record</button>
      </form>
    </section>
    ${user.role === "owner" ? `
    <section class="block" aria-labelledby="edit-title">
      <header class="block-head"><h2 id="edit-title">Item settings</h2></header>
      <form method="post" action="/app/products/${esc(product.id)}" class="form stack">
        ${csrfField(csrf)}
        ${productFields({ ...product, supplier_id: product.supplier_id || "" }, suppliers, false)}
        <button class="btn btn-quiet" type="submit">Save changes</button>
      </form>
    </section>` : ""}
  </div>
  <section class="block" aria-labelledby="bin-title">
    <header class="block-head"><h2 id="bin-title">Bin card</h2><span class="fine">Newest first, last 40 lines</span></header>
    ${movements.length ? `<div class="table-scroll" tabindex="0"><table class="ruled-table bin">
      <thead><tr><th>When (NPT)</th><th>Kind and note</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th><th>By</th></tr></thead>
      <tbody>${bin}</tbody></table></div>` : `<p class="empty">No movements yet for this item.</p>`}
  </section>
</section>`;
  return shell({ title: product.name, user, active: "products", csrf, body, flash });
}

function movementsPage(user, csrf, day, rows, flash) {
  const body = `
<section class="page">
  <header class="page-head split">
    <div><p class="eyebrow">Nepal Time</p><h1>Daily log</h1></div>
    <form method="get" action="/app/movements" class="filterbar">
      <label for="day">Day</label><input id="day" name="day" type="date" value="${esc(day)}">
      <button class="btn btn-quiet" type="submit">Show day</button>
    </form>
  </header>
  ${rows.length ? `<div class="table-scroll" tabindex="0"><table class="ruled-table">
    <thead><tr><th>Time</th><th>Item</th><th>Kind</th><th class="num">Change</th><th class="num">Balance</th><th>By</th><th>Note</th></tr></thead>
    <tbody>${rows.map((m) => `<tr><td>${esc(fmtDateTime(m.created_at).slice(11))}</td>
      <td><a href="/app/products/${esc(m.product_id)}">${esc(m.product_name)}</a></td><td>${esc(m.kind)}</td>
      <td class="num">${m.delta > 0 ? "+" : ""}${m.delta} ${esc(m.product_unit)}</td><td class="num">${m.balance_after}</td>
      <td>${esc(m.actor_name || "")}</td><td>${esc(m.note)}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="empty">Nothing was recorded on ${esc(day)}.</p>`}
</section>`;
  return shell({ title: "Daily log", user, active: "movements", csrf, body, flash });
}

function alertsPage(user, csrf, lows, flash) {
  const ids = lows.map((p) => p.id).join(",");
  const body = `
<section class="page">
  <header class="page-head split">
    <div><p class="eyebrow">${lows.length} at or below reorder level</p><h1>Reorder</h1></div>
    ${lows.length && user.role === "owner" ? `<a class="btn btn-primary" href="/app/orders/new?products=${esc(ids)}">Start an order with all of them</a>` : ""}
  </header>
  ${lows.length ? `<ol class="tagrows wide">${lows.map((p) => `
    <li class="tagrow">
      <a href="/app/products/${esc(p.id)}"><span class="tag-hole" aria-hidden="true"></span>${esc(p.name)}</a>
      <span class="qty">${p.on_hand} on hand · reorder at ${p.reorder_level} · usual order ${p.reorder_qty} ${esc(p.unit)}</span>
      ${stockTag(p)}
      ${user.role === "owner" ? `<a class="btn btn-quiet small" href="/app/orders/new?products=${esc(p.id)}">Order this</a>` : ""}
    </li>`).join("")}</ol>` : `<p class="empty">No item is at or below its reorder level right now.</p>`}
</section>`;
  return shell({ title: "Reorder", user, active: "alerts", csrf, body, flash });
}

function suppliersPage(user, csrf, rows, flash) {
  const body = `
<section class="page two-col">
  <section class="block" aria-labelledby="sup-list">
    <header class="block-head"><h2 id="sup-list">Suppliers</h2></header>
    ${rows.length ? `<div class="table-scroll" tabindex="0"><table class="ruled-table"><thead><tr><th>Name</th><th>Contact</th><th>Phone</th></tr></thead><tbody>
      ${rows.map((s) => `<tr><td>${esc(s.name)}${s.is_sample ? ` <span class="tag-illus">Illustrative</span>` : ""}</td><td>${esc(s.contact_name)}</td><td>${esc(s.phone)}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="empty">No suppliers yet.</p>`}
  </section>
  <section class="block" aria-labelledby="sup-new">
    <header class="block-head"><h2 id="sup-new">Add a supplier</h2></header>
    <form method="post" action="/app/suppliers" class="form stack">
      ${csrfField(csrf)}
      <label for="name">Supplier name</label><input id="name" name="name" required maxlength="80">
      <label for="contact_name">Contact person (optional)</label><input id="contact_name" name="contact_name" maxlength="60">
      <label for="phone">Phone (optional)</label><input id="phone" name="phone" maxlength="20" inputmode="tel" placeholder="Digits, spaces, + and brackets">
      <label for="email">Email (optional)</label><input id="email" name="email" type="email" maxlength="120">
      <button class="btn btn-primary" type="submit">Save supplier</button>
    </form>
  </section>
</section>`;
  return shell({ title: "Suppliers", user, active: "suppliers", csrf, body, flash });
}

function ordersPage(user, csrf, rows, status, flash) {
  const tabs = ["", "draft", "sent", "received", "cancelled"];
  const body = `
<section class="page">
  <header class="page-head split">
    <div><p class="eyebrow">Supplier purchase orders</p><h1>Orders</h1></div>
    ${user.role === "owner" ? `<a class="btn btn-primary" href="/app/orders/new">New order</a>` : ""}
  </header>
  <nav class="pills" aria-label="Order status">${tabs.map((t) => `<a href="/app/orders${t ? `?status=${t}` : ""}"${t === status ? ' aria-current="page"' : ""}>${t || "All"}</a>`).join("")}</nav>
  ${rows.length ? `<div class="table-scroll" tabindex="0"><table class="ruled-table"><thead><tr><th>Order</th><th>Supplier</th><th>Status</th><th class="num">Lines</th><th>Updated (NPT)</th></tr></thead><tbody>
    ${rows.map((o) => `<tr><td><a href="/app/orders/${esc(o.id)}">PO-${String(o.po_no).padStart(4, "0")}</a></td><td>${esc(o.supplier_name)}</td>
    <td><span class="status status-${esc(o.status)}">${esc(o.status)}</span></td><td class="num">${o.line_count}</td><td>${esc(fmtDateTime(o.updated_at))}</td></tr>`).join("")}
  </tbody></table></div>` : `<p class="empty">No purchase orders in this view.</p>`}
</section>`;
  return shell({ title: "Orders", user, active: "orders", csrf, body, flash });
}

function orderNewPage(user, csrf, suppliers, products, preselect, flash = null) {
  const lineCount = Math.min(10, Math.max(4, preselect.length + 2));
  const rows = Array.from({ length: lineCount }, (_, i) => {
    const p = products.find((x) => x.id === preselect[i]);
    return `<div class="line-row">
      <label class="visually-hidden" for="product_${i}">Item ${i + 1}</label>
      <select id="product_${i}" name="product_id"><option value="">No item</option>${products.map((x) => `<option value="${esc(x.id)}"${p && x.id === p.id ? " selected" : ""}>${esc(x.name)} (${x.on_hand} ${esc(x.unit)} on hand)</option>`).join("")}</select>
      <label class="visually-hidden" for="qty_${i}">Quantity for line ${i + 1}</label>
      <input id="qty_${i}" name="qty" type="number" min="1" max="100000" inputmode="numeric" value="${p ? p.reorder_qty || "" : ""}" placeholder="Qty">
    </div>`;
  }).join("");
  const body = `
<section class="page narrow-wide">
  <header class="page-head"><p class="eyebrow">Purchase order</p><h1>New order</h1></header>
  ${suppliers.length ? `
  <form method="post" action="/app/orders" class="form stack">
    ${csrfField(csrf)}
    <label for="supplier_id">Supplier</label>
    <select id="supplier_id" name="supplier_id" required>${suppliers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select>
    <fieldset class="lines"><legend>Items and quantities (up to ${lineCount} lines)</legend>${rows}</fieldset>
    <label for="note">Note for the order (optional)</label>
    <input id="note" name="note" maxlength="200">
    <p class="fine">The order is saved as a draft. Marking it sent records the date only. Nothing is emailed from this demo.</p>
    <button class="btn btn-primary" type="submit">Save draft</button>
  </form>` : `<p class="empty">Add a supplier first. <a href="/app/suppliers">Suppliers</a></p>`}
</section>`;
  return shell({ title: "New order", user, active: "orders", csrf, body, flash });
}

function orderDetailPage(user, csrf, data, flash) {
  const { po, lines } = data;
  const actions = [];
  if (user.role === "owner" && po.status === "draft") actions.push(postButton(`/app/orders/${po.id}/send`, csrf, "Mark as sent", "btn btn-primary"));
  if (po.status === "sent") actions.push(postButton(`/app/orders/${po.id}/receive`, csrf, "Goods received", "btn btn-primary", "Receive this order? The quantities go onto the shelf once."));
  if (user.role === "owner" && (po.status === "draft" || po.status === "sent")) actions.push(postButton(`/app/orders/${po.id}/cancel`, csrf, "Cancel order", "btn btn-quiet", "Cancel this order?"));
  const body = `
<section class="page">
  <header class="page-head split">
    <div><p class="eyebrow">Purchase order</p><h1>PO-${String(po.po_no).padStart(4, "0")}</h1>
      <p><span class="status status-${esc(po.status)}">${esc(po.status)}</span> to ${esc(po.supplier_name)}</p></div>
    <div class="actions">${actions.join("")}</div>
  </header>
  <div class="two-col">
    <section class="block" aria-labelledby="lines-title">
      <header class="block-head"><h2 id="lines-title">Lines</h2></header>
      <div class="table-scroll" tabindex="0"><table class="ruled-table"><thead><tr><th>Item</th><th class="num">Ordered</th><th class="num">On shelf now</th></tr></thead><tbody>
        ${lines.map((l) => `<tr><td><a href="/app/products/${esc(l.product_id)}">${esc(l.product_name)}</a></td><td class="num">${l.qty} ${esc(l.product_unit)}</td><td class="num">${l.product_on_hand}</td></tr>`).join("")}
      </tbody></table></div>
    </section>
    <section class="block" aria-labelledby="dates-title">
      <header class="block-head"><h2 id="dates-title">Record</h2></header>
      <dl class="facts">
        <dt>Created (NPT)</dt><dd>${esc(fmtDateTime(po.created_at))}</dd>
        <dt>Last change (NPT)</dt><dd>${esc(fmtDateTime(po.updated_at))}</dd>
        <dt>Received (NPT)</dt><dd>${po.received_at ? esc(fmtDateTime(po.received_at)) : "Not yet"}</dd>
        <dt>Note</dt><dd>${po.note ? esc(po.note) : "None"}</dd>
      </dl>
    </section>
  </div>
</section>`;
  return shell({ title: `PO-${po.po_no}`, user, active: "orders", csrf, body, flash });
}

function settingsPage(user, csrf, shop, staff, interested, flash) {
  const limit = accountLimitFor(shop.plan);
  const body = `
<section class="page two-col">
  <section class="block" aria-labelledby="shop-title">
    <header class="block-head"><h2 id="shop-title">Shop</h2></header>
    <form method="post" action="/app/settings" class="form stack">
      ${csrfField(csrf)}
      <label for="shop_name">Shop name</label><input id="shop_name" name="shop_name" required maxlength="80" value="${esc(shop.name)}">
      <button class="btn btn-quiet" type="submit">Save shop name</button>
    </form>
    <h3>Plan</h3>
    <p>${shop.plan === "shop" ? "Shop plan" : "Free plan"}: ${shop.plan === "shop" ? "items without a fixed limit" : `up to ${FREE_PRODUCT_LIMIT} items`}. Accounts in use: ${staff.length} of ${limit}.</p>
    ${shop.plan === "free" ? `${postButton("/app/settings/plan", csrf, "Ask about the Shop plan", "btn btn-quiet")}
    <p class="fine">${interested ? "Your interest is recorded. No payment is taken in this demo." : "This records your interest only. No payment is taken."}</p>` : ""}
  </section>
  <section class="block" aria-labelledby="staff-title">
    <header class="block-head"><h2 id="staff-title">Accounts</h2></header>
    <div class="table-scroll" tabindex="0"><table class="ruled-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>
      ${staff.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td></tr>`).join("")}
    </tbody></table></div>
    ${staff.length < limit ? `
    <h3>Add counter staff</h3>
    <form method="post" action="/app/settings/staff" class="form stack">
      ${csrfField(csrf)}
      <label for="staff_name">Name</label><input id="staff_name" name="name" required maxlength="60">
      <label for="staff_email">Email</label><input id="staff_email" name="email" type="email" required maxlength="120">
      <label for="staff_password">Starting password (at least 10 characters)</label><input id="staff_password" name="password" type="password" required minlength="10" maxlength="200" autocomplete="new-password">
      <button class="btn btn-primary" type="submit">Add account</button>
    </form>` : `<p class="fine">This plan has no room for another account.</p>`}
  </section>
  <section class="block" aria-labelledby="pw-title">
    <header class="block-head"><h2 id="pw-title">Change your password</h2></header>
    <form method="post" action="/app/settings/password" class="form stack">
      ${csrfField(csrf)}
      <label for="current_password">Current password</label><input id="current_password" name="current_password" type="password" required maxlength="200" autocomplete="current-password">
      <label for="new_password">New password (at least 10 characters)</label><input id="new_password" name="new_password" type="password" required minlength="10" maxlength="200" autocomplete="new-password">
      <button class="btn btn-quiet" type="submit">Change password</button>
    </form>
  </section>
</section>`;
  return shell({ title: "Settings", user, active: "settings", csrf, body, flash });
}

function adminPage(user, csrf, stats, shops, audits, flash) {
  const body = `
<section class="page">
  <header class="page-head"><p class="eyebrow">Platform admin · demo</p><h1>Shops and activity</h1></header>
  <dl class="figures">
    <div><dt>Shops</dt><dd>${stats.shops}</dd></div>
    <div><dt>Accounts</dt><dd>${stats.users}</dd></div>
    <div><dt>Items</dt><dd>${stats.products}</dd></div>
    <div><dt>Movements</dt><dd>${stats.movements}</dd></div>
  </dl>
  <section class="block" aria-labelledby="shops-title">
    <header class="block-head"><h2 id="shops-title">Shops</h2></header>
    <div class="table-scroll" tabindex="0"><table class="ruled-table"><thead><tr><th>Shop</th><th>Plan</th><th class="num">Items</th><th class="num">Accounts</th></tr></thead><tbody>
      ${shops.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.plan)}</td><td class="num">${s.products}</td><td class="num">${s.accounts}</td></tr>`).join("")}
    </tbody></table></div>
  </section>
  <section class="block" aria-labelledby="audit-title">
    <header class="block-head"><h2 id="audit-title">Latest audit entries</h2></header>
    ${audits.length ? `<div class="table-scroll" tabindex="0"><table class="ruled-table"><thead><tr><th>When (NPT)</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${audits.map((a) => `<tr><td>${esc(fmtDateTime(a.created_at))}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="empty">No audit entries yet.</p>`}
  </section>
</section>`;
  return shell({ title: "Admin", user, active: "admin", csrf, body, flash });
}

// ---------- route handling ----------

function flashRedirect(location, kind, message) {
  return redirect(location, [flashCookie(kind, message)]);
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw new HttpError(403, "forbidden");
}

async function getRoute(db, url, request, user, csrf, flash) {
  const path = url.pathname;
  const shop = user.shop_id;
  if (path === "/app") {
    const win = dayWindow();
    const stats = {
      products: await countRows(db, "SELECT COUNT(*) FROM products WHERE shop_id = ?", shop),
      low: await countRows(db, "SELECT COUNT(*) FROM products WHERE shop_id = ? AND on_hand <= reorder_level", shop),
      today: await countRows(db, "SELECT COUNT(*) FROM stock_movements WHERE shop_id = ? AND created_at >= ? AND created_at < ?", shop, win.start, win.end),
      open: await countRows(db, "SELECT COUNT(*) FROM purchase_orders WHERE shop_id = ? AND status IN ('draft','sent')", shop),
    };
    const recent = (await db.prepare(
      `SELECT m.*, p.name AS product_name, p.unit AS product_unit FROM stock_movements m
         JOIN products p ON p.id = m.product_id WHERE m.shop_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 8`
    ).bind(shop).all()).results;
    return htmlResponse(200, overviewPage(user, csrf, stats, await lowStock(db, shop), recent, flash));
  }
  if (path === "/app/products") {
    const q = clean(url.searchParams.get("q"), 60);
    const low = url.searchParams.get("low") === "1";
    return htmlResponse(200, productsPage(user, csrf, await listProducts(db, shop, q, low), q, low, flash));
  }
  if (path === "/app/products/new") {
    requireRole(user, ["owner"]);
    return htmlResponse(200, productNewPage(user, csrf, await listSuppliers(db, shop), { reorder_level: 5, reorder_qty: 20 }, "", flash));
  }
  let m = /^\/app\/products\/([\w-]+)$/.exec(path);
  if (m) {
    const product = await loadProduct(db, shop, m[1]);
    if (!product) throw new HttpError(404, "not found");
    const movements = await movementsBetween(db, shop, 0, Number.MAX_SAFE_INTEGER, product.id, 40);
    return htmlResponse(200, productDetailPage(user, csrf, product, await listSuppliers(db, shop), movements, flash));
  }
  if (path === "/app/movements") {
    const win = dayWindow(url.searchParams.get("day"));
    return htmlResponse(200, movementsPage(user, csrf, win.day, await movementsBetween(db, shop, win.start, win.end), flash));
  }
  if (path === "/app/alerts") {
    return htmlResponse(200, alertsPage(user, csrf, await lowStock(db, shop), flash));
  }
  if (path === "/app/suppliers") {
    requireRole(user, ["owner"]);
    return htmlResponse(200, suppliersPage(user, csrf, await listSuppliers(db, shop), flash));
  }
  if (path === "/app/orders") {
    const st = PO_STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
    return htmlResponse(200, ordersPage(user, csrf, await listOrders(db, shop, st), st, flash));
  }
  if (path === "/app/orders/new") {
    requireRole(user, ["owner"]);
    const suppliers = await listSuppliers(db, shop);
    const products = (await db.prepare("SELECT id, name, unit, on_hand, reorder_qty FROM products WHERE shop_id = ? ORDER BY name COLLATE NOCASE").bind(shop).all()).results;
    const pre = (url.searchParams.get("products") || "").split(",").filter((id) => products.some((p) => p.id === id)).slice(0, 10);
    return htmlResponse(200, orderNewPage(user, csrf, suppliers, products, pre, flash));
  }
  m = /^\/app\/orders\/([\w-]+)$/.exec(path);
  if (m) {
    const data = await loadOrder(db, shop, m[1]);
    if (!data) throw new HttpError(404, "not found");
    return htmlResponse(200, orderDetailPage(user, csrf, data, flash));
  }
  if (path === "/app/settings") {
    requireRole(user, ["owner"]);
    const shopRow = await loadShop(db, shop);
    const staff = (await db.prepare("SELECT name, email, role FROM users WHERE shop_id = ? ORDER BY role, name").bind(shop).all()).results;
    const interested = (await countRows(db, "SELECT COUNT(*) FROM plan_interest WHERE shop_id = ?", shop)) > 0;
    return htmlResponse(200, settingsPage(user, csrf, shopRow, staff, interested, flash));
  }
  if (path === "/admin") {
    requireRole(user, ["admin"]);
    const stats = {
      shops: await countRows(db, "SELECT COUNT(*) FROM shops"),
      users: await countRows(db, "SELECT COUNT(*) FROM users WHERE role <> 'admin'"),
      products: await countRows(db, "SELECT COUNT(*) FROM products"),
      movements: await countRows(db, "SELECT COUNT(*) FROM stock_movements"),
    };
    const shops = (await db.prepare(
      `SELECT s.name, s.plan, (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id) AS products,
              (SELECT COUNT(*) FROM users u WHERE u.shop_id = s.id) AS accounts
         FROM shops s ORDER BY s.created_at LIMIT 100`).all()).results;
    const audits = (await db.prepare("SELECT action, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT 25").all()).results;
    return htmlResponse(200, adminPage(user, csrf, stats, shops, audits, flash));
  }
  throw new HttpError(404, "not found");
}

async function loadSupplierInShop(db, shop, id) {
  if (!id) return null;
  return db.prepare("SELECT id FROM suppliers WHERE id = ? AND shop_id = ?").bind(id, shop).first();
}

async function postRoute(db, request, url, user, form) {
  const path = url.pathname;
  const shop = user.shop_id;
  const now = Date.now();
  const actor = user.id;

  if (path === "/app/settings/password") {
    requireRole(user, ["owner", "staff"]);
    const row = await db.prepare("SELECT pw_hash FROM users WHERE id = ?").bind(actor).first();
    if (!(await verifyPassword(String(form.get("current_password") || ""), row.pw_hash))) return flashRedirect("/app/settings", "err", "The current password is not right.");
    const next = String(form.get("new_password") || "");
    if (next.length < 10 || next.length > 200) return flashRedirect("/app/settings", "err", "The new password needs 10 to 200 characters.");
    await db.batch([
      db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").bind(await hashPassword(next), actor),
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(actor),
    ]);
    if (shop) await audit(db, shop, actor, "password-changed", "Password changed; sessions ended");
    return redirect("/login", [cookieString("ps_session", "", { maxAge: 0 }), flashCookie("ok", "Password changed. Log in again.")]);
  }

  if (path === "/app/settings") {
    requireRole(user, ["owner"]);
    const name = clean(form.get("shop_name"), 80);
    if (name.length < 2) return flashRedirect("/app/settings", "err", "The shop name needs at least two characters.");
    await db.prepare("UPDATE shops SET name = ? WHERE id = ?").bind(name, shop).run();
    await audit(db, shop, actor, "shop-renamed", name);
    return flashRedirect("/app/settings", "ok", "Shop name saved.");
  }

  if (path === "/app/settings/plan") {
    requireRole(user, ["owner"]);
    await db.prepare("INSERT OR IGNORE INTO plan_interest (id, shop_id, user_id, plan, created_at) VALUES (?, ?, ?, 'shop', ?)")
      .bind(`int-${shop}`, shop, actor, now).run();
    await audit(db, shop, actor, "plan-interest", "Asked about the Shop plan; no payment taken");
    return flashRedirect("/app/settings", "ok", "Thanks. Your interest in the Shop plan is recorded. Nothing was charged.");
  }

  if (path === "/app/settings/staff") {
    requireRole(user, ["owner"]);
    const shopRow = await loadShop(db, shop);
    const name = clean(form.get("name"), 60);
    const email = clean(form.get("email"), 120).toLowerCase();
    const password = String(form.get("password") || "");
    if (name.length < 2 || !isEmail(email) || password.length < 10 || password.length > 200) {
      return flashRedirect("/app/settings", "err", "Check the name, the email and a password of at least 10 characters.");
    }
    try {
      const res = await db.prepare(
        `INSERT INTO users (id, shop_id, name, email, role, pw_hash, created_at)
         SELECT ?, ?, ?, ?, 'staff', ?, ? WHERE (SELECT COUNT(*) FROM users WHERE shop_id = ?) < ?`
      ).bind(`usr-${randomHex(8)}`, shop, name, email, await hashPassword(password), now, shop, accountLimitFor(shopRow.plan)).run();
      if (res.meta.changes !== 1) return flashRedirect("/app/settings", "err", "This plan has no room for another account.");
    } catch (err) {
      if (isUniqueError(err)) return flashRedirect("/app/settings", "err", "An account with that email already exists.");
      throw err;
    }
    await audit(db, shop, actor, "staff-added", email);
    return flashRedirect("/app/settings", "ok", "Counter account added.");
  }

  if (path === "/app/products") {
    requireRole(user, ["owner"]);
    const shopRow = await loadShop(db, shop);
    const name = clean(form.get("name"), 80);
    const nameNp = clean(form.get("name_np"), 80);
    const sku = clean(form.get("sku"), 40) || null;
    const category = form.get("category") || "";
    const unit = form.get("unit") || "";
    const supplierId = clean(form.get("supplier_id"), 60) || null;
    const reorderLevel = parseInteger(form.get("reorder_level"), 0, 100000);
    const reorderQty = parseInteger(form.get("reorder_qty"), 0, 100000);
    const opening = parseInteger(form.get("opening") || "0", 0, 100000);
    const back = "/app/products/new";
    if (name.length < 2) return flashRedirect(back, "err", "Give the item a name of at least two characters.");
    if (!CATEGORIES.includes(category) || !UNITS.includes(unit)) return flashRedirect(back, "err", "Pick a category and unit from the lists.");
    if (reorderLevel === null || reorderQty === null || opening === null) return flashRedirect(back, "err", "Quantities must be whole numbers from 0 to 100000.");
    if (supplierId && !(await loadSupplierInShop(db, shop, supplierId))) return flashRedirect(back, "err", "That supplier is not in this shop.");
    const id = `prd-${randomHex(8)}`;
    try {
      const res = await db.batch([
        db.prepare(`INSERT INTO products (id, shop_id, name, name_np, sku, category, unit, reorder_level, reorder_qty,
                      supplier_id, on_hand, is_sample, created_at, updated_at)
                    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ? WHERE (SELECT COUNT(*) FROM products WHERE shop_id = ?) < ?`)
          .bind(id, shop, name, nameNp, sku, category, unit, reorderLevel, reorderQty, supplierId, opening, now, now, shop, productLimitFor(shopRow.plan)),
        db.prepare(`INSERT INTO stock_movements (id, shop_id, product_id, kind, delta, balance_after, note, actor_id, created_at)
                    SELECT ?, ?, id, 'OPENING', on_hand, on_hand, 'Opening count', ?, ? FROM products WHERE id = ? AND shop_id = ? AND on_hand > 0`)
          .bind(`mov-${randomHex(8)}`, shop, actor, now, id, shop),
      ]);
      if (res[0].meta.changes !== 1) return flashRedirect(back, "err", `The free plan holds ${FREE_PRODUCT_LIMIT} items. Ask about the Shop plan in Settings to add more.`);
    } catch (err) {
      if (isUniqueError(err)) return flashRedirect(back, "err", "Another item in this shop already uses that item code.");
      throw err;
    }
    await audit(db, shop, actor, "item-added", name);
    return flashRedirect(`/app/products/${id}`, "ok", "Item saved.");
  }

  let m = /^\/app\/products\/([\w-]+)\/move$/.exec(path);
  if (m) {
    requireRole(user, ["owner", "staff"]);
    return recordMovement(db, user, m[1], form, now);
  }

  m = /^\/app\/products\/([\w-]+)$/.exec(path);
  if (m) {
    requireRole(user, ["owner"]);
    const productId = m[1];
    const product = await loadProduct(db, shop, productId);
    if (!product) throw new HttpError(404, "not found");
    const name = clean(form.get("name"), 80);
    const nameNp = clean(form.get("name_np"), 80);
    const sku = clean(form.get("sku"), 40) || null;
    const category = form.get("category") || "";
    const unit = form.get("unit") || "";
    const supplierId = clean(form.get("supplier_id"), 60) || null;
    const reorderLevel = parseInteger(form.get("reorder_level"), 0, 100000);
    const reorderQty = parseInteger(form.get("reorder_qty"), 0, 100000);
    const back = `/app/products/${productId}`;
    if (name.length < 2 || !CATEGORIES.includes(category) || !UNITS.includes(unit)) return flashRedirect(back, "err", "Check the name, category and unit.");
    if (reorderLevel === null || reorderQty === null) return flashRedirect(back, "err", "Reorder numbers must be whole numbers from 0 to 100000.");
    if (supplierId && !(await loadSupplierInShop(db, shop, supplierId))) return flashRedirect(back, "err", "That supplier is not in this shop.");
    try {
      await db.prepare(`UPDATE products SET name = ?, name_np = ?, sku = ?, category = ?, unit = ?, reorder_level = ?, reorder_qty = ?, supplier_id = ?, updated_at = ?
                        WHERE id = ? AND shop_id = ?`)
        .bind(name, nameNp, sku, category, unit, reorderLevel, reorderQty, supplierId, now, productId, shop).run();
    } catch (err) {
      if (isUniqueError(err)) return flashRedirect(back, "err", "Another item in this shop already uses that item code.");
      throw err;
    }
    await audit(db, shop, actor, "item-edited", name);
    return flashRedirect(back, "ok", "Item saved.");
  }

  if (path === "/app/suppliers") {
    requireRole(user, ["owner"]);
    const name = clean(form.get("name"), 80);
    const contact = clean(form.get("contact_name"), 60);
    const phone = clean(form.get("phone"), 20);
    const email = clean(form.get("email"), 120);
    if (name.length < 2) return flashRedirect("/app/suppliers", "err", "Give the supplier a name.");
    if (phone && !/^[0-9+ ()-]+$/.test(phone)) return flashRedirect("/app/suppliers", "err", "Phone numbers can use digits, spaces, + and brackets only.");
    if (email && !isEmail(email)) return flashRedirect("/app/suppliers", "err", "That email does not look right.");
    await db.prepare("INSERT INTO suppliers (id, shop_id, name, contact_name, phone, email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(`sup-${randomHex(8)}`, shop, name, contact, phone, email, now).run();
    await audit(db, shop, actor, "supplier-added", name);
    return flashRedirect("/app/suppliers", "ok", "Supplier saved.");
  }

  if (path === "/app/orders") {
    requireRole(user, ["owner"]);
    const supplierId = clean(form.get("supplier_id"), 60);
    const note = clean(form.get("note"), 200);
    const productIds = form.getAll("product_id");
    const qtys = form.getAll("qty");
    const lines = [];
    const seen = new Set();
    for (let i = 0; i < productIds.length; i++) {
      const pid = clean(productIds[i], 60);
      if (!pid) continue;
      const qty = parseInteger(qtys[i], 1, 100000);
      if (qty === null) return flashRedirect("/app/orders/new", "err", "Each line needs a whole quantity from 1 to 100000.");
      if (seen.has(pid)) return flashRedirect("/app/orders/new", "err", "Put each item on one line only.");
      seen.add(pid);
      lines.push({ pid, qty });
    }
    if (!(await loadSupplierInShop(db, shop, supplierId))) return flashRedirect("/app/orders/new", "err", "Pick a supplier from this shop.");
    if (lines.length === 0) return flashRedirect("/app/orders/new", "err", "Add at least one item to the order.");
    for (const l of lines) {
      const ok = await db.prepare("SELECT id FROM products WHERE id = ? AND shop_id = ?").bind(l.pid, shop).first();
      if (!ok) return flashRedirect("/app/orders/new", "err", "One of those items is not in this shop.");
    }
    const id = `po-${randomHex(8)}`;
    const stmts = [
      db.prepare(`INSERT INTO purchase_orders (id, shop_id, po_no, supplier_id, status, note, created_by, created_at, updated_at)
                  SELECT ?, ?, COALESCE(MAX(po_no), 0) + 1, ?, 'draft', ?, ?, ?, ? FROM purchase_orders WHERE shop_id = ?`)
        .bind(id, shop, supplierId, note, actor, now, now, shop),
    ];
    for (const l of lines) {
      stmts.push(db.prepare(`INSERT INTO po_lines (id, po_id, product_id, qty, created_at)
                             SELECT ?, ?, id, ?, ? FROM products WHERE id = ? AND shop_id = ?`)
        .bind(`pol-${randomHex(8)}`, id, l.qty, now, l.pid, shop));
    }
    await db.batch(stmts);
    await audit(db, shop, actor, "order-drafted", `${lines.length} lines`);
    return flashRedirect(`/app/orders/${id}`, "ok", "Draft saved. Mark it sent when it leaves the shop.");
  }

  m = /^\/app\/orders\/([\w-]+)\/(send|receive|cancel)$/.exec(path);
  if (m) {
    const [, orderId, action] = m;
    const back = `/app/orders/${orderId}`;
    const po = await db.prepare("SELECT id, po_no FROM purchase_orders WHERE id = ? AND shop_id = ?").bind(orderId, shop).first();
    if (!po) throw new HttpError(404, "not found");
    if (action === "receive") {
      requireRole(user, ["owner", "staff"]);
      const token = randomHex(12);
      const lines = (await db.prepare("SELECT product_id, qty FROM po_lines WHERE po_id = ?").bind(orderId).all()).results;
      const stmts = [
        db.prepare(`UPDATE purchase_orders SET status = 'received', receive_token = ?, received_at = ?, updated_at = ?
                    WHERE id = ? AND shop_id = ? AND status = 'sent'`).bind(token, now, now, orderId, shop),
      ];
      for (const l of lines) {
        stmts.push(db.prepare(`UPDATE products SET on_hand = on_hand + ?, updated_at = ?
                               WHERE id = ? AND shop_id = ? AND EXISTS (SELECT 1 FROM purchase_orders WHERE id = ? AND receive_token = ?)`)
          .bind(l.qty, now, l.product_id, shop, orderId, token));
      }
      for (const l of lines) {
        stmts.push(db.prepare(`INSERT INTO stock_movements (id, shop_id, product_id, kind, delta, balance_after, ref_id, note, actor_id, created_at)
                               SELECT ?, ?, id, 'RECEIPT', ?, on_hand, ?, ?, ?, ? FROM products
                                WHERE id = ? AND shop_id = ? AND EXISTS (SELECT 1 FROM purchase_orders WHERE id = ? AND receive_token = ?)`)
          .bind(`mov-${randomHex(8)}`, shop, l.qty, orderId, `PO-${String(po.po_no).padStart(4, "0")}`, actor, now, l.product_id, shop, orderId, token));
      }
      const res = await db.batch(stmts);
      if (res[0].meta.changes !== 1) return flashRedirect(back, "err", "This order was already received or is not sent yet.");
      await audit(db, shop, actor, "order-received", `PO-${po.po_no}`);
      return flashRedirect(back, "ok", "Received. The quantities are on the shelf now.");
    }
    requireRole(user, ["owner"]);
    if (action === "send") {
      const res = await db.prepare("UPDATE purchase_orders SET status = 'sent', updated_at = ? WHERE id = ? AND shop_id = ? AND status = 'draft'").bind(now, orderId, shop).run();
      if (res.meta.changes !== 1) return flashRedirect(back, "err", "Only a draft can be marked sent.");
      await audit(db, shop, actor, "order-sent", `PO-${po.po_no}`);
      return flashRedirect(back, "ok", "Marked as sent. Nothing was emailed from this demo.");
    }
    const res = await db.prepare("UPDATE purchase_orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND shop_id = ? AND status IN ('draft','sent')").bind(now, orderId, shop).run();
    if (res.meta.changes !== 1) return flashRedirect(back, "err", "A received order cannot be cancelled.");
    await audit(db, shop, actor, "order-cancelled", `PO-${po.po_no}`);
    return flashRedirect(back, "ok", "Order cancelled.");
  }
  throw new HttpError(404, "not found");
}

async function recordMovement(db, user, productId, form, now) {
  const shop = user.shop_id;
  const back = `/app/products/${productId}`;
  const kind = String(form.get("kind") || "");
  const qty = parseInteger(form.get("qty"), 0, 100000);
  const note = clean(form.get("note"), 120);
  if (!["IN", "OUT", "COUNT"].includes(kind)) return flashRedirect(back, "err", "Choose stock in, stock out or counted total.");
  if (qty === null) return flashRedirect(back, "err", "Enter a whole number from 0 to 100000.");
  const product = await loadProduct(db, shop, productId);
  if (!product) throw new HttpError(404, "not found");
  const movId = `mov-${randomHex(8)}`;
  try {
    if (kind === "COUNT") {
      const delta = qty - product.on_hand;
      if (delta === 0) return flashRedirect(back, "ok", "The count matches the shelf. Nothing changed.");
      const res = await db.batch([
        db.prepare("UPDATE products SET on_hand = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND on_hand = ?")
          .bind(qty, now, productId, shop, product.on_hand),
        db.prepare(`INSERT INTO stock_movements (id, shop_id, product_id, kind, delta, balance_after, note, actor_id, created_at)
                    SELECT ?, ?, id, 'COUNT', ?, on_hand, ?, ?, ? FROM products
                     WHERE id = ? AND shop_id = ? AND on_hand = ?`)
          .bind(movId, shop, delta, note || "Counted", user.id, now, productId, shop, qty),
      ]);
      if (res[0].meta.changes !== 1) return flashRedirect(back, "err", "The shelf changed while you counted. Count again.");
      return flashRedirect(back, "ok", `Count saved: ${qty} ${product.unit} on hand.`);
    }
    if (qty === 0) return flashRedirect(back, "err", "Enter a quantity above zero.");
    const delta = kind === "IN" ? qty : -qty;
    const res = await db.batch([
      db.prepare("UPDATE products SET on_hand = on_hand + ?, updated_at = ? WHERE id = ? AND shop_id = ?").bind(delta, now, productId, shop),
      db.prepare(`INSERT INTO stock_movements (id, shop_id, product_id, kind, delta, balance_after, note, actor_id, created_at)
                  SELECT ?, ?, id, ?, ?, on_hand, ?, ?, ? FROM products WHERE id = ? AND shop_id = ?`)
        .bind(movId, shop, kind, delta, note, user.id, now, productId, shop),
    ]);
    if (res[0].meta.changes !== 1) throw new HttpError(404, "not found");
    await audit(db, shop, user.id, kind === "IN" ? "stock-in" : "stock-out", `${product.name}: ${qty}`);
    return flashRedirect(back, "ok", kind === "IN" ? `Stock in recorded: +${qty} ${product.unit}.` : `Stock out recorded: -${qty} ${product.unit}.`);
  } catch (err) {
    if (isCheckError(err)) {
      return flashRedirect(back, "err", `Not enough on the shelf. There are ${product.on_hand} ${product.unit}, so ${qty} cannot go out.`);
    }
    throw err;
  }
}

function errorHtml(status, csrf, user, message) {
  return htmlResponse(status, shell({
    title: "Something went wrong", user, csrf,
    body: `<section class="narrow"><header class="page-head"><p class="eyebrow">${status}</p><h1>That did not go through</h1></header><p>${esc(message)}</p><p><a href="${user ? "/app" : "/"}">Go back</a></p></section>`,
  }));
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const db = env.DB;
  if (env.ASSETS && (url.pathname.startsWith("/static/") || url.pathname === "/robots.txt")) {
    return env.ASSETS.fetch(request);
  }
  const csrfInfo = ensureCsrf(request);
  const csrf = csrfInfo.token;
  const extraCookies = csrfInfo.cookies;
  try {
    await ensureSchema(db);
    const user = await currentUser(db, request);
    const method = request.method.toUpperCase();
    const path = url.pathname;

    if (method === "GET" || method === "HEAD") {
      const flash = readFlash(request);
      const clearFlash = flash ? [cookieString("ps_flash", "", { maxAge: 0 })] : [];
      const cookies = [...extraCookies, ...clearFlash];
      if (path === "/") return htmlResponse(200, homePage(csrf), cookies);
      if (path === "/login") return user ? redirect("/app") : htmlResponse(200, loginPage(csrf), cookies);
      if (path === "/signup") return htmlResponse(200, signupPage(csrf), cookies);
      if (path === "/terms") return htmlResponse(200, legalPage("terms", csrf), cookies);
      if (path === "/privacy") return htmlResponse(200, legalPage("privacy", csrf), cookies);
      if (path === "/logout") return redirect("/");
      if (path.startsWith("/app") || path === "/admin") {
        if (!user) return redirect("/login", extraCookies);
        if (user.role === "admin" && path.startsWith("/app")) return htmlResponse(403, forbiddenPage(csrf, user), cookies);
        if (user.role !== "admin" && path === "/admin") return htmlResponse(403, forbiddenPage(csrf, user), cookies);
        return await getRoute(db, url, request, user, csrf, flash).then((r) => withCookies(r, cookies));
      }
      return htmlResponse(404, notFoundPage(csrf, user), cookies);
    }

    if (method !== "POST") return htmlResponse(405, notFoundPage(csrf, user), extraCookies);

    const form = await readForm(request);
    checkCsrf(request, form, url);
    if (path === "/logout") {
      const token = parseCookies(request.headers.get("cookie")).ps_session;
      if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
      return redirect("/", [cookieString("ps_session", "", { maxAge: 0 }), flashCookie("ok", "You are logged out."), ...extraCookies]);
    }
    if (path === "/login") return await handleLogin(db, request, form, csrf, extraCookies);
    if (path === "/demo") return await handleDemo(db, extraCookies);
    if (path === "/signup") return await handleSignup(db, request, form, csrf, extraCookies);
    if (!user) return redirect("/login", extraCookies);
    if (user.role === "admin") throw new HttpError(403, "forbidden");
    return withCookies(await postRoute(db, request, url, user, form), extraCookies);
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 401) return redirect("/login", extraCookies);
      if (err.status === 403) {
        return htmlResponse(403, err.message === "forbidden" ? forbiddenPage(csrf, null) : errorHtml(403, csrf, null, err.message), extraCookies);
      }
      if (err.status === 404) return htmlResponse(404, notFoundPage(csrf, null), extraCookies);
      return errorHtml(err.status, csrf, null, err.message);
    }
    console.error("unhandled", err && err.message);
    return htmlResponse(500, shell({ title: "Error", csrf, body: `<section class="narrow"><h1>Something went wrong on our side.</h1><p>Try again in a moment. <a href="/">Home</a></p></section>` }), extraCookies);
  }
}

function withCookies(response, cookies) {
  for (const c of cookies) response.headers.append("Set-Cookie", c);
  return response;
}

async function handleLogin(db, request, form, csrf, extraCookies) {
  const email = clean(form.get("email"), 120).toLowerCase();
  const password = String(form.get("password") || "").slice(0, 200);
  if (await rateLimited(db, `login:${email}`, LOGIN_LIMIT)) {
    return htmlResponse(429, loginPage(csrf, { error: "Too many attempts for this email. Wait fifteen minutes and try again.", email }), extraCookies);
  }
  const row = await db.prepare("SELECT id, shop_id, pw_hash FROM users WHERE email = ?").bind(email).first();
  if (!row || !(await verifyPassword(password, row.pw_hash))) {
    return htmlResponse(401, loginPage(csrf, { error: "That email and password do not match.", email }), extraCookies);
  }
  const token = await startSession(db, row.id);
  await audit(db, row.shop_id, row.id, "sign-in", "Signed in");
  return redirect(row.shop_id ? "/app" : "/admin", [sessionCookieHeader(token), flashCookie("ok", "Signed in."), ...extraCookies]);
}

async function handleDemo(db, extraCookies) {
  const row = await db.prepare("SELECT id FROM users WHERE id = ?").bind(DEMO.owner.id).first();
  if (!row) throw new HttpError(500, "The demo is not set up.");
  const token = await startSession(db, row.id);
  await audit(db, DEMO.shopId, row.id, "sign-in", "Opened the demo shop");
  return redirect("/app", [sessionCookieHeader(token), flashCookie("ok", "Demo shop open. Nothing here is real."), ...extraCookies]);
}

async function handleSignup(db, request, form, csrf, extraCookies) {
  const ip = request.headers.get("cf-connecting-ip") || "local";
  if (await rateLimited(db, `signup:${ip}`, SIGNUP_LIMIT)) {
    return htmlResponse(429, signupPage(csrf, { error: "Too many sign-ups from here. Try again later." }), extraCookies);
  }
  const shopName = clean(form.get("shop_name"), 80);
  const name = clean(form.get("name"), 60);
  const email = clean(form.get("email"), 120).toLowerCase();
  const password = String(form.get("password") || "").slice(0, 200);
  const values = { shop_name: shopName, name, email };
  if (shopName.length < 2 || name.length < 2 || !isEmail(email) || password.length < 10) {
    return htmlResponse(400, signupPage(csrf, { error: "Check the shop name, your name, the email and a password of at least 10 characters.", values }), extraCookies);
  }
  const shopId = `shop-${randomHex(8)}`;
  const userId = `usr-${randomHex(8)}`;
  const now = Date.now();
  try {
    await db.batch([
      db.prepare("INSERT INTO shops (id, name, plan, created_at) VALUES (?, ?, 'free', ?)").bind(shopId, shopName, now),
      db.prepare("INSERT INTO users (id, shop_id, name, email, role, pw_hash, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)")
        .bind(userId, shopId, name, email, await hashPassword(password), now),
    ]);
  } catch (err) {
    if (isUniqueError(err)) {
      return htmlResponse(409, signupPage(csrf, { error: "An account with that email already exists. Log in instead.", values }), extraCookies);
    }
    throw err;
  }
  const token = await startSession(db, userId);
  await audit(db, shopId, userId, "shop-created", "Free shop created");
  return redirect("/app", [sessionCookieHeader(token), flashCookie("ok", "Your shop is ready. Add your first item."), ...extraCookies]);
}

function sessionCookieHeader(token) {
  return cookieString("ps_session", token, { maxAge: SESSION_MS / 1000 });
}

export default {
  async fetch(request, env) {
    return handle(request, env);
  },
};

export { SCHEMA, SAMPLE_PRODUCTS, DEMO, dayWindow, fmtDateTime, hashPassword, verifyPassword, statusOf, parseInteger, esc };
