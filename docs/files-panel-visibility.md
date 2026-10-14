# Built-in Files visibility and reply binding

Two independent labelled patches implement Ops #160 (P2 of audit #151):

- `file-list-correlation`: optional request-local echo and panel reply binding;
- `lazy-files-visibility`: defer only built-in automatic directory listings.

## Hypothesis and scope

H-LAZY-P2: the ready bootstrap plus hidden-tab polling/cwd/watch refreshes fetch unseen directories. A visible document alone does not mean Files is visible. One effective-visibility gate and a retained dirty flag should eliminate hidden automatic requests without resetting the mounted browser or blocking explicit operations. Any hidden fetch, wrong/stale visible folder, duplicate reveal, lost operation or cross-window state change is a miss.

The fixed old-source clock records **12 hidden-tab polls in 120 seconds**, hidden initial ready work, and eager hidden watch/cwd work. The new frozen bar is zero hidden automatic listings; first reveal and return after a hidden change each request the correct directory exactly once. Polling remains ten seconds while visible. Allow at most 100 ms extra visible fake-clock dispatch latency, recorded separately from initial chat display and network/response time.

This is a request-count/freshness change, **not a heap-leak fix**. Server dirty events may continue. No zero-watch-activity, measured heap saving or invented network-speed gain is claimed.

## Per-window effective visibility

`App` passes geometry from `filesPanelVisible`: chat view only; desktop right panel not collapsed, or mobile right drawer open. `RightPanel` additionally requires:

- the actual resolved `SlotTabs` selection is Files, including saved, keyboard, programmatic and fallback selection;
- the Files contribution is not user/plugin-hidden;
- this document is visible;
- the socket is open and generally ready, and its authoritative snapshot has arrived.

The last item is a separate, non-persisted `useChat().filesReady` bit. General ready precedes the fresh snapshot and may still expose a retained old cwd after reconnect. Only the Files automatic gate waits; chat ready, reducer/history/context, snapshot/delta identity, dialogs and normal APIs do not change.

`SlotTabs` reports its resolved active id through an optional callback. It does not move tab persistence into another store. Each window derives its own geometry and selection; no new cross-window storage listener is added.

## Refresh and retained state

The FileBrowser is not unmounted to obtain laziness. Hiding preserves the current folder, scroll, clipboard/selection and running operations. A cwd change still resets the folder to the workspace root, as before.

Automatic work marks the directory dirty while hidden/offline. Reveal, reconnect and cwd changes share a zero-delay dispatch, with cleanup cancelling superseded jobs. A matching watch burst shares one 40 ms job; another folder's event is ignored. The retained watch event is consumed once, so changing folders does not replay an old event. A live document check also fences the small gap before React commits a visibility event. Hidden windows have no Files polling interval.

`request()` itself remains explicit and ungated. Crumbs/navigation, the refresh control, picker/preview, uploads/downloads, clipboard mutations and transfer completion keep their normal behavior, including an operation started before hiding. Only the unconditional built-in `list_files` in ready bootstrap is removed; the general API and `files` reducer remain.

## Request-local correlation

Path-only matching cannot distinguish a late reply from an old cwd's root (both use an empty wire path), A→B→A, or another window's same-folder listing.

The built-in panel adds an optional opaque `requestId`, a string at most 64 characters. Routing, both engine delegates and every FilesService listing branch echo it unchanged. The server does not interpret, persist or log it beyond the request in flight. A panel accepts only its current token plus current cwd/folder binding; unrelated or old replies cannot overwrite its accepted rows.

With no token, the serialized reply is unchanged. Explicit plugins and other callers do not need or receive a new contract. There is no server cwd tracker and no change to watcher ownership or lifetime.

## Qualification

- `tests/unit/files-list-correlation.test.ts`: three listing branches, input/boundary validation, delegate/routing binding and exact serialized untagged compatibility.
- `tests/unit/files-panel-correlation.test.ts`: old cwd root, A→B→A, cross-window and unsolicited/different-path replies.
- `tests/unit/files-panel-visibility.test.ts`: fixed clocks and listing metadata only; hidden 120 seconds, ready, saved/hidden tabs, geometry, document visibility, dirty/cwd reveal, watch bursts, reconnect, two windows, explicit operations, clipboard and latency.
- `tests/unit/files-ready.test.ts`: synthetic handshake/state metadata, no model fixture; ready/snapshot gap, reconnect cwd binding and explicit API availability.
- `tests/files-visibility-test.mjs`: sealed synthetic saved chat/workspace and browser only, never prompted. Covers initial hidden tab, correct folder reveal, hidden watcher events, desktop collapse, mobile drawer and another hidden window. Retains only outgoing listing metadata. Browser first reveal is reported separately from initial display, not as a network improvement.

The unchanged base fails nine correlation cases while passing the untagged control. Its hidden-tab count is exactly 12. Frozen cases are not waived by a passing repository gate or a passing install check. Installed look-only checks require source correspondence and the normal health checker; #155's checker-only fix is not a blanket health waiver.

## Undo

Use a fresh worktree and the normal gate, `wt land` and `pi-web-deploy`. Revert the labelled visibility commit to restore eager automatic listings; no saved-state/data rollback is required. The correlation commit can remain independently. Reverting correlation alone restores the old path-only freshness limit; do not claim token-level stale-reply protection afterward. Never hand-edit live chat/state files or change watcher settings as an undo.
