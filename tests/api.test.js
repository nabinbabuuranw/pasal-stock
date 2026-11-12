// API and rules tests for Pasal Stock. Each test runs against a fresh in-memory database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newEnv, Client, loginAs, signupShop, q, q1, productIdByName } from "./helpers.js";

const SHOP = "shop-demo";
const SUGAR = "Sugar (illustrative)";
const COLA = "Cola can 330 ml (illustrative)";
const MILK = "Milk pouch 500 ml (illustrative)";
const NOTEBOOK = "Notebook A4 (illustrative)";

function flashOf(response) {
  const m = /<div class="flash flash-(\w+)"[^>]*>([^<]*)<\/div>/.exec(response.text_ || "");
  return m ? { kind: m[1], message: m[2] } : null;
}

function flashCookieText(client) {
  return client.cookies.ps_flash;
}

async function fetchFlash(client, location) {
  const r = await client.get(location);
  return flashOf(r);
}

test("anonymous visitors are sent to log in", async () => {
  const env = newEnv();
  const c = new Client(env);
  const r = await c.get("/app");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/login");
});

test("owner sees the overview with the demo shop counts", async () => {
  const env = newEnv();
  const owner = await loginAs(env, "owner");
  const r = await owner.get("/app");
  assert.equal(r.status, 200);
  assert.match(r.text_, /Overview/);
  assert.match(r.text_, /Reorder now/);
});

test("a low item appears on the reorder list and an in-stock item does not", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const r = await owner.get("/app/alerts");
  assert.equal(r.status, 200);
  assert.ok(r.text_.includes(SUGAR), "sugar is at its reorder level");
  assert.ok(r.text_.includes(MILK), "milk is below its reorder level");
  assert.ok(r.text_.includes(COLA), "cola is out of stock");
  assert.ok(!r.text_.includes(NOTEBOOK), "notebook is well stocked");
});

test("stock out lowers the balance and writes one daily-log line with the balance after", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const id = await productIdByName(env, SHOP, SUGAR);
  const before = await q1(env, "SELECT COUNT(*) AS n FROM stock_movements WHERE shop_id = ?", SHOP);
  const r = await owner.post(`/app/products/${id}/move`, { kind: "OUT", qty: "3", note: "Sale" });
  assert.equal(r.status, 303);
  const row = await q1(env, "SELECT on_hand FROM products WHERE id = ?", id);
  assert.equal(row.on_hand, 2);
  const after = await q1(env, "SELECT COUNT(*) AS n FROM stock_movements WHERE shop_id = ?", SHOP);
  assert.equal(after.n, before.n + 1);
  const last = await q1(env, "SELECT kind, delta, balance_after FROM stock_movements WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", id);
  assert.deepEqual({ kind: last.kind, delta: last.delta, balance_after: last.balance_after }, { kind: "OUT", delta: -3, balance_after: 2 });
});

test("stock out larger than the shelf is refused and writes nothing", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const id = await productIdByName(env, SHOP, SUGAR);
  const before = await q1(env, "SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?", id);
  const r = await owner.post(`/app/products/${id}/move`, { kind: "OUT", qty: "9" });
  assert.equal(r.status, 303);
  const flash = await fetchFlash(owner, `/app/products/${id}`);
  assert.equal(flash?.kind, "err");
  assert.match(flash.message, /Not enough on the shelf/);
  const row = await q1(env, "SELECT on_hand FROM products WHERE id = ?", id);
  assert.equal(row.on_hand, 5);
  const after = await q1(env, "SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?", id);
  assert.equal(after.n, before.n);
});

test("a counted total adjusts the shelf by the difference and an equal count changes nothing", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const id = await productIdByName(env, SHOP, SUGAR);
  await owner.post(`/app/products/${id}/move`, { kind: "COUNT", qty: "9", note: "Monthly count" });
  let row = await q1(env, "SELECT on_hand FROM products WHERE id = ?", id);
  assert.equal(row.on_hand, 9);
  const mv = await q1(env, "SELECT kind, delta FROM stock_movements WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", id);
  assert.deepEqual({ kind: mv.kind, delta: mv.delta }, { kind: "COUNT", delta: 4 });
  const same = await q1(env, "SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?", id);
  await owner.post(`/app/products/${id}/move`, { kind: "COUNT", qty: "9" });
  const again = await q1(env, "SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?", id);
  assert.equal(again.n, same.n, "no movement when the count matches");
});

