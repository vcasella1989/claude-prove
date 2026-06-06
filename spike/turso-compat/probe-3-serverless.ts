// Probe 3 — @tursodatabase/serverless under Bun: connect, write, query over pure HTTP.
import { connect } from "@tursodatabase/serverless";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing (read from .env)");
  process.exit(2);
}

const db = connect({ url, authToken });
await db.execute("CREATE TABLE IF NOT EXISTS spike_serverless (id INTEGER PRIMARY KEY, note TEXT, at TEXT)");
await db.execute(`INSERT INTO spike_serverless (note, at) VALUES ('hello-from-bun-serverless', datetime('now'))`);
const stmt = await db.prepare("SELECT COUNT(*) AS c FROM spike_serverless");
const row = await stmt.get();
console.log(`PASS  serverless HTTP connect + write + prepared read — rows=${JSON.stringify(row)}`);
