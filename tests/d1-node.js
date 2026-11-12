// In-memory stand-in for Cloudflare D1, built on node:sqlite (Node 22.5+). Same surface the
// Worker uses: prepare().bind().first()/all()/run() and batch(), with batch as one transaction.
import { DatabaseSync } from "node:sqlite";

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export class D1Like {
  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
    this.tail = Promise.resolve();
  }
  // Every statement and batch runs one at a time, as D1 serialises a database.
  lock(fn) {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }
  prepare(sql) {
    return new Stmt(this, sql, []);
  }
  batch(stmts) {
    return this.lock(() => {
      this.raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.execSync());
        this.raw.exec("COMMIT");
        return out;
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      }
    });
  }
  exec(sql) {
    return this.lock(() => this.raw.exec(sql));
  }
}

class Stmt {
  constructor(db, sql, args) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map(norm));
  }
  execSync(mode = "run") {
    const st = this.db.raw.prepare(this.sql);
    const args = this.args.map(norm);
    if (mode === "first") return st.get(...args) ?? null;
    if (mode === "all") return { results: st.all(...args), success: true, meta: {} };
    const info = st.run(...args);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
  first() { return this.db.lock(() => this.execSync("first")); }
  all() { return this.db.lock(() => this.execSync("all")); }
  run() { return this.db.lock(() => this.execSync("run")); }
}
