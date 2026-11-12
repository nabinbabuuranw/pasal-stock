// Test helpers: call the Worker directly, keep cookies the way a browser would.
import { D1Like } from "./d1-node.js";
import { handle } from "../site/_worker.js";

export function newEnv() {
  return { DB: new D1Like(":memory:") };
}

export class Client {
  constructor(env) {
    this.env = env;
    this.cookies = {};
  }
  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(response) {
    for (const raw of response.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/Max-Age=0/.test(raw) || value === "") delete this.cookies[name];
      else this.cookies[name] = value;
    }
  }
  async send(method, path, { form = null, headers = {}, origin = null } = {}) {
    const base = "http://localhost";
    const originHeader = origin ?? base;
    if (!this.cookies.ps_csrf) {
      const primed = await handle(new Request(`${base}/login`), this.env);
      this.absorb(primed);
    }
    const h = { cookie: this.cookieHeader(), ...headers };
    let body;
    if (method === "POST") {
      const params = new URLSearchParams(form ? Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])) : []);
      if (!params.has("_csrf")) params.set("_csrf", this.cookies.ps_csrf || "");
      body = params.toString();
      h["content-type"] = "application/x-www-form-urlencoded";
      h["content-length"] = String(Buffer.byteLength(body));
      h.origin = originHeader;
    }
    const response = await handle(new Request(`${base}${path}`, { method, headers: h, body, redirect: "manual" }), this.env);
    this.absorb(response);
    response.text_ = await response.text();
    return response;
  }
  get(path, opts) { return this.send("GET", path, opts); }
  post(path, form, opts = {}) { return this.send("POST", path, { form, ...opts }); }
}

export async function loginAs(env, which = "owner") {
  const c = new Client(env);
  const creds = {
    owner: ["owner@demo.invalid", "demo-owner-2026"],
    staff: ["staff@demo.invalid", "demo-staff-2026"],
    admin: ["admin@demo.invalid", "demo-admin-2026"],
  }[which];
  const r = await c.post("/login", { email: creds[0], password: creds[1] });
  if (r.status !== 303) throw new Error(`login failed for ${which}: ${r.status}`);
  return c;
}

export async function signupShop(env, name) {
  const c = new Client(env);
  const r = await c.post("/signup", { shop_name: name, name: "Owner " + name, email: `${name.toLowerCase().replace(/\W+/g, "")}@example.invalid`, password: "a-long-password-1" });
  if (r.status !== 303) throw new Error(`signup failed: ${r.status}`);
  return c;
}

export async function dbOf(env) {
  return env.DB;
}

export async function q(env, sql, ...args) {
  return (await env.DB.prepare(sql).bind(...args).all()).results;
}

export async function q1(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).first();
}

export async function productIdByName(env, shopId, name) {
  const row = await q1(env, "SELECT id FROM products WHERE shop_id = ? AND name = ?", shopId, name);
  return row?.id;
}

export async function shopOf(env, email) {
  return q1(env, "SELECT shop_id FROM users WHERE email = ?", email);
}

export const CSRF_BAD = "ps_csrf=bad";
