# Memory Explorer: Daemon Calls, Gaps, Delete List, Prototype Chrome (`openviking-dashboard`)

Part of [spec.md](spec.md) (architecture #541), for [spec-explorer.md](spec-explorer.md) and [spec-explorer-writes.md](spec-explorer-writes.md).

## Daemon Calls, Verified Read-Only (2026-11-14, `openviking-server` 0.5.4)

Envelope `{ status: "ok" | "error", result, error: { code, message, details } }`. Read calls ran live; write calls were never called, shapes from `/home/shinelay/.openviking/venv/lib/python3.13/site-packages/openviking/server/routers/`.

| Call | Params used | Observed `result` fields | Missing / bad uri |
|---|---|---|---|
| `GET /health` | | `status, healthy, version, auth_mode` (top level) | |
| `GET /api/v1/fs/tree` | `uri, include_abstract, level_limit` (default 3), `node_limit` (default 1000) | `[{ uri, size, isDir, modTime ("…:57.000Z"), rel_path, abstract }]`; file rows `abstract: ""` | |
| `GET /api/v1/fs/stat` | `uri` | `{ name, size, mode, modTime ("…:57Z"), isDir, uri, isLocked, id }`; folders add `count` | `404 NOT_FOUND "File not found: <uri>"` |
| `GET /api/v1/content/abstract` | `uri` | string; folder not ready: `# <uri> [Directory abstract is not ready]` | `404 NOT_FOUND "Resource not found"` |
| `GET /api/v1/content/overview` | `uri` | string (folders and files) | |
| `GET /api/v1/content/read` | `uri` (also `offset, limit, raw`) | string | `404 NOT_FOUND`; folder `400 INVALID_ARGUMENT "Directory URI is not readable as a file"` |
| `POST /api/v1/search/find` | `{ query, target_uri: str \| list, limit }` | `{ memories: [{ context_type, uri, level, score, abstract, tags }], resources: [], skills: [], total }` | missing target: `200`, empty |
| `POST /api/v1/search/grep` | `{ uri, pattern, case_insensitive, node_limit }` (default 256) | `{ matches: [{ line, uri, content }], count, match_count, files_scanned }` | `404 NOT_FOUND`; bad regex `400 INVALID_ARGUMENT "Invalid regex pattern"` |
| `POST /api/v1/content/write` (source, `content.py:288`) | `{ uri, content, mode: "replace", wait: false, edit_source: "manual" }`; extra fields forbidden | not observed | |
| `DELETE /api/v1/fs` (source, `filesystem.py:321`) | `uri, recursive=false, wait=false` | `{ uri, estimated_deleted_count?, memory_cleanup?, semantic_root_uri?, semantic_status? }` | `NotFoundError(uri, "file")` |

Live sizes: 17 roots = 6,146 nodes, 5,781 files, walked without abstracts in 199 ms; the shared root with abstracts is 590 KB; `find` over 17 targets 19 ms; `grep` over 17 roots in turn 558 ms.

## Gaps Against the Hand-off

- **D1:** `content/abstract` and `content/overview` on a file answer its folder's text (`design_revisions.md`: overview identical to its folder's, 9,230 chars). A note's own one-line summary exists only in `find` hits. Contract: `text_of`.
- **D2:** `fs/stat` `modTime` is whole seconds; two writes in one second compare equal, and stat -> write is not atomic against other writers. Closing option, a two-way door for Backend: `content/batch-write` `expected_sha256` (`content.py:73`); the route body stays `opened_mod_time`.
- **D3:** `find` answers an absent target `200` empty, so it cannot name a root that failed.
- **D4:** the daemon does not isolate roles on `fs/tree` (role trees answer under shared headers); OI-1's check is the only gate on these routes.
- **D5:** a hard kill inside a delete's window leaves no `owner_delete` line (nothing was deleted).
- **D6:** hand-off figures 5,530 files / ~5,900 nodes; live 5,781 / 6,146. `grep` `pattern` is a regex, not words: the route escapes it.

## Obsolete Code and Tests to Delete (Rule 23)

Nothing left to delete. Done, with no shims:

- **Backend #164 (`78ef5693`):** the `/api/openviking/entries` route with its two modules, client methods and three unit tests; every `/overview` field the explorer does not read (`metrics`, `changelog`, `slots`, `auxiliary`, `live_activity`, and `observer.*` other than the three kept), with their builders, readers and asserts.
- **Earlier (backend #136, #153):** the queue-depth scraper and its drift test; the folder-count degraded condition; the reader of the sync-state file nothing writes.
- **Design #316 / #318:** the old dashboard view, its view-models and tests; the old prototype, check script and screenshots.

`/overview` (`screen_state`, `health_state`, `observer.{checked_at,last_commit_at,last_reachable_at}`) and `/audit` (G7) stay. A new reader of a removed field is a new feature and needs a spec line first.

## Prototype-Only Chrome Excluded from Production

Verbatim from `/home/shinelay/design-lab/results/openviking-redesign-20261113/explorer/handoff/proto-chrome.md` (Design, `cba4ad7`):

## Elements marked `data-proto-chrome`

- The top "Prototype controls" bar: fake app tabs (Chat, Queue, Roles, ...), the "Sample state"
  menu (Working, Loading, Memory down, Saving fails) and the "Theme" button. The real page sits
  inside pi-web-ui's own tab bar and theme setting.
- Every dashed "Preview: ..." note:
  - "this question isn't one of the saved real searches ..." (no-results and results views);
  - "the suggested questions show real search results; other questions only look through titles
    and 41 sampled notes";
  - "long notes are cut at 6,000 characters";
  - "only 41 sampled notes carry their full text".

## Faked behaviour

- Search: the five "Try" meaning questions and two exact-word searches are real saved answers
  from the store; any other question searches titles and the 41 sampled texts in the page.
  Production calls the store's meaning search and word search (HANDOFF G4).
- Full text and overviews: only 41 notes carry text; others say "The full text opens from
  memory." Production reads on open (G3).
- Edit, delete and undo change the page's own copy only; nothing is sent anywhere. The 10 s undo
  is a page timer. Production: G5, G6, G7.
- "Changes you made" is kept in the page; production reads it back from the change record (G7).
- Time: "now" is fixed to the snapshot time (2026-11-14 01:25 UTC), so ages read "4 min ago".
- Loading, Memory down and Saving fails are switched by the menu, not by a real server answer.