test("zero or non-numeric quantities are refused", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const id = await productIdByName(env, SHOP, SUGAR);
  await owner.post(`/app/products/${id}/move`, { kind: "IN", qty: "0" });
  assert.equal((await fetchFlash(owner, `/app/products/${id}`))?.kind, "err");
  await owner.post(`/app/products/${id}/move`, { kind: "IN", qty: "1.5" });
  assert.equal((await fetchFlash(owner, `/app/products/${id}`))?.kind, "err");
  await owner.post(`/app/products/${id}/move`, { kind: "DROP", qty: "2" });
  assert.equal((await fetchFlash(owner, `/app/products/${id}`))?.kind, "err");
  const row = await q1(env, "SELECT on_hand FROM products WHERE id = ?", id);
  assert.equal(row.on_hand, 5);
});

test("purchase order: draft, sent, received adds the stock once, and a second receive is refused", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const staff = await loginAs(env, "staff");
  const id = await productIdByName(env, SHOP, SUGAR);
  const create = await owner.post("/app/orders", { supplier_id: "sup-sample-1", product_id: [id], qty: ["20"], note: "Weekly" });
  assert.equal(create.status, 303);
  const orderPath = create.headers.get("location");
  const orderId = orderPath.split("/").pop();
  let po = await q1(env, "SELECT status FROM purchase_orders WHERE id = ?", orderId);
  assert.equal(po.status, "draft");
  await owner.post(`/app/orders/${orderId}/send`, {});
  po = await q1(env, "SELECT status FROM purchase_orders WHERE id = ?", orderId);
  assert.equal(po.status, "sent");
  const rec = await staff.post(`/app/orders/${orderId}/receive`, {});
  assert.equal(rec.status, 303);
  let row = await q1(env, "SELECT on_hand FROM products WHERE id = ?", id);
  assert.equal(row.on_hand, 25);
  const receipts = await q1(env, "SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ? AND kind = 'RECEIPT'", id);
  assert.equal(receipts.n, 1);
  await staff.post(`/app/orders/${orderId}/receive`, {});
  row = await q1(env, "SELECT on_hand FROM products WHERE id = ?", id);
  assert.equal(row.on_hand, 25, "a second receive adds nothing");
  const again = await q1(env, "SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ? AND kind = 'RECEIPT'", id);
  assert.equal(again.n, 1);
  await owner.post(`/app/orders/${orderId}/cancel`, {});
  po = await q1(env, "SELECT status FROM purchase_orders WHERE id = ?", orderId);
  assert.equal(po.status, "received", "a received order cannot be cancelled");
});

test("a cancelled order cannot be received", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const id = await productIdByName(env, SHOP, MILK);
  const create = await owner.post("/app/orders", { supplier_id: "sup-sample-2", product_id: [id], qty: ["10"] });
  const orderId = create.headers.get("location").split("/").pop();
  await owner.post(`/app/orders/${orderId}/cancel`, {});
  await owner.post(`/app/orders/${orderId}/send`, {});
  const po = await q1(env, "SELECT status FROM purchase_orders WHERE id = ?", orderId);
  assert.equal(po.status, "cancelled");
  await owner.post(`/app/orders/${orderId}/receive`, {});
  const row = await q1(env, "SELECT on_hand FROM products WHERE id = ?", id);
  assert.equal(row.on_hand, 4);
});

test("twenty parallel stock-outs cannot take the shelf below zero", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const id = await productIdByName(env, SHOP, SUGAR); // on hand 5
  const calls = Array.from({ length: 20 }, () => owner.post(`/app/products/${id}/move`, { kind: "OUT", qty: "1" }));
  await Promise.all(calls);
  const row = await q1(env, "SELECT on_hand FROM products WHERE id = ?", id);
  assert.equal(row.on_hand, 0);
  const outs = await q1(env, "SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ? AND kind = 'OUT'", id);
  assert.equal(outs.n, 5, "exactly the five units on the shelf went out");
  const negatives = await q1(env, "SELECT COUNT(*) AS n FROM products WHERE on_hand < 0");
  assert.equal(negatives.n, 0);
});

