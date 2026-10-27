# Actual-app pending recovery fixture (#570)

Hypothesis H-W2-RECOVERY-REACHABILITY-1 is recorded before implementation in
`docs/durable-w2-integration.md`. The implementation worker did not spawn (shared 16-agent cap);
this fixture and the read-only recovery surface are being implemented inline. No delegated result
or independent review is claimed.

## Scope

`tests/durable-core-recovery-test.mjs` uses the actual compiled app, real ChatInput/appAdmit/C and
native Chromium IndexedDB, with `ownServer`'s temporary data and an unreachable fastfail model.
It never reads model-bound request bodies, system prompts, tools or results. It records application
build hashes, not a frozen production pin. All user/file input is fixed synthetic content.

Cases:

- `reload-clone`: above-boundary complete file + second Unicode file, exact whitespace, actual
  native user record/send once, same-tab reload owner/complete export, real `window.open` clone
  conflict, unaccepted editable source retained, original owner/source not stolen or mutated.
- `quota`: native recovery-store put refuses; no prompt wire/clear; later explicit submit proves
  that the editable file bytes survived the failure.
- `abort`: actual native put succeeds, then its transaction is aborted; request success must not
  count as commit; no partial row/wire/clear, later explicit submit retains exact original bytes.
- `envelope`: full native payload transaction commits before envelope publication fails;
  reject-before-wire/clear, discover/export the same orphan after ordinary owner reload, no replay.

Complete artifact/row checksums and exact text/file bytes/order/name/MIME/identity relationships are
checked, not just counts. Export uses the actual read-only app UI and does not release any record.
Clone interception is installed on a genuine blank opener before navigating its app; no coordinator
or send implementation is substituted. Test fault injection affects only the fresh test context.

## Commands and evidence

Run the new read-only panel's focused unit stage before this native stage. Build the parent app only
when source preparation is complete, then:

```
scripts/sealed.sh env PI_WEB_PLUGIN_CATALOG_URL= node tests/durable-core-recovery-test.mjs
```

On a doubtful stage, `PI_WEB_RECOVERY_CASES=quota` (or another comma-separated case) selects only
that fixed stage for diagnosis. It is not a retry policy or permission to skip the final complete run.
Output is a metadata-only `result.json` beneath the printed `/tmp/durable-core-recovery-*` path.
Never publish the exported full payload artifact as a chat/debug dump.

Status: read-only panel stage **4/4 passed**. All five typecheck targets and the new application build
passed (a test-only URL mock signature was corrected; no production contract widened). Native full
case run first stopped BEFORE any send: an exact-text locator incorrectly expected the filename to
be a standalone element, but the real `.attach-chip.file` includes an icon/remove button. Source
confirms the correct chip/name relationship. H-CORE-FIXTURE-CHIP-1: select the real file chip by its
known name, retaining all exact byte/identity assertions; diagnose only `reload-clone` next. No
production fix, timeout stretch, native pass or skipped acceptance is claimed. Failed evidence:
`/tmp/durable-core-recovery-1793062606727/result.json`.

Targeted `reload-clone` next passed the chip and real send, then stopped at raw IDB row matching:
the fixture had matched `JSON.parse(row.payload).text === text`, while the actual v2 coordinator
stores a carrier record (`id: "prompt:<original>"`, nested `work` in `text`). H-CORE-FIXTURE-DECODE-1:
decode raw records and exported artifacts through the actual read-only
`readPendingRecoveryArtifact` codec instead of guessing private row fields. Failed evidence:
`/tmp/durable-core-recovery-1793062708021/result.json`.

H-CORE-FIXTURE-CHIP-1 HIT, H-CORE-FIXTURE-DECODE-1 HIT, and H-W2-RECOVERY-REACHABILITY-1 HIT (for
this actual-app core recovery scope): targeted `reload-clone` passed **20/20**
(`/tmp/durable-core-recovery-1793063034186/result.json`), and the full four-case native suite passed
**57/57 assertions** (`/tmp/durable-core-recovery-1793063050438/result.json`, zero live models/chats;
`build.server` `301fb69ce71ca1cb737c00206a44a4e35d962d3b7142ab57114bca66d3972a11`,
`build.webIndex` `231cf9da8eab2fe691512d48cf49c2d22a64cec5b9d4e3285c9fb58f1d5b1141`,
`build.readerSource` `bafab301b187636669dde86d34f80f6a644ed95fc92875e8eb2b5385515c9b90`).

## Limits / remaining work

This is not complete recovery-import/independent-reader/rollback, every caller/host, live speed or
broad losslessness proof. It does not execute compress/decompress or real models. The known empty
file truthiness path is an explicit separate codec case. Current unaccepted clone drafts are kept
editable, not claimed persisted under a stolen owner. Consent/config/secret/PTTY payloads are not
added to a generic journal. Existing live JSONL, settings, engine and user browser remain untouched.
