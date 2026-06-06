# Turso × Bun Compat Spike Report

Phase 0 of the Turso-only store epic (mjmorales/claude-prove#39, spike issue #40).
All probes in this directory; CI leg: `.github/workflows/spike-turso-compat.yml`.

**Verdict: the primary Turso stack works under Bun on both target platforms. No fallback needed.**

## Platform matrix

| Surface | darwin-arm64 | linux-x64 (GH Actions, Bun 1.3.14) |
|---------|:---:|:---:|
| `@tursodatabase/database` 0.6.1 — NAPI loads | PASS | PASS |
| `:memory:` + file DBs, `prepare`/`run`/`get`/`all` | PASS | PASS |
| Txn batch insert (prepared-stmt reuse) | PASS — 735k rows/s | PASS — 210k rows/s |
| `PRAGMA foreign_keys` read/write | PASS | PASS |
| `PRAGMA journal_mode` (reports `wal`) | PASS | PASS |
| `PRAGMA busy_timeout` set/read | PASS | PASS |
| FK enforcement rejects orphan insert | PASS | PASS |
| Open a real `bun:sqlite`-written `prove.db` (incl. WAL replay) | PASS — 25 tables, live store data | PASS (synthesized WAL DB) |
| `@tursodatabase/sync` 0.6.1 — `pull()` hydrates fresh replica | PASS | PASS |
| `push()` → visible to independent replica | PASS | PASS |
| Offline-write queue: write, close, reopen, push | PASS | PASS |
| REBASE_LOCAL two-writer experiments (below) | PASS | PASS — identical behavior |
| `@tursodatabase/serverless` 1.2.0 — connect/write/prepared-read over HTTP | PASS | PASS |
| `@libsql/client` fallback | not run — only required if the primary stack failed; it did not | — |

## REBASE_LOCAL two-writer findings (probe 2)

Two local replicas of one cloud DB, concurrent writes, both push, both pull:

1. **rowid PKs (`INTEGER PRIMARY KEY`): silent row loss.** Both writers allocated
   the same `id=3` offline; after rebase, both replicas converge on the LAST
   pusher's row — the first writer's insert is gone, no error raised. This is the
   AUTOINCREMENT-collision failure mode the ULID-PK schema redesign (#42) targets,
   now confirmed empirically on both platforms.
2. **Distinct TEXT PKs (ULID-style): both rows survive.** Same experiment with
   writer-unique TEXT ids merges cleanly — concurrent inserts commute. Directly
   validates the #42 design.
3. **Contended same-row UPDATE: converges, last-pusher-wins.** Both replicas
   updated the same row; after push+pull both converge on the later pusher's
   value. Deterministic clobber, no divergence — but contended blobs are still
   last-writer-wins, confirming the #42 append-only normalization rationale.

## Gotchas

- **WAL sidecars must travel with the DB file.** The live store runs
  `journal_mode=wal`; an un-checkpointed DB copied without `-wal`/`-shm`
  presents as a valid but EMPTY database (the real `prove.db` was 4KB base +
  1MB WAL). Affects the #44 migrator: checkpoint or copy sidecars first.
- **NAPI resolution requires a local `node_modules`.** Running a script whose
  import resolves through Bun's global install cache loads a broken binding
  (`this.db.connectAsync is not a function`). Anything invoking these packages
  must run inside an installed project.
- **API divergence on `prepare()`:** typed as `Promise` in both packages;
  `@tursodatabase/database`'s resolves to a usable statement without awaiting at
  runtime, but `@tursodatabase/sync`'s genuinely must be awaited. Always
  `await prepare()` in shared store code.
- **`@tursodatabase/sync` writes sidecar files** beside the replica path
  (`-info`, `-changes`, `-revert`, `-wal-revert`, plus WAL/SHM) — gitignore and
  cleanup must account for them.
- **Beta software.** `@tursodatabase/database` README warns BETA; perf is
  ~4–6× slower than `bun:sqlite` on raw insert throughput (735k vs 3.2M rows/s
  darwin; 210k vs 1.2M linux) — far beyond store needs, but not free.

## Transport decision

**Adopt the primary Turso stack** — `@tursodatabase/database` (local engine),
`@tursodatabase/sync` (replica pull/push), `@tursodatabase/serverless` (HTTP
surfaces) — under Bun, on both platforms. The `@libsql/client` embedded-replica
fallback is NOT needed. Phase 1 (#41) is unblocked.

Constraints carried forward from the findings:

- #42's ULID TEXT PKs are mandatory, not stylistic — rowid PKs lose data under
  two-writer sync (finding 1).
- Contended-blob updates are last-pusher-wins (finding 3) — append-only
  normalization is the only safe shape for concurrent paths.
- The #44 migrator must checkpoint (or copy WAL sidecars) before reading a
  legacy `prove.db`.
