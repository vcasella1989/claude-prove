// Probe 1 — @tursodatabase/database (local engine) under Bun
// Tests: memory + file DBs, prepare/run/get/all, batch, FK enforcement,
// PRAGMAs (foreign_keys, journal_mode, busy_timeout), bun:sqlite file-format compat.
import { connect } from "@tursodatabase/database";

const results: Array<{ test: string; pass: boolean; detail: string }> = [];
function record(test: string, pass: boolean, detail = "") {
  results.push({ test, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${test}${detail ? ` — ${detail}` : ""}`);
}

// --- 1. :memory: open + basic CRUD ---
try {
  const db = await connect(":memory:");
  await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  const ins = db.prepare("INSERT INTO t (name) VALUES (?)");
  await ins.run("alpha");
  await ins.run("beta");
  const row = await db.prepare("SELECT name FROM t WHERE id = ?").get(1);
  const all = await db.prepare("SELECT * FROM t ORDER BY id").all();
  record(":memory: open + prepare/run/get/all", (row as any)?.name === "alpha" && all.length === 2, `get=${JSON.stringify(row)} all.length=${all.length}`);
  db.close();
} catch (e) {
  record(":memory: open + prepare/run/get/all", false, String(e));
}

// --- 2. file-backed DB ---
const filePath = "./spike-file.db";
try {
  const db = await connect(filePath);
  await db.exec("CREATE TABLE IF NOT EXISTS f (k TEXT PRIMARY KEY, v TEXT)");
  await db.prepare("INSERT OR REPLACE INTO f VALUES (?, ?)").run("key", "value");
  db.close();
  const db2 = await connect(filePath);
  const v = await db2.prepare("SELECT v FROM f WHERE k = ?").get("key");
  record("file-backed DB write + reopen + read", (v as any)?.v === "value", JSON.stringify(v));
  db2.close();
} catch (e) {
  record("file-backed DB write + reopen + read", false, String(e));
}

// --- 3. transaction / batch throughput ---
try {
  const db = await connect(":memory:");
  await db.exec("CREATE TABLE bench (id INTEGER PRIMARY KEY, payload TEXT)");
  const stmt = db.prepare("INSERT INTO bench (payload) VALUES (?)");
  const N = 10_000;
  const t0 = performance.now();
  await db.exec("BEGIN");
  for (let i = 0; i < N; i++) await stmt.run(`payload-${i}`);
  await db.exec("COMMIT");
  const t1 = performance.now();
  const count = await db.prepare("SELECT COUNT(*) AS c FROM bench").get();
  record("txn batch insert 10k (prepared-stmt reuse)", (count as any)?.c === N, `${(t1 - t0).toFixed(1)}ms (${Math.round(N / ((t1 - t0) / 1000))} rows/s)`);
  db.close();
} catch (e) {
  record("txn batch insert 10k (prepared-stmt reuse)", false, String(e));
}

// --- 4. PRAGMAs the store relies on ---
try {
  const db = await connect(":memory:");
  const fk0 = await db.prepare("PRAGMA foreign_keys").get();
  await db.exec("PRAGMA foreign_keys = ON");
  const fk1 = await db.prepare("PRAGMA foreign_keys").get();
  record("PRAGMA foreign_keys read/write", fk1 !== undefined, `before=${JSON.stringify(fk0)} after=${JSON.stringify(fk1)}`);

  const jm = await db.prepare("PRAGMA journal_mode").get();
  record("PRAGMA journal_mode read", jm !== undefined, JSON.stringify(jm));

  await db.exec("PRAGMA busy_timeout = 5000");
  const bt = await db.prepare("PRAGMA busy_timeout").get();
  record("PRAGMA busy_timeout set/read", bt !== undefined, JSON.stringify(bt));
  db.close();
} catch (e) {
  record("PRAGMA surface", false, String(e));
}

// --- 5. FK enforcement actually enforces ---
try {
  const db = await connect(":memory:");
  await db.exec("PRAGMA foreign_keys = ON");
  await db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
  await db.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))");
  let rejected = false;
  try {
    await db.prepare("INSERT INTO child (pid) VALUES (999)").run();
  } catch {
    rejected = true;
  }
  record("FK enforcement rejects orphan insert", rejected, rejected ? "orphan insert threw as expected" : "orphan insert was ACCEPTED — FK not enforced");
  db.close();
} catch (e) {
  record("FK enforcement rejects orphan insert", false, String(e));
}

// --- 6. file-format compat: open a bun:sqlite-written DB with the Turso engine ---
// Prefers the real local prove.db (WAL replay included); in CI, synthesizes one
// with bun:sqlite so the cross-engine claim is tested on every platform.
try {
  const src = "../../.prove/prove.db";
  const copy = "./prove-copy.db";
  if (await Bun.file(src).exists()) {
    // The live store runs journal_mode=wal — copy the WAL/SHM sidecars too, or an
    // un-checkpointed DB presents as empty. Replaying the WAL is itself part of the compat claim.
    await Bun.write(copy, Bun.file(src));
    for (const ext of ["-wal", "-shm"]) {
      if (await Bun.file(src + ext).exists()) await Bun.write(copy + ext, Bun.file(src + ext));
    }
    const db = await connect(copy);
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const tasks = await db.prepare("SELECT COUNT(*) AS c FROM scrum_tasks").get();
    record("open real bun:sqlite-written prove.db (WAL replay)", tables.length > 0 && (tasks as any)?.c >= 10, `${tables.length} tables, ${(tasks as any)?.c} scrum_tasks rows`);
    db.close();
  } else {
    const { Database: BunDb } = await import("bun:sqlite");
    const synth = "./bunsqlite-written.db";
    const w = new BunDb(synth, { create: true });
    w.exec("PRAGMA journal_mode = WAL");
    w.exec("CREATE TABLE compat (id INTEGER PRIMARY KEY, v TEXT)");
    w.prepare("INSERT INTO compat (v) VALUES (?)").run("written-by-bun-sqlite");
    w.close();
    const db = await connect(synth);
    const row = await db.prepare("SELECT v FROM compat WHERE id = 1").get();
    record("open synthesized bun:sqlite-written DB (WAL)", (row as any)?.v === "written-by-bun-sqlite", JSON.stringify(row));
    db.close();
  }
} catch (e) {
  record("open bun:sqlite-written DB with Turso engine", false, String(e));
}

// --- summary ---
const failed = results.filter((r) => !r.pass);
console.log(`\n=== probe 1: ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) process.exit(1);
