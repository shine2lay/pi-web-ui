# Design B: durable usage by Pacific week

Ops #422 (B2), project `automatic-cost-accounting`. Accountable lead: Ops. This is a library only: no caller, startup hook, install, restart, budget change, model call or retention job. B3's pass and B5's seal must write through this store, not W1. W0, W1 and W3 are unchanged.

## Authority and hypothesis

The owner chose **Build B, keep all usage detail** on October 22, 2026 at 08:46 Pacific, record `dr-8795124dce74`. Basis: Ops #420 `PLAN.md` §5.8, SHA256 `549f14bc3f305e1db231a308d29fbf8a126fb301553a8c35cee609a5b0acb237`, kept at `/home/shinelay/kept-from-tmp/2026-10-22/cost-w6-seam-replan/PLAN.md` (code basis `d1d55bc4`, with S1 since landed as `d2efdd10`). Architecture's route review `rm-8fb0f6a3` (reply to `rm-0db46a40`) supplies M1–M6: lifetime writer ownership, versioned files, `O_APPEND`/`fdatasync`, checkpoint as the commit point, persisted W2 reader receipts, and dispositions/gaps that remain partial after restart.

**H-B2:** W1's lifetime-growing replay is the wrong shape for B. Put records and their cursors in independent weeks; reload work should depend only on the chosen week's records. Expect reload of 250,000 records, including rebuilding totals, within **1 second**; disprove it if slower or if a crash loses a committed record. Architecture M4 clarifies “synced”: the checkpoint commits the batch. Synced bytes beyond it are not yet committed and must be re-read, not recovered into the totals ahead of their source cursor.

Initial record-only reload rescanned and revalidated JSON and missed the target (2.10 s). H-B2b: skip parsing a committed prefix for the proof/index pass, after verifying its SHA256, and parse it once if the caller requests records. That measured 0.84 s including a totals fold (HIT for that workload). Architecture M5/M6 then required durable W2 receipts and unknown dispositions. H-B2c, written before that change: keep the checkpoint as the sole commit point for **both** logs, persist W2's exact validated reader objects and preserve original/alias/unverified/unresolved/gap dispositions. Expect the same one-second reload with a receipt per record, crash/no-crash totals equal, W2 able to read its receipts after restart, and unknowns still partial. A slower reload, W2 refusal or double count disproves it.

H-B2d (gate correction): the first full gate rejected even the week store's type-only `SourceCursor` import, because W0's exact importer allowlist deliberately includes erased types. Keep that safeguard unchanged; describe the checkpoint's two-field cursor shape locally instead of importing the collector. Expect the full gate to pass without a new engine dependency; a remaining importer finding or changed cursor behavior disproves it.

**Result: H-B2 / H-B2c MISS on speed**, not relabelled as a hit using the proof-only timing. The receipt-inclusive first reload plus totals fold took **1.677 s**. Correctness cases passed their crash/integrity assertions; the one-second expectation remains unmet. The store still reads only the specified week, with no lifetime log or all-week replay. Measurements and limits below make this limitation explicit for B3 and the reviewers.

## Files and records

`UsageWeekStore.open({ dataDir, lease })` owns `dataDir/usage-week/` (normally `~/.pi-web-ui/usage-week/`):

- `lock`: lifetime writer's PID, using the existing `GuardFileLock`.
- `week-YYYY-MM-DD.log`: header, then append-only numeric attempt/gap records.
- `week-YYYY-MM-DD.receipts`: header, then W2 first/same-call lookup receipts.
- `week-YYYY-MM-DD.checkpoint`: #304 file cursors, W2 ledger cursor, byte lengths/counts/SHA256 for log, receipts and optional adjustments; its own SHA256.
- `week-YYYY-MM-DD.sealed`: frozen week/subject totals, rate-version counts, coverage and sorted 16-byte key digests, lengths and SHA256.
- `week-YYYY-MM-DD.adjust`: header, then append-only late records for a sealed week.

All headers are `usage-week-log/1` with a `kind` and week; checkpoint and sealed formats are `usage-week-checkpoint/1` and `usage-week-sealed/1`. A different version is unavailable (`store-version`), not empty, not silently converted. JSON is deterministic. Appended lines begin with the fixed key field so reload can index a SHA-proven prefix without parsing every value twice.

A record has exactly `k,d,at,src,off,len,sub,usd,tok,rate`:

- `k`: SHA256 of B3's stable attempt key; a gap needs a stable file-position key too. The first record per key wins. B3 must finalize a disposition before committing it; this format does **not** replace an unresolved record with an original under the same key. A later resolution protocol would need a deliberate format change.
- `d`: `original`, `alias`, `unverified`, `unresolved` or `gap`. Counts retain all five; only originals contribute money/tokens. Gaps require positive skipped bytes and null amounts/tokens/rate. Unknown amounts and token counts remain separately counted, never silently known zero.
- `at`: canonical UTC timestamp, assigned to a Pacific Monday week. `src`: 16-hex source-file digest; `off`: byte offset; `len`: source line size or skipped bytes. The store never opens a source chat.
- `sub`: role/project/initiative identifier links, plus optional task queue digest/number/addedAt. `usd`: exact contract decimal, up to 12 fractional places, **not a float or rounded integer micros**; this preserves sub-micro amounts. `tok`: input/output/cache-read/cache-write counts (each safe integer or null); `rate`: bounded version identifier or null.

