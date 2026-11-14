# Memory Explorer: Rules and Read Routes (`openviking-dashboard`, G1-G4)

Part of [spec.md](spec.md) (architecture #541). Pinned to Design's hand-off `/home/shinelay/design-lab/results/openviking-redesign-20261113/explorer/HANDOFF.md` (`cba4ad7`, design #315) for design #316; A1-A5 = design's addendum `rm-3930003f`. Writes, undo and audit: [spec-explorer-writes.md](spec-explorer-writes.md). Daemon calls, gaps, delete list, prototype chrome: [spec-explorer-build.md](spec-explorer-build.md).

## Rules for Every Explorer Route

- **R-EXPLORER-OWNER-1 (addendum A2, A3):** the explorer is an owner-only **view** over all 17 roots, every role's memories included. Role chats and their `viking_*` tools stay isolated exactly as today (§2 holds for them). Every route below, reads too, requires the owner check.
- **Owner check (OI-1, closed by Security `rm-8841fede`):** a WebAuthn passkey owner session, behind the one `owner-gate.ts` (backend #166). Reads need a session; each write needs its own passkey confirmation. Any failure: `403 OWNER_ONLY`, same body. The check, its routes and bodies, and Security's residual risks: [spec-explorer-owner.md](spec-explorer-owner.md).
- **R-EXPLORER-ROOTS-1 (A5):** one server constant `OPENVIKING_EXPLORER_ROOTS`, built from `server/openviking/memory-tree.ts` `RESOURCES_ROOT_URI`, `SHARED_MEMORIES_ROOT_URI` and `roleMemoriesRootUri(role)` over `OPENVIKING_ROLES` (`server/openviking/types.ts`); no second list. Exactly 17, live-checked 2026-11-14: `viking://resources`, `viking://user/default/memories`, `viking://user/<role>/memories` for `architecture backend coo data design docs frontend marketing ops product qa rollcall security systems temper`. Groups: `projects`, `shared`, `department`.
- **R-EXPLORER-URI-1:** every `uri` is decoded once, one trailing `/` dropped, then must be a root or start with `<root>/`. Refused `400 URI_INVALID`: not `viking://`, a `.` or `..` segment, an empty segment, `\` or NUL, over 1024 chars. Refused `400 URI_OUTSIDE_ROOTS`: under no root (aliases `viking://agent/...`, `viking://user/memories/...` included). Daemon calls use `resolveRequestHeaders` (`server/openviking/uri.ts`) for the root's role.
- **R-EXPLORER-LOCK-1 (G8):** a uri whose last segment is `identity.md` or `soul.md` (case-insensitive) is refused `403 SETUP_FILE_LOCKED` on read, edit and delete, server-side. Listings keep the row (`locked: true`, text fields `null`, reason `"locked"`); search drops its hits and counts them in `locked_hidden_count`.
- **Errors:** the existing body `{ error: { code, message, details? } }` (`server/openviking/routes.ts`). `/health` down or daemon unreachable: `503 MEMORY_UNREACHABLE`; other daemon failure: `502 MEMORY_ERROR`; daemon `NOT_FOUND`: `404 NOT_FOUND`; other methods: `405`. `mod_time` is ISO-8601 UTC with ms, parsed from the daemon's `modTime`.
- **Kind** (server-side, from the first segment under the root): `preferences` -> `rule`; `cases`, `experiences` -> `case`; `entities` -> `fact`; `events` -> `event`; anything under `viking://resources` -> `document`; else `other`.

## G1 One Note Count

- **R-EXPLORER-COUNT-1:** a note = a file (`isDir: false`) under the 17 roots from the G2 walk. `notes_total` is the one count: the health line and the tree both show it. No other count is shown as it. Unmeasured -> `null`, never `0` (as `pending_syncs_count`, `unread_count`).

## G2 Tree (Lazy, A4)

**`GET /api/openviking/tree/roots`** — walks each root with `/api/v1/fs/tree` (`include_abstract=false`, `level_limit=32`, `node_limit=20000`), `mapWithLimit` 4 (`server/openviking/daemon-http.ts`), in the one tree reader `server/openviking/memory-tree.ts`. `200`:

| Field | Type | Null / meaning |
|---|---|---|
| `checked_at` | ISO | request time |
| `health_state` | as `/overview` | `/health` alone ([spec-states.md](spec-states.md) §4) |
| `notes_total` | int \| null | sum of `roots[].notes`; `null` when any root is unread |
| `unread_count`, `roots_partial` | int, bool | roots that did not answer; `roots_partial` = `unread_count > 0`; every root that read is still returned |
| `roots[]` | 17 rows, constant order | `{ uri, group, role (null unless department), read, notes, folders, kinds: { rule, case, fact, event, document, other } }`; unread root: `read: false`, counts `null`, row kept; daemon `NOT_FOUND`: `read: true`, `0` |
| `recent[]` | 12 rows | newest files over read roots: `{ uri, root, kind, size, mod_time, locked }` |

A root whose walk returns `node_limit` nodes is unread (`truncated`), never a short count.

**`GET /api/openviking/tree?uri=<folder>&offset=0&limit=30`** (`limit` 1-200) — one folder level: `/api/v1/fs/tree` `level_limit=1`, `include_abstract=true`, plus a no-abstract deep walk of the folder for counts. File uri: `400 NOT_A_FOLDER`. `200`: `{ uri, root, notes, folders, last_change, abstract, abstract_reason, total, children[] }`; `children[]` newest first: `{ uri, name, is_folder, kind, size, mod_time, notes (folders; null for files), abstract, abstract_reason, locked }`.
- Bad `limit` or `offset`: `400 INVALID_ARGUMENT`.
- Count walk returns `node_limit` nodes: the level is still served; `notes`, `folders`, `last_change` and child-folder `notes` are `null`; `counts_reason: "truncated"` (else `null`). Never a short count, never an error.
- The owner gate runs before the setup-file lock: `identity.md` under an unreadable root answers `403 OWNER_ONLY`; under a readable one, `403 SETUP_FILE_LOCKED`.
- `abstract_reason`: `null` (text present), `"not_ready"` (daemon `[Directory abstract is not ready]`), `"none"` (empty; file rows always), `"locked"`. Never placeholder text.

## G3 Read a Note or Folder

**`GET /api/openviking/note?uri=&level=abstract|overview|full`** — `full` on open only, never in a listing. `level` other: `400 LEVEL_INVALID`; `full` on a folder: `400 NOT_A_FILE`. Backed by `/api/v1/fs/stat` (every call) plus `/api/v1/content/{abstract,overview,read}`. `200`:

| Field | Type | Null / meaning |
|---|---|---|
| `uri`, `root`, `kind`, `is_folder`, `size`, `mod_time` | | from `fs/stat`; `mod_time` is what G5's `opened_mod_time` sends back |
| `level`, `text` | string \| null | `null` with `text_reason` `"not_ready"` / `"none"`; full text never cut |
| `text_of` | uri | whose text it is: for a file's `abstract` / `overview` the daemon answers its folder's (gap D1), so `text_of` = the folder |
| `last_write` | object \| null | newest changelog line for the uri `{ role, source, task_id, ts }` via `readChangelogRecords`; `null` when none |

## G4 Search

**`POST /api/openviking/search`** `{ mode: "meaning" | "exact", query, roots[], limit }`. `query` 1-500 chars trimmed; `roots` non-empty, each exactly one of the 17 (`400 ROOT_UNKNOWN`); `limit` 1-200, default 12 (meaning) / 50 (exact); else `400 SEARCH_INVALID`.
- **meaning:** one `/api/v1/search/find` `{ query, target_uri: roots, limit }` (17 targets answered in one call, 19 ms); hits from `memories[]` and `resources[]`.
- **exact:** one `/api/v1/search/grep` per root `{ uri, pattern, case_insensitive: true, node_limit: limit }`, `mapWithLimit` 4; the query is regex-escaped (the daemon's `pattern` is a regex).
- `200`: `{ mode, query, checked_at, total, truncated, results_partial, unread_count, unread_roots[], locked_hidden_count, hits[] }`; `hits[]`: `{ uri, root, kind, score, relative, abstract, line_number, line_text, size, mod_time }`. `score` raw (meaning; `null` exact); `relative` = `score / max(score)` in this response, computed once server-side, the page never recomputes; `abstract` = the hit's own (meaning) else `null`; `line_number`, `line_text` (exact) else `null`; `size`, `mod_time` from `fs/stat` per unique uri, `null` if that read fails.
- A root whose grep fails is in `unread_roots`; the rest still ship, `results_partial: true`. `find` cannot name a failed root (gap D3): a failed `find` is `502`.