test("the free plan holds 40 items and refuses the 41st", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const start = await q1(env, "SELECT COUNT(*) AS n FROM products WHERE shop_id = ?", SHOP);
  for (let i = start.n; i < 40; i++) {
    const r = await owner.post("/app/products", { name: `Test item ${i}`, category: "Grocery", unit: "pcs", reorder_level: "1", reorder_qty: "5", opening: "2" });
    assert.equal(r.status, 303);
  }
  const full = await q1(env, "SELECT COUNT(*) AS n FROM products WHERE shop_id = ?", SHOP);
  assert.equal(full.n, 40);
  await owner.post("/app/products", { name: "One too many", category: "Grocery", unit: "pcs", reorder_level: "1", reorder_qty: "5" });
  const after = await q1(env, "SELECT COUNT(*) AS n FROM products WHERE shop_id = ?", SHOP);
  assert.equal(after.n, 40);
  assert.match((await fetchFlash(owner, "/app/products/new"))?.message ?? "", /free plan holds 40 items/);
});

test("an item code already used in the shop is refused without a second row", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  await owner.post("/app/products", { name: "Dup check", category: "Grocery", unit: "pcs", reorder_level: "0", reorder_qty: "0", sku: "SAMPLE-RICE" });
  const dup = await q1(env, "SELECT COUNT(*) AS n FROM products WHERE shop_id = ? AND name = 'Dup check'", SHOP);
  assert.equal(dup.n, 0);
  assert.match((await fetchFlash(owner, "/app/products/new"))?.message ?? "", /already uses that item code/);
});

test("counter staff can record stock and receive, but cannot set items, suppliers, orders or settings", async () => {
  const env = newEnv();
  const staff = await loginAs(env, "staff");
  const id = await productIdByName(env, SHOP, SUGAR);
  assert.equal((await staff.get("/app/products")).status, 200);
  assert.equal((await staff.get("/app/products/new")).status, 403);
  assert.equal((await staff.get("/app/settings")).status, 403);
  assert.equal((await staff.get("/app/suppliers")).status, 403);
  assert.equal((await staff.get("/app/orders/new")).status, 403);
  assert.equal((await staff.post("/app/products", { name: "Staff item", category: "Grocery", unit: "pcs", reorder_level: "0", reorder_qty: "0" })).status, 403);
  assert.equal((await staff.post(`/app/products/${id}`, { name: "Renamed", category: "Grocery", unit: "pcs", reorder_level: "0", reorder_qty: "0" })).status, 403);
  assert.equal((await staff.post("/app/orders", { supplier_id: "sup-sample-1", product_id: [id], qty: ["3"] })).status, 403);
  assert.equal((await staff.post("/app/settings", { shop_name: "Hijacked" })).status, 403);
  assert.equal((await staff.post("/app/suppliers", { name: "Sneaky" })).status, 403);
  const name = await q1(env, "SELECT name FROM products WHERE id = ?", id);
  assert.equal(name.name, SUGAR);
  const shop = await q1(env, "SELECT name FROM shops WHERE id = ?", SHOP);
  assert.equal(shop.name, "Demo Kirana (illustrative shop)");
  const r = await staff.post(`/app/products/${id}/move`, { kind: "IN", qty: "1" });
  assert.equal(r.status, 303, "staff may record stock in");
  const row = await q1(env, "SELECT on_hand FROM products WHERE id = ?", id);
  assert.equal(row.on_hand, 6);
});

test("the platform admin reaches /admin, and nobody else does", async () => {
  const env = newEnv();
  const admin = await loginAs(env, "admin");
  const owner = await loginAs(env, "owner");
  const anon = new Client(env);
  const r = await admin.get("/admin");
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text_, /pbkdf2-sha256/, "password hashes never reach the admin page");
  assert.equal((await owner.get("/admin")).status, 403);
  assert.equal((await admin.get("/app")).status, 403, "admin is not a shop user");
  assert.equal((await anon.get("/admin")).status, 303);
});