M6's disposition and byte-length fields make the measured typical record **390 B**, rather than the route sketch's ~334 B. Maximum record line is 1,024 B. Unknowns and gaps are retained as usage detail too.

Receipts have exactly `k,kind,r`. `ledger-native` stores W2's validated `LedgerNativeReceipt` unchanged; `same-call` stores its `LedgerSameCall` canonical fact and evidence identifier under `sha256(JSON.stringify([provider,responseId]))`. No chat text or raw source path is copied: only closed numeric/identifier contract fields. `receipt(week,kind,key)` returns the reader object or proven absent `null`; an unloaded/unavailable week throws, so callers must not turn that into absence. W2 can attach an alias to a native receipt once (`alias: null` to a valid alias, all other fields unchanged); other changes are refused. Both kinds can share a key. Receipts are indexed by kind/key and read at their byte offset on demand, not all held as fact objects in memory.

## Calling and committing

All operations are synchronous and **worker-only**, matching W0's meter-worker resource fence. Main-thread open reports `worker-required`. The host supplies one four-byte `SharedArrayBuffer` for each data directory, shared across every generation of its worker. Do not make a fresh lease to displace a worker that may still exist. A separate process is excluded by the PID lock; a stale dead process can be recovered, a live PID (including our own PID) is never evicted. Waiting returns `waiting-for-previous-writer`. Ownership is rechecked before every write/rename, not only when opening.

1. Open and check `status()` is ready. `listWeeks()` reports week files, abandoned scratch, quarantine and unexpected entries, without deleting them.
2. `reload(week, each?)` validates that week before giving any records to `each(record, "log" | "adjust")`. It returns `empty`, `open`, `sealed` or `unavailable` with a content-free code. Use `sealedTotals(week)` for historical totals without reloading old record or receipt indexes. Avoid retaining all history in one worker's loaded-week cache.
3. `append(week, records, receipts?)` validates the **entire** bounded batch, dedupes it and appends+`fdatasync`s the new lines. It does not advance source cursors. Then `checkpoint(week, { files, ledger })` commits lengths, hashes and cursors together. A receipt-only commit is supported. An unchanged checkpoint is idempotent.
4. On reopening, hash exactly the checkpointed bytes, check lengths/counts, build keys and receipt offsets, then cut every file back to its checkpointed length and `fsync`. Without a checkpoint, keep only headers. `dropped` reports **bytes** discarded from records/receipts. Synced but uncommitted records, complete lines, torn lines and receipt tails are all discarded together. Resume source reading from the returned checkpoint. Commit first, publish its totals/cursors second.
5. `seal(week, coverage)` requires that the Pacific week has ended and the current log/receipts are checkpointed. It folds originals exactly, preserves disposition and unknown counts, and refuses complete coverage if unverified/unresolved/gap records remain. It writes the sealed totals and sorted truncated key set atomically; the log and receipts are retained. A repeated seal is refused as `sealed`; read the existing result with `sealedTotals`.
6. `adjust(week, records, receipts?)` accepts late attempts only for an already sealed week, dedupes against the base sealed keys and adjustment keys, then appends+syncs and writes its checkpoint before returning. Publish only after that succeeds. It never rewrites base sealed totals; readers combine base with committed adjustments. Post-seal receipts remain checkpointed alongside adjustments.
7. `close()` releases descriptors, PID lock and this store's held lease. On uncertain worker death the host must not forcibly clear the lease. `quarantineWeek` is an explicit corruption-handling operation, not automatic repair; it renames damaged files aside, retains their bytes and lets that one week be rebuilt later from source. No production caller is added here. `deleteWeek` exists and is tested on synthetic data **but is never called by production code**. No retention policy or deletion run is authorized.

The SHA256 proof precedes `each`, so a late hash mismatch never hands the caller a plausible partial total. A SHA, size or version failure marks just that week unavailable; its bytes stay for diagnosis and other weeks can proceed. General I/O, unsafe paths or lost ownership stop the store until it is reopened. Refused arguments write nothing and leave it ready. Zero is returned only for a genuinely empty/known zero count, never as the substitute for an unavailable week.

Sealed history reads prove the sealed totals/key digest, not the old numeric log's contents. `reload` of a sealed week checks the old log's recorded length/header, proves its receipt prefix and live adjustments and uses the sealed keys; `seal` itself proved the full numeric log. A same-length later mutation of the retained base log is not detected by a totals-only history read. An offline detail-integrity audit must hash it against the stored log SHA; it must not use the history read as that audit.

## Durability and custody

