import type { Db, Tx } from "./db.js";
export async function flag(c: Db | Tx, name: string): Promise<boolean> {
  const r = await c.query("SELECT value FROM system_flags WHERE name=$1", [name]);
  return !!r.rows[0]?.value;
}
export async function setFlag(c: Db | Tx, name: string, value: boolean, reason: string) {
  await c.query("UPDATE system_flags SET value=$2, reason=$3, updated_at=now() WHERE name=$1", [name, value, reason]);
}
