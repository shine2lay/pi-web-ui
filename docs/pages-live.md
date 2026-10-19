# Roles stays live when you come back to its tab

Ops queue task #244 (accountable lead: Ops; standalone). The owner, 2026-10-18 (m58098): "make it so that roles and initiatives are always connected when i am on page, i hate that it says reconnecting for along time when i change tabs".

This task does the shared pieces and the Roles page. The Initiatives page follows in its own task after #227, because #227 changes the same Initiatives data (Ops note n209). Checks kept minimal at the owner's word (m55390, m55423): focused tests, one sealed browser return test, the normal land gate and the deploy checks; no review rounds.

## Evidence before the change

From the connection log `~/.pi-web-ui/conn-events*.jsonl`, Oct 17-18:

- 21 times the tab came back with a connection problem. 13 of them lasted 10 s or more (p50 18 s, p90 133 s; these counts include time the tab was hidden).
- 11 of the 21 began with the socket closed (code 1006) while the tab was hidden; 8 began with the server going quiet.
- Catch-up after the socket reopened was short: p50 1.5 s, max 13.5 s.
- The Initiatives first load takes 6.7-66 s because it waits for the Roles overview (n209), so a full Roles overview is slow to build. Every new Roles watch asks for a full one, and the page shows "Loading…" or "Disconnected… Reconnecting does not confirm it" until it arrives.
- The log can't yet say how long the banner was on screen after coming back.

## H-PAGES-LIVE-1: the wait is the page waiting for a freshly built overview

**Wrong, and the evidence.** The wait after a tab switch is the Roles page waiting for a freshly built full overview (seconds to a minute when the server is busy), not the socket. Evidence above.

**One change.** The server answers a new full Roles watch at once from its last built overview, marked with that overview's time, then sends the fresh one. The page keeps the last data on screen with a small "Updating…" note, instead of the Disconnected banner, for up to 8 s.

**Expected, and how it's measured.** Fresh Roles data on screen within 3 s p90 after coming back: the sealed browser return test (60 s hidden with the socket closed, 10 runs), then real returns from the connection trace (shownMs).

**What would prove it wrong.**

- The baseline already shows the first full answer to a new Roles watch within 1 s p90: the wait is elsewhere. Then a new hypothesis is written before any code changes.
- With the change, the sealed return still takes more than 8 s.

**Kept honest, whatever the result.**

- The "Nothing needs you" all-clear stays withheld until fresh data confirms it.
- Last data always shows its time.
- The red or amber state still appears after 8 s without fresh data.
- The 8 s grace for the app's "Reconnecting…" note applies only while Roles or Initiatives is the visible view; chats keep today's behaviour.

## Baseline: a new Roles watch on the live server (2026-10-18 21:32-21:36 PDT)

A throwaway read-only client (`~/kept-from-tmp/2026-10-18/pages-live/watch-timing.mjs`, results `baseline.jsonl`) opened a socket to 127.0.0.1:8787 the way pi-web-deploy's page check does, sent hello and then `roles_watch {full: true}`, and nothing else. 10 tries, 20 s apart (nearest-rank percentiles):

| From the watch to | p50 | p90 | max |
|---|---|---|---|
| the first full answer | 0.14 s | 0.36 s | 0.38 s |
| the age of that answer (now minus its checkedAt) | 7.0 s | 10.0 s | 10.9 s |
| a newer look (checkedAt strictly newer) | 0.76 s | 2.5 s | 8.3 s |

hello to ready: 0.01 s p50, 0.10 s p90. Each answer was about 445,000 characters.

**H-PAGES-LIVE-1: MISS (disproved before any code).** The first full answer already comes within 1 s p90. The server already replays its last overview at once: `RolesWatch.watch` in server/roles-overview.ts sends `last` with its checkedAt, then looks again 300 ms later. So with the server warm, the wait after a tab switch is not the server building the overview.

Something else turned up in the code. All 10 newer looks reached the client only because the overview had changed. An unchanged look is sent to a new watcher only with the 30 s heartbeat (`RolesWatch.lookOnce`). On a quiet day, a newly watching page would wait up to 30 s to be told its copy is current.

## Where the wait is: tab returns in the connection log

This covers `~/.pi-web-ui/conn-events*.jsonl` from Oct 17 00:00 to Oct 18 21:36 PDT. It counts only episodes whose note went while the page was visible (`episodes.mjs --stats` in the same folder). An episode runs from the "Reconnecting…" note coming up to it going.

| Kind | n | Note up, p50 / p90 / max | Chat catch-up after the new socket opened, p50 / p90 / max |
|---|---|---|---|
| Came back and the socket was dead: no answer to the return ping within 2.5 s, socket replaced | 20 | 4.2 / 8.9 / 11.7 s (plus 1 s before the note shows) | 1.6 / 5.8 / 7.9 s |
| The note came up while hidden and went after the return | 12 | 17.7 / 133 / 563 s (includes hidden time) | 2.2 / 6.3 / 13.5 s |
| Came back and the server answered the ping late | 31 | 0.3 / 1.3 / 2.4 s | none (same socket) |
| Not a return: the server went quiet while the page was watched | 68 | 6.6 / 20.4 / 41.7 s | 2.9 / 9.0 / 20.5 s |