Appended logs use `O_APPEND | O_NOFOLLOW`, a checked private regular descriptor and `fdatasync`. Headers, checkpoints and sealed snapshots use a random same-directory `O_CREAT | O_EXCL | O_NOFOLLOW` temp, complete write, `fsync`, rename and directory `fsync`. A crash around the seal rename leaves either the old open checkpoint or a fully verified sealed snapshot. Abandoned temps remain 0600 and are counted, not swept. The log inode is unchanged by appends/checkpoints. The checkpoint is the sole commit point; a process crash before it cannot advance either source cursor or counts.

The root is 0700, files 0600 (tested by `stat`, including with a permissive umask). Every path component is opened without following symlinks; accesses are anchored to owned directory descriptors through Linux `/proc/self/fd`. Symlinks, hard-linked files, wrong owner, unsafe parent/root replacement, bad private modes and a replaced lock are refused. These are local application-data protections, not isolation from root or a hostile writer running as the same UID. Identifiers may still be sensitive metadata; the numeric store is not anonymous data.

Bounded per-call/per-week work: 4,096 records per append, 4 MiB record bytes, 16 MiB receipt bytes; 16 KiB per receipt; 500,000 records per log; 1,000,000 receipt lines; 4,096 source-file cursors and 4 MiB checkpoint; 64 MiB sealed file; 8,192 directory entries. Smaller test limits are supported; greater/invalid ones are refused. Capacity means `store-capacity`, not eviction. Sealed keys are first 128 bits of SHA256, sorted for binary search; retain full log keys. No cryptographic claim of zero collision risk. File formats/caps are code constants, not new user settings.

## Verification and measurements

`tests/unit/usage-accounting-week-store.test.ts` runs the real module in isolated workers (old generation stops before a restart), in synthetic temp data folders, never real chats. Its fixture is `tests/unit/usage-accounting-week-store-fixture.ts`. Deterministic cases cover mode bits, same-process/other-worker exclusion, lost lock, unsafe paths, bounded/all-or-none append, duplicate attempts/receipts, exact money/tokens, corrupt or future files, mismatch withholding **all** callbacks, independent bad-week quarantine, no-checkpoint and torn-tail recovery, checkpoint/receipt write/sync/rename crashes, seal rename crashes, adjustment crashes, W2 reader reconstruction and alias attachment, unknown/gap restart and complete-coverage refusal, and synthetic-only delete. Crash outcomes are compared with no-crash totals, including unkeyed unknowns; committed records remain once, uncommitted records are re-read once. Pacific DST end is November 1, 2026: both 01:30 occurrences stay in the October 26 week, whose end is November 2 at 08:00 UTC (169 hours), not November 2 at 07:00 UTC.

Opt in, on a temporary folder, without altering the normal gate:

```sh
TZ=UTC scripts/sealed.sh env B_LARGE_CASE=1 npx vitest run tests/unit/usage-accounting-week-store.test.ts
```

The 250k fixture appends a different week too, then starts a new worker. Each record has a persisted same-call receipt. Three reload+fold and three proof-only times are reported, plus append/checkpoint/seal, average of 1,000 validated receipt lookups, heap and final sizes. The first reload+fold decides `hB2: hit|miss` at the unchanged 1,000 ms target. A timing miss is reported, not turned into a correctness failure on a shared machine; count, receipt, exact totals, other-week truncation and seal equivalence remain asserted. Output starts `B2-WEEK-STORE-MEASURE`.

October 22, 2026, 10:38 Pacific, 256 MiB old generation / 32 MiB young / 8 MiB stack (same as the meter worker), 250,000 records and 250,000 ~903 B receipts:

- Append + sync, in bounded batches: 7,116.13 ms.
- Checkpoint: 10.32 ms.
- Reload + B3-like exact-money fold (first, then repeats): **1,676.57**, 1,310.80, 1,033.73 ms.
- Proof/index-only reload: 718.99, 809.51, 827.08 ms.
- Receipt lookup (1,000 lookups, mean): 0.0678 ms.
- Other week's uncommitted 250k records (truncate, not scan): 21.45 ms.
- Seal: 1,143.88 ms.
- Read sealed totals only: 0.419 ms.
- Sealed reload with receipt index: 470.94 ms.
- Heap after open reload: 73,194,296 B.
- Numeric log / receipts: 97,390,453 / 225,638,953 B.
- Sealed totals + key set: 8,001,403 B.

Reload/fold and seal agreed exactly on USD `197.9734188`. This is ~323 MB including the W2 receipts, not the original record-only ~91 MB timing. No smaller target, missing receipts, warm-only number or proof-only substitution is used to claim H-B2 hit. No performance change is inferred from this single shared-host run.

The full sealed `CI=1 TZ=UTC scripts/check.sh` passed on October 22, 2026 (exit 0, including build and 74 real-PTY checks); H-B2d HIT with the importer safeguard unchanged. Only explanatory comments and this result were updated after that gate. Review/landing receipts are recorded with the task. No live install is part of B2; B4 owns it. Undo before use: revert this commit. Once B3/B5 write it, rollback code only through the normal install plan and retain all week files; do not delete or silently feed them to W1.
