# Thinking for all chats

Moves every chat on one thinking level to another, without stopping anything that is running. Built for the owner's order of 2026-11-03 (via COO rm-de2c4bf8): "can you set every chat's effort to extra high instead of max, we are burning thru tokens too fast". Ops #777.

## How to use it

A server action only; there is no button. Send over the app's WebSocket, after `hello`:

```json
{ "type": "thinking_all_chats", "from": "max", "to": "xhigh", "dryRun": true }
```

- `from`, `to`: one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Missing, unknown or equal levels are refused with a clear error and nothing changes.
- `dryRun: true` only counts. Leave it out (or `false`) to do it.
- The answer is one `thinking_all_chats_result` message (`ok`, `changed`, `skipped`, `failed`, `failures`, `settingsFileEntries`, `settingsCopies`, `error`) plus one notice.

Ops' client: `node /home/shinelay/kept-from-tmp/2026-11-03/thinking-xhigh/thinking-all-chats.mjs --from=max --to=xhigh [--apply]` prints the server's result.

## What it changes

1. **Open chats** in every window, queue task chat, queue home, scheduler and participant chat (the process-wide chat map): a chat on `from` goes to `to` through the SDK's own `setThinkingLevel` (persist false), inside the chat's model lane, so a model switch in progress can't put the old level back. A running reply goes on; its next model request uses the new level. Chats on any other level are left as they are. A chat whose model has no `to` level is reported in `failures`; the rest still move.
2. **pi's settings file** (`~/.pi/agent/settings.json`): `defaultThinkingLevel` and each `modelThinkingLevels` entry equal to `from` become `to`, in one read-modify-write under the SDK's own lock (`server/thinking-level-settings.ts`). It is written at most once, and not at all when nothing holds `from`. Every other setting keeps its value (the file is written back as 2-space JSON, like the SDK writes it).
3. **Each live chat's in-memory copy** of pi's settings gets the same move (no write), so the chat's next model or account switch (failover, rotation) can't bring `from` back from a stale per-model map. A chat's own project settings keep any key they set themselves.
4. **Older chats**: the move is recorded as `{from, to, at}` (`allChatsThinking` in `client-state.json`'s `__settings__`). When a chat born before `at` next opens on `from`, with no thinking change of its own after `at`, it opens on `to`. Chats born later, or set again after the move, keep their level. Same dated rule as All chats for models (`server/model-all-chats.ts`); only the latest move counts.

Not changed: chat transcripts (nothing is written into them), running turns, levels other than `from`, queue profiles and task plans that name a level, and the per-chat picker.

## Checks

`tests/unit/thinking-all-chats.test.ts` (sealed; fails on the old code): validation; a streaming chat on max moves and an idle one on high stays, the stream isn't stopped, the in-memory map moves, the file is written once; a second run changes nothing and writes nothing; a dry run changes nothing; a model without `to` is reported; older chats on reopen (and a later pick and a newer chat keep theirs); bad settings JSON is refused; and a real pi run on the faux model where the next request of a running reply uses the new level and the running tool step isn't rerun.

## Undo

- The code: revert its commit and `pi-web-deploy`. The saved `allChatsThinking` record is then ignored.
- One run: run it the other way (for example `--from=xhigh --to=max --apply`). That also moves chats that were on `to` before the first run; the exact earlier settings file values are in its backup, for 2026-11-03 `/home/shinelay/kept-from-tmp/2026-11-03/thinking-xhigh/settings-thinking.before.json`.
