import { createPool, migrate } from "./db.js";
const db = createPool(process.env.DATABASE_URL!);
const applied = await migrate(db);
console.log(applied.length ? "applied: " + applied.join(", ") : "database is up to date");
await db.end();
