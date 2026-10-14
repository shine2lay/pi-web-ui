# R10 P0 — disabled role-reported requested spend

Ops #144; exact Data document acceptance rm-fc9b056e. This additive I-PUB candidate-2 sidecar is not a new C0 root. Production Roles services, protocol, renderer and own-v1 reader/test bytes are untouched. None of these modules has a production importer.

Pinned SHA256: SCHEMA d88b6ca2709abea7113ae9c86f5ed153b93c7d6e11fc1d48b815f83be2ba00ea; SPEC 72dbb8ee6ba7f9b2c56552bafa49ee40df127762c10440d605235b101af79f5a; ORACLES 8b3c060ea8638955aef34ac75b54f1da8319dd021180c7df292f32ac99cfebee. Private accepted packet: `company-lab/shared/roles-requested-publication-2026-10-13/`.

## Missing native primitive

`readRequestedSpend()` takes NO role/path/reader/helper/capability options. The sealed native seam returns null. It reports `T04-native-reader-absent` without publication I/O. No realpath, check-then-open, leaf-only O_NOFOLLOW fallback, native helper, registry, key, timer or activation option is added.

T04 must be independently approved and audited before this reader can function: a pinned registry-root directory descriptor, every ancestor/root/leaf, magic links, traversal and rename/root swaps; regular nlink1 file; raw bytes <=65536; stable same-descriptor dev/ino/size/mtime/ctime across the bounded read. Existing own-v1 behavior is intentionally NOT hardened here. Same-UID compromise remains a residual; a JSON flag, hash, file mode or WeakMap is not isolation.

## Pure adapter/fixture proof

`createRequestedReaderFixture(binding)` snapshots an exact synthetic own-role/source/issuer/subject/lineage/incarnation/object/period and cohort/origin/allocation/policy/dedupe/attestation-ref binding. It cannot admit native refs. `readRequestedSpendFixture(capability, receipt)` accepts only that identity, a bounded explicit synthetic descriptor receipt and canonical RTPI bytes. It validates the CLOSED sidecar, refs/namespaces, count partitions/reasons, attestation versions, times, real Pacific Monday boundaries and expected predecessor. Copied/forged capabilities refuse. All descriptor failure types refuse without fallback.

The synthetic receipt is NOT a native FD primitive; the in-memory revision comparison is NOT durable CAS. Results say `fixture` and `adapter-fixture-only-not-kernel-or-durable-CAS`. Revision replay is idempotent only for the same canonical bytes; same revision/different bytes is conflict, skipped/stale/wrong predecessor refuse. No sum, newest-mtime selection, ledger access or writes.

Labels say `Role-reported list-price`, not centrally verified spend, bills or quota. Freshness uses asOf, strictly age >24h. Exactly 24h is current; fresh generatedAt/mtime never renews old asOf. Older or view-period-mismatched records are separate `last-known` views. Incomplete figures have no total; known parts and reasons stay separate. Actual or display-rounded incomplete zero is suppressed, exact parts remain in the record. Complete evidenced empty zero is permitted without fabricated components. Missing amount/count never defaults to zero. Individual figures only: no aggregate schema or arithmetic.

## Verification and undo

`tests/unit/roles-requested.test.ts` covers V10/V12/S01/S06/S07 canonical/schema/ref/role/revision/descriptor/freshness/zero/DST negatives, no-T04 status, no production importer and immutable own-v1 implementation/test SHA256 controls. The unchanged own-v1 suite remains in the normal gate. A fixture pass does not qualify kernel behavior, native authentication, real amounts or the complete Roles data chain.

D-MISSING returns a bounded proposal to Ops: accept this source-only disabled result, with T04/T05 and real own-role source opt-ins still missing. Any helper/auth/native registration and activation needs a separate complete approved plan; package B remains required. Undo: revert this isolated patch through normal worktree/gates. No stored data, settings, publication, install or restart changed.