The last row is the server stalls already traced in #157, #181 to #183. They are out of scope here.

What the page does on a return, from the code:

- The app's "Reconnecting…" note (web/src/use-chat.ts `refreshNote`) ends only when the window's **chat** content is back (`catchUpRef`, cleared by a snapshot). On the Roles view the chat isn't shown, but the note still waits for it: 1.6 to 2.2 s p50, about 6 s p90, up to 13.5 s.
- The Roles page's status pill turns red, "Disconnected · last received …", the moment the socket isn't open. It shows amber "Stale" when its last word is over 2 min old (for example after a long hidden spell, before the new socket answers). It shows amber "Asks unconfirmed: still checking" from every new watch until the server is heard looking again (up to the 30 s heartbeat when nothing changed).
- Meanwhile the Roles data itself is back about 0.4 s after a new socket's ready (baseline).

## H-PAGES-LIVE-2: the alarms on Roles wait for the chat and fire at the first gap, not for Roles' own data

**Wrong, and the evidence.** After a tab switch, the owner sees two alarms on the Roles page. The app's "Reconnecting…" note waits for the chat to catch up (about 6 s p90 after the new socket opens, up to 13.5 s). The page's red or amber pill fires the instant the socket drops or a watch is pending. But Roles' own data is back within about 0.4 s of a new socket. And when nothing changed, the server never tells a new watcher that its copy is current until the 30 s heartbeat. Evidence: the two tables above, plus the code.

**One change: on the Roles view, the alarms wait up to 8 s for Roles' own fresh data.**

- *Page.* Sometimes the data isn't confirmed: the connection is lost, a full watch is pending, a look failed, or the last word is over 2 min old. Then the Roles page keeps the last data with a calm "Updating… · last received HH:MM" pill. That lasts for up to 8 s, counted from the later of the wait's start and the tab becoming visible. Only after that does the red or amber pill show. "Fresh" keeps today's meaning: the server was heard looking again since the watch (`appliedAt`).
- *Server.* A new full watcher is confirmed by the first look that starts after it joined. It gets the overview when the data changed, or a heartbeat with the newer checkedAt when it didn't, instead of waiting for the 30 s heartbeat.
- *App note.* While Roles is the visible view, the "Reconnecting…" note ends when the socket is open, not in doubt, and Roles' data is fresh. The chat's catch-up no longer holds it there. It shows only after 8 s of visible waiting. While Initiatives is the visible view, the same 8 s grace applies; its own data signal comes with the next task, after #227. Chat views are unchanged.
- *Return.* When the tab becomes visible and the socket isn't open, a new one opens at once (checked, and fixed where it doesn't).

**Expected, and how it's measured.**

- Sealed browser return test: Roles open, then the page hidden with its socket closed for 60 s, then shown again; 10 runs. Fresh Roles data (`appliedAt`) within 3 s p90. No red or amber pill and no "Reconnecting…" note when fresh data is back within 8 s. The same test on the old code gives the "before" numbers.
- Live: the first full answer stays within 1 s p90 (10 tries).
- Real use: shownMs on Roles returns, p90 within 3 s.

**What would prove it wrong.**

- The sealed return still takes more than 8 s.
- Real Roles returns' shownMs p90 is over 3 s. That would mean the wait is in the reconnection itself: the 2.5 s probe of a dead socket, which this change doesn't shorten, or server stalls. Then a new hypothesis follows.

## Sealed browser return test (2026-10-18 22:40-22:50 PDT)

`tests/pages-live-test.mjs`, run with `node tests/run-sealed.mjs --no-build pages-live-test`. The test's own server with one fixture role, headless Chrome. In each run, Roles is open and live, then the tab is hidden and frozen and its socket cut (1006). After 60 s the tab is shown again. 10 runs, sampled every 100 ms. The control is the same test on the code before this change (`mine` at 033cd1d8).

| | Before (control) | After |
|---|---|---|
| Fresh Roles data on screen after coming back, p50 / p90 / max | 0.43 / 0.53 / 0.53 s | 0.32 / 0.42 / 0.43 s |
| Runs with a red or amber pill before fresh data | 10 of 10 ("Disconnected" at 5-11 ms) | 0 of 10 |
| Runs with the "Reconnecting" note | 10 of 10 | 0 of 10 |
| Runs showing the all-clear before fresh data | 0 | 0 |
| Trace records with view "roles" and shownMs | 0 of 10 (fields didn't exist) | 10 of 10, shownMs 0.31-0.32 s, cause "close 1006" |

What the owner saw on each return. Before: "Disconnected · last received …" in red, then "Asks unconfirmed: still checking", then "Live". After: "Updating… · last received …", then "Live".

In this fixture the data comes back fast either way. The change is that the alarm and the note no longer flash up during that short wait. The live server is slower and busier, which is why the real-use shownMs below is the measure that counts.

Two faults turned up while building the test, and both were fixed before the numbers above:

- The footer's new "Updating" hook was below an early return (React error #310, a blank page). A focused jsdom test didn't catch it, so the sealed test's "no page errors" check is the guard.
- The trace lost the cause ("unknown") because the Roles state change woke the note before the close was noted. The cause is now noted first, and the test checks it.
