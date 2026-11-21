# stall-watch: wake retention, the page, the locales fix and the 24 h verdict

Part of [stall-watch.md](stall-watch.md) (what the watch is, its rules, how to switch it off, and its parts).
The delivery, ledger and caps these build on are in [stall-watch-wake.md](stall-watch-wake.md).

#### H-STALL-WAKE-RETENTION-1 (written before the retention fix)

- **Wrong, with evidence:** the original ledger reader filtered every line by `now - at < 30 days`. That loses
  sent and skipped steps of an unresolved chain after a long pause/restart; the role store cannot recover
  skipped steps. A compact marker was therefore insufficiently durable for the promised no-repeat guarantee.
- **One change:** retain every consumed step with its original time until positive registry/finding evidence
  proves that stretch ended, then retain it 30 more days. Never infer an end merely from missing findings.
- **Expected:** fixed fixtures twice show no replay after >30 days/reload, partial chains retain their gap,
  suppression/failed reads keep markers, verified end +30 days allows cleanup and a new stretch starts normally.
- **Disproof:** any replay/reset gap, marker lost under suppression/read failure, or verified-ended markers
  remaining beyond their retention window. **Result: HIT** in the corrected sealed gate (land 125-10cfad):
  all fixed retention cases passed twice, including unresolved/partial chains after 30 days and reload,
  conservative suppression/read failure, and verified end +30 days cleanup with a new stretch.

### On the Initiatives page

The work page records have optional `stall:{rule,since,asked:[{role,at}]}` from the last findings and sent
steps, and `wait:{until,why,at,by}` from #282/#283. Existing project row, loose-project item and initiative
card note slots show “No open task since <time> · <Role> asked <time>”, “Nothing recorded since …”, or
“Waits until <date/time>: <why>”. Owner steps read “Owner (through COO)”. No new slots or layout changes.

### Final-check correction: H-STALL-WAKE-LOCALES-1

- **Wrong, with evidence:** land 124-c44f62 was rejected. The 6 new message labels exist in the built-in
  English dictionary but not the 8 downloaded language packs, so `locales.test.ts` fails key and placeholder
  parity (2 failures). Prettier also rejects one overlong new dictionary line. No code reached live.
- **One change:** complete those 6 labels in every pack, preserving `{id}` / `{names}`, and wrap the dictionary
  line exactly as the formatter requires. No message behavior or checks change.
- **Expected:** the final sealed land gate passes locale parity for all 8 packs and formatting, with the
  delivery/retention fixtures still passing twice. **Disproof:** any missing/empty label, placeholder mismatch,
  formatting failure or delivery regression. **Result: HIT** in the corrected sealed gate (125-10cfad):
  459 unit files, 6,653 passed / 6 skipped, plus protocol, PATCHES.md, typecheck, lint and formatting.
  No check was bypassed or loosened.

### 24 h verdict

`node scripts/stall-verdict.mjs --since <first-on-round ISO> --hours 24 [--json]` is read-only. It counts
flagged stretches, lead actions, messages/steps, cap hits, duplicates, cap breaches and owner-step gaps from
`stall-watch.jsonl`, `role-messages.json` and `~/.pi/agent/work/events.jsonl`. Fixtures use `--ledger`,
`--store` and `--events` overrides. Use the actual first-on timestamp, not the dry round's time.