test("one shop cannot see or change another shop's items", async () => {
  const env = newEnv();
  const a = await signupShop(env, "Alpha Kirana");
  const b = await signupShop(env, "Beta Pasal");
  await a.post("/app/products", { name: "Alpha private rice", category: "Grocery", unit: "kg", reorder_level: "1", reorder_qty: "5", opening: "7" });
  const id = await productIdByName(env, (await q1(env, "SELECT shop_id FROM users WHERE name = 'Owner Alpha Kirana'")).shop_id, "Alpha private rice");
  assert.ok(id);
  assert.equal((await b.get(`/app/products/${id}`)).status, 404);
  assert.equal((await b.post(`/app/products/${id}/move`, { kind: "OUT", qty: "1" })).status, 404);
  assert.equal((await b.post(`/app/products/${id}`, { name: "Stolen", category: "Grocery", unit: "kg", reorder_level: "0", reorder_qty: "0" })).status, 404);
  const row = await q1(env, "SELECT on_hand, name FROM products WHERE id = ?", id);
  assert.deepEqual({ on_hand: row.on_hand, name: row.name }, { on_hand: 7, name: "Alpha private rice" });
  const list = await b.get("/app/products");
  assert.doesNotMatch(list.text_, /Alpha private rice/);
});

test("the daily log opens on a chosen day and lists only that day's lines", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const r = await owner.get("/app/movements?day=2020-01-01");
  assert.equal(r.status, 200);
  assert.match(r.text_, /Nothing was recorded on 2020-01-01/);
  const today = await owner.get("/app/movements");
  assert.equal(today.status, 200);
});

test("signup creates a free shop and refuses a short password or a repeated email", async () => {
  const env = newEnv();
  const c = new Client(env);
  const short = await c.post("/signup", { shop_name: "Short Pasal", name: "Short Owner", email: "short@example.invalid", password: "short" });
  assert.equal(short.status, 400);
  const ok = await c.post("/signup", { shop_name: "New Pasal", name: "New Owner", email: "new@example.invalid", password: "a-long-password-2" });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/app");
  const shop = await q1(env, "SELECT plan FROM shops WHERE name = 'New Pasal'");
  assert.equal(shop.plan, "free");
  const again = await new Client(env).post("/signup", { shop_name: "Copy Pasal", name: "Copy Owner", email: "new@example.invalid", password: "a-long-password-2" });
  assert.equal(again.status, 409);
});

test("a wrong password is refused, and repeated failures are throttled", async () => {
  const env = newEnv();
  const c = new Client(env);
  let last;
  for (let i = 0; i < 9; i++) {
    last = await c.post("/login", { email: "owner@demo.invalid", password: "wrong-password-x" });
  }
  assert.equal(last.status, 429);
  const fresh = new Client(env);
  const ok = await fresh.post("/login", { email: "owner@demo.invalid", password: "demo-owner-2026" });
  assert.equal(ok.status, 429, "the email stays locked for the window");
});

test("passwords are stored as salted PBKDF2 hashes, never in plain text", async () => {
  const env = newEnv();
  await loginAs(env);
  const row = await q1(env, "SELECT pw_hash FROM users WHERE email = 'owner@demo.invalid'");
  assert.match(row.pw_hash, /^pbkdf2-sha256\$100000\$/);
  assert.ok(!row.pw_hash.includes("demo-owner-2026"));
});

test("log out ends the session on the server", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  assert.equal((await owner.get("/app")).status, 200);
  await owner.post("/logout", {});
  assert.equal((await owner.get("/app")).status, 303);
});

test("a changed password ends the other sessions", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const second = await loginAs(env);
  const r = await owner.post("/app/settings/password", { current_password: "demo-owner-2026", new_password: "a-new-long-password" });
  assert.equal(r.status, 303);
  assert.equal((await second.get("/app")).status, 303, "the other session is gone");
});

test("a Shop plan request records interest and charges nothing", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  await owner.post("/app/settings/plan", {});
  const rows = await q(env, "SELECT plan FROM plan_interest WHERE shop_id = ?", SHOP);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].plan, "shop");
});

test("supplier and item edits keep the shop's own references", async () => {
  const env = newEnv();
  const owner = await loginAs(env);
  const other = await signupShop(env, "Gamma Pasal");
  await other.post("/app/suppliers", { name: "Gamma supplier", contact_name: "", phone: "", email: "" });
  const gammaSupplier = await q1(env, "SELECT id FROM suppliers WHERE name = 'Gamma supplier'");
  const id = await productIdByName(env, SHOP, SUGAR);
  const r = await owner.post(`/app/products/${id}`, { name: SUGAR, category: "Grocery", unit: "kg", reorder_level: "8", reorder_qty: "30", supplier_id: gammaSupplier.id });
  assert.equal(r.status, 303);
  const row = await q1(env, "SELECT supplier_id FROM products WHERE id = ?", id);
  assert.equal(row.supplier_id, "sup-sample-1", "a supplier from another shop is not accepted");
});
