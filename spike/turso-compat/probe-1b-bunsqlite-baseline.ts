// Perf baseline: same 10k-insert benchmark as probe 1, on bun:sqlite.
import { Database } from "bun:sqlite";
const db = new Database(":memory:");
db.exec("CREATE TABLE bench (id INTEGER PRIMARY KEY, payload TEXT)");
const stmt = db.prepare("INSERT INTO bench (payload) VALUES (?)");
const N = 10_000;
const t0 = performance.now();
db.exec("BEGIN");
for (let i = 0; i < N; i++) stmt.run(`payload-${i}`);
db.exec("COMMIT");
const t1 = performance.now();
console.log(`bun:sqlite txn batch insert 10k: ${(t1 - t0).toFixed(1)}ms (${Math.round(N / ((t1 - t0) / 1000))} rows/s)`);
