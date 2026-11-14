# Memory Explorer: Edit, Delete, Undo and the Change Record (`openviking-dashboard`, G5-G7)

Part of [spec.md](spec.md) (architecture #541). Every rule in [spec-explorer.md](spec-explorer.md) applies: owner check (OI-1), the 17 roots, the uri rule, the setup-file lock (G8), the error body.

## Rules for Writes

- **R-EXPLORER-WRITE-1 (A1):** these three routes are the only writes pi-web-ui makes: to `:1933` through its HTTP API, and to `memory-changelog.jsonl`. Never to storage files; no route takes a storage path.
- **R-EXPLORER-WRITE-2:** one note per call. No bulk delete, no folder delete, no recursive delete.
- **R-EXPLORER-WRITE-3:** one in-process lock per uri around stat -> read -> write (edit, delete, undo). A uri with a pending delete refuses edit and a second delete: `409 DELETE_PENDING` with that `operation_id`.
- **R-EXPLORER-WRITE-4:** the changelog line is appended after the daemon call succeeds. If the append fails the change stands and the response says `audit_recorded: false`.

## G5 Edit (applied now)

**`PUT /api/openviking/note`** `{ uri, content, opened_mod_time }`:
1. `content` a string up to 1 MiB (`413 CONTENT_TOO_LARGE`), `opened_mod_time` ISO (`400 EDIT_INVALID`).
2. `/api/v1/fs/stat`: `404 NOT_FOUND`; folder `400 NOT_A_FILE`; store `modTime` != `opened_mod_time` (compared as ms) -> `409 NOTE_CHANGED { current_mod_time }`, nothing written.
3. `/api/v1/content/read` -> `before` (kept for undo), `before_sha256`. Same sha as `content` -> `200 { changed: false }`, no write, no line (a retry is a no-op).
4. `POST /api/v1/content/write` `{ uri, content, mode: "replace", edit_source: "manual" }` (not called live; shape from the server source, build notes). Failure: `502 MEMORY_WRITE_FAILED`, nothing logged; the page keeps the text.
5. `fs/stat` again -> `after_mod_time`; append `owner_edit`; register the operation (`edited`).
6. `200 { operation_id, uri, changed: true, mod_time, undo_until, before_sha256, after_sha256, audit_recorded }`.

## G6 Delete (held 10 s)

**`DELETE /api/openviking/note?uri=`** — `fs/stat`: `404 NOT_FOUND`; folder `400 FOLDER_DELETE_REFUSED`. Else `202 { operation_id, uri, state: "pending", applies_at }`. Nothing reaches the store yet. When the window closes the server calls `DELETE /api/v1/fs?uri=&recursive=false` (not called live) and appends `owner_delete`.

## Undo

**`POST /api/openviking/undo`** `{ operation_id }`. The server's clock decides the window (`10 000 ms` from registering); the page's toast only shows it. Unknown id (also after a restart): `404 OPERATION_UNKNOWN`; closed or already ended: `410 UNDO_WINDOW_CLOSED { state }`.
- **Confirmation and the window (`R-OWNER-UNDO-1`):** undo is a write, so it needs its own assertion ([spec-explorer-owner.md](spec-explorer-owner.md)). The 10 s window is the time to ASK (`owner/write/options` with `{ method, operation_id }`), not to finish the prompt. For a held delete, a valid ask inside the window moves it to `undo_pending` and stops its timer. From there: assertion verified -> `cancelled`; the 60 s challenge expires unused -> `cancelled` too, recorded as unconfirmed. The delete never runs once undo was asked for. *Why:* the delete cannot be reversed and a cancelled delete destroys nothing, so every doubtful case resolves to "nothing deleted". For an edit, a valid ask inside the window keeps the undo open for that challenge's 60 s; expiry closes it with nothing written.
- **Delete:** cancels the held call. `200 { operation_id, state: "cancelled" }`; appends `owner_undo` then `owner_delete` (`cancelled`).
- **Edit:** `fs/stat`; `modTime` != `after_mod_time` -> `409 UNDO_REFUSED { current_mod_time }`, `owner_undo` (`refused`), nothing written. Else `content/write` of `before` (the text read just before the edit), `fs/stat`, `owner_undo` (`applied`); `200 { operation_id, state: "undone", mod_time }`.

## Operation States

| Kind | From | Event | To | Line appended |
|---|---|---|---|---|
| delete | (request) | accepted | `pending` | none yet |
| delete | `pending` | window closes, store `200` | `applied` | `owner_delete` `applied` |
| delete | `pending` | window closes, store error | `failed` | `owner_delete` `failed` + code |
| delete | `pending` | undo asked (`write/options`) | `undo_pending` | none yet |
| delete | `undo_pending` | assertion verified | `cancelled` | `owner_undo` `applied`, `owner_delete` `cancelled` |
| delete | `undo_pending` | challenge expires unused | `cancelled` | `owner_undo` `unconfirmed`, `owner_delete` `cancelled` |
| delete | `pending` | server stops | `not_applied_restart` | `owner_delete` `not_applied_restart` (shutdown hook) |
| edit | (request) | written | `edited` | `owner_edit` `applied` |
| edit | `edited` | undo, unchanged | `undone` | `owner_undo` `applied` |
| edit | `edited` | undo, changed since | `undo_refused` | `owner_undo` `refused` |
| edit | `edited` | 10 s pass | closed | none |

Why delete is held, not written back: a deleted note loses its summaries, index entries and `modTime`, so writing it back does not restore what was there. A restart inside the window means the delete does not happen (fail-safe). A hard kill skips the shutdown hook: nothing is deleted and no `owner_delete` line exists (gap D5). States live in memory only; the change record is the durable trail.

## G7 The Change Record (append-only, rule 31)

Contract `§7.4b` `R-CHANGELOG-1e` (`/home/shinelay/architecture-dept/conventions/openviking-contract/7.4b-changelog-classify.md`). One line per event in `/home/shinelay/.pi/openviking/memory-changelog.jsonl` (`0600`, one `O_APPEND` write per line); no line is ever amended:

```json
{ "timestamp": "2026-11-14T02:10:05.120Z", "role": "owner", "source": "owner_explorer",
  "action": "owner_edit", "operation_id": "op-1794631805120-3f9a1c2e", "uri": "viking://user/default/memories/preferences/user/design_revisions.md",
  "outcome": "applied", "undo_of": null, "before_sha256": "<64 hex>", "after_sha256": "<64 hex>",
  "summary": "owner edited a note: 412 -> 530 bytes", "diff": null, "task_id": null, "session_id": null }
```

- `action`: `owner_edit` | `owner_delete` | `owner_undo`. `outcome`: `applied` | `cancelled` | `not_applied_restart` | `failed` | `refused` | `unconfirmed` (an `owner_undo` whose confirmation was asked for and never given). `undo_of`: `"edit"` | `"delete"` on `owner_undo`, else `null`. `operation_id`: `op-<ms>-<8 hex>`, set at request.
- Hashes are sha256 of the whole text; `null` where there is none (`after_sha256` of an applied delete). Never the text itself, in no field.

**`GET /api/openviking/audit`** (existing route) reads these through `readChangelogRecords` and `CHANGELOG_ACTIONS` (`server/openviking/state-files.ts`, the one reader) and `auditActionOf` (`server/openviking/activity.ts`):
- `events[].action` gains `"owner_edit" | "owner_delete"`; `owner_undo` lines are not events.
- New fields on every event: `operation_id`, `outcome`, `undone` (`string | null`, `boolean | null`; `null` on non-owner events). `undone` is derived: a later `owner_undo` with the same `operation_id` and `outcome: "applied"`.
- `?owner_only=true` returns only owner events (the "Changes you made" list), so other writes never push them past `limit`.
- **`R-AUDIT-OWNER-1` (QA `rm-27a4d002`):** owner events are served only to a caller that passes the owner check for reads (`R-EXPLORER-OWNER-1`). Without it, `?owner_only=true` answers `403 OWNER_ONLY`, and plain `/audit` answers `200` with owner events left out and `owner_events: "withheld"` (else `"included"`), so a withheld list never reads as "no changes". Why: the list names notes in every role's private memory and shows a pending delete; that is the cross-root view only the owner has.
- Owner lines never count as session commits, promotions or rejections in `/overview`.
