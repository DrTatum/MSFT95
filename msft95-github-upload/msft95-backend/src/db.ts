import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// numeric -> string (we turn it into BigInt where needed); int8 -> string as well, never lossy JS numbers
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 20 });
}

/** Run fn inside one transaction. Retries on serialization failures / deadlocks. */
export async function tx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e: any) {
      await c.query("ROLLBACK").catch(() => {});
      if ((e?.code === "40001" || e?.code === "40P01") && attempt < 4) continue;
      throw e;
    } finally {
      c.release();
    }
  }
}

export async function migrate(db: Db): Promise<string[]> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    await tx(db, async (c) => {
      await c.query(fs.readFileSync(path.join(dir, f), "utf8"));
      await c.query("INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [f]);
    });
    applied.push(f);
  }
  return applied;
}
