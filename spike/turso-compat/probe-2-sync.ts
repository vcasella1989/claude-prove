// Probe 2 — @tursodatabase/sync under Bun against a real Turso Cloud DB:
// pull()/push() lifecycle, offline-write queue, and the REBASE_LOCAL two-writer
// merge experiment the transport decision hinges on.
import { connect } from "@tursodatabase/sync";
import { rmSync } from "node:fs";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing (read from .env)");
  process.exit(2);
}

const results: Array<{ test: string; pass: boolean; detail: string }> = [];
function record(test: string, pass: boolean, detail = "") {
  results.push({ test, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${test}${detail ? ` — ${detail}` : ""}`);
}

// fresh replica files each run
for (const f of ["replica-a.db", "replica-b.db"]) {
  for (const ext of ["", "-info", "-wal", "-shm", "-changes", "-revert", "-wal-revert"]) {
    try { rmSync(f + ext); } catch {}
  }
}

const open = (path: string, clientName: string) => connect({ path, url, authToken, clientName });

// --- 1. pull(): hydrate a fresh replica from the cloud ---
try {
  const a = await open("replica-a.db", "spike-a");
  await a.pull();
  // idempotency: drop spike tables left by previous runs so counts start clean
  for (const t of ["spike_sync", "spike_contended", "spike_ulid"]) {
    await a.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await a.push();
  // spike_serverless was created by probe 3 over HTTP — visible here proves real sync
  const seen = await (await a.prepare("SELECT COUNT(*) AS c FROM spike_serverless")).get();
  record("pull() hydrates replica from cloud", (seen as any)?.c >= 1, `spike_serverless rows visible locally: ${(seen as any)?.c}`);

  // --- 2. push(): local write becomes visible to an independent replica ---
  await a.exec("CREATE TABLE IF NOT EXISTS spike_sync (id INTEGER PRIMARY KEY, writer TEXT, n INTEGER)");
  await (await a.prepare("INSERT INTO spike_sync (writer, n) VALUES (?, ?)")).run("a", 1);
  await a.push();

  const b = await open("replica-b.db", "spike-b");
  await b.pull();
  const fromA = await (await b.prepare("SELECT COUNT(*) AS c FROM spike_sync WHERE writer = 'a'")).get();
  record("push() then pull() on independent replica", (fromA as any)?.c >= 1, `replica-b sees ${(fromA as any)?.c} row(s) written by replica-a`);

  // --- 3. offline-write queue: write without push, close, reopen, then push ---
  await (await b.prepare("INSERT INTO spike_sync (writer, n) VALUES (?, ?)")).run("b-offline", 42);
  b.close(); // simulate going away with an unpushed local write
  const b2 = await open("replica-b.db", "spike-b");
  await b2.push();
  await a.pull();
  const offline = await (await a.prepare("SELECT COUNT(*) AS c FROM spike_sync WHERE writer = 'b-offline'")).get();
  record("offline write survives close/reopen and pushes", (offline as any)?.c === 1, `replica-a sees the queued write after reconnect+push: ${(offline as any)?.c}`);

  // --- 4. REBASE_LOCAL two-writer merge ---
  // 4a. commuting writes: both replicas INSERT concurrently, both push
  await (await a.prepare("INSERT INTO spike_sync (writer, n) VALUES (?, ?)")).run("a-concurrent", 100);
  await (await b2.prepare("INSERT INTO spike_sync (writer, n) VALUES (?, ?)")).run("b-concurrent", 200);
  await a.push();
  await b2.push(); // pushed AFTER a — rebase happens here
  await a.pull();
  await b2.pull();
  const mergedA = await (await a.prepare("SELECT id, writer FROM spike_sync WHERE writer LIKE '%-concurrent' ORDER BY writer")).all();
  const mergedB = await (await b2.prepare("SELECT id, writer FROM spike_sync WHERE writer LIKE '%-concurrent' ORDER BY writer")).all();
  const bothSurvived = mergedA.length === 2 && mergedB.length === 2;
  // Documentation test, always "passes" — with rowid PKs both writers allocate the same
  // INTEGER id offline and the rebase clobbers one row: the exact AUTOINCREMENT-collision
  // failure mode the ULID-PK schema redesign (issue #42) exists to remove.
  record("two-writer concurrent INSERTs, rowid PKs (documents clobber)", true, `${bothSurvived ? "both survived" : "ONE ROW LOST"} — a sees ${JSON.stringify(mergedA)}, b sees ${JSON.stringify(mergedB)}`);

  // 4a'. same experiment with distinct TEXT PKs (ULID-style) — these must commute
  await a.exec("CREATE TABLE IF NOT EXISTS spike_ulid (id TEXT PRIMARY KEY, writer TEXT)");
  await a.push();
  await b2.pull();
  await (await a.prepare("INSERT INTO spike_ulid (id, writer) VALUES (?, ?)")).run("01ULID-AAAA", "a");
  await (await b2.prepare("INSERT INTO spike_ulid (id, writer) VALUES (?, ?)")).run("01ULID-BBBB", "b");
  await a.push();
  await b2.push();
  await a.pull();
  await b2.pull();
  const ulidA = await (await a.prepare("SELECT id FROM spike_ulid ORDER BY id")).all();
  const ulidB = await (await b2.prepare("SELECT id FROM spike_ulid ORDER BY id")).all();
  const ulidSurvived = ulidA.length === 2 && ulidB.length === 2;
  record("two-writer concurrent INSERTs both survive merge (distinct TEXT PKs)", ulidSurvived, `a sees [${ulidA.map((r: any) => r.id)}], b sees [${ulidB.map((r: any) => r.id)}]`);

  // 4b. contended write: both UPDATE the same row concurrently — who wins?
  await a.exec("CREATE TABLE IF NOT EXISTS spike_contended (id INTEGER PRIMARY KEY, v TEXT)");
  await (await a.prepare("INSERT OR REPLACE INTO spike_contended (id, v) VALUES (1, 'base')")).run();
  await a.push();
  await b2.pull();
  await (await a.prepare("UPDATE spike_contended SET v = 'written-by-a' WHERE id = 1")).run();
  await (await b2.prepare("UPDATE spike_contended SET v = 'written-by-b' WHERE id = 1")).run();
  await a.push();
  await b2.push();
  await a.pull();
  await b2.pull();
  const vA = await (await a.prepare("SELECT v FROM spike_contended WHERE id = 1")).get();
  const vB = await (await b2.prepare("SELECT v FROM spike_contended WHERE id = 1")).get();
  const converged = (vA as any)?.v === (vB as any)?.v;
  record("contended same-row UPDATE converges (documents winner)", converged, `a=${JSON.stringify(vA)} b=${JSON.stringify(vB)} — ${converged ? `winner: ${(vA as any)?.v} (last pusher rebases on top)` : "DIVERGED"}`);

  a.close();
  b2.close();
} catch (e) {
  record("sync probe", false, String(e));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== probe 2: ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) process.exit(1);
