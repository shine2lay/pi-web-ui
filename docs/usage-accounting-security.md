# Automatic costs: Security admission (S0)

Security #17 · accountable lead: Security · project: automatic-cost-accounting.
Review date: 2026-10-20. Plan: `docs/usage-accounting-wiring.md` at `d01eafb9`
(Ops #309). This note owns no runtime code or credential.

## Result and exact queue boundary

**AGREED: bounded reporting principal, evidence interpretation and dedicated
feed-key design. NOT ADMITTED: live feed use or T0/T1 under the unchanged #309
plans.** Security selects `usage-collector` as the same-service-UID Worker and
the existing Temper protected key-file mechanism, not Pi's model-provider store.
This is a logical application boundary, not a new isolated OS principal.
General Temper named/shared/run keys are **REFUSED**. The corrected declaration
`rm-8930526c`, as reconciled with its v2.1 paper artifact below, supersedes
`rm-70831239`; it fixes the key and cursor design but
also changes #309's coverage contract and expands #128's reader scope. Those
plan deltas need their normal recorded approval before dependent work is queued.

Ops can continue the already reviewed **W0-W3 and W5-W7** work, including pure
numeric fixtures. This note does not add dependencies between those independent
modules. S0's security-design gate is cleared only for the exact boundary below;
it is **not** an end-to-end source-readiness receipt. **T0/T1 may be queued only
after Ops updates their plans/checker for UNKNOWN coverage and the delivered
opaque epoch/cursor contract, and #128's expanded plan has its normal approval**.
No key, live request or activation is thereby authorized. **W4** can implement
the agreed reporting interpretation and unknown/unavailable cases, but cannot
claim authenticated funding until an admitted native root/payer producer exists. **R0** remains
Pi-only, subject to its existing prerequisites; it must not acquire a Temper key.
**C0** cannot certify complete budget replacement with missing funding, launch
origin or outside-task origin. Every implementation/install still needs its own
approved plan and named prerequisite receipts.

This is a Security review, not owner activation, spending approval, a key issue,
a publication of access, a root registration or a permission/hold change. An
answer arriving later is not agreement until this note records its readback.
Silence, a deadline or a queued plan is not approval.

## Hypothesis and bar, written before the review change

Problem/evidence: #309 leaves G1/G4/G6 open. Existing capture/verifier seams are
inert; `TaskRequester v1` is explicitly display-only. Temper's general named keys
have unrestricted write powers. A shaped JSON record or a read-only HTTP method
therefore does not establish a least-privilege collector or authenticated payer.

One change: record a closed source/principal/custody admission contract and its
explicit refusals here, rather than let downstream tasks infer permission.
Expected: every positive declaration has a named producer, consumer, purpose and
owner; every missing witness remains unknown; Ops can identify exactly which work
can proceed. Falsifier: a broad-key fallback, credential in a UI/diagnostic DTO,
label promoted to root evidence, failed request advancing a cursor, or any claim
that same-user isolation or live readiness has already been proved.

Result: paper/source readback **HIT** after the broad-key and sequence-cursor
corrections; security-design agreement is bounded as above. No implemented
feed/auth runtime proof is claimed. Fixed cases below are acceptance obligations,
not passes for absent code.

Readback hypothesis: the source artifact changed after the initial `852c7a9`
review (v2 SHA `efa1f649c420...` to v2.1 SHA below), adopting Security's custody
split and removing the proposed dedicated mount. Update this one note to pin and
read back those exact bytes. Expected: no stale mount/ownership or rotation grant
survives. Falsifier: a source mismatch or unreviewed custody transfer. Result:
**HIT**, full v2.1 readback; no collector/auth code changed or runtime proof added. Superseded complete-through expectations are not
silently retained: v1 coverage stays UNKNOWN.

## Reviewed sources, without reading live private data

- pi-web-ui `d01eafb99fd18642be354f7a998486453f84b3bc`:
  `server/usage-accounting-{contract,capture,collector,pi-sessions,membership}.ts`,
  `server/queue-requester.ts`, `server/task-queue.ts`, and the accounting docs.
- Temper `de8ea8c8d525af0396a40efee7d013fdde1a87d1`:
  `temper_ai/api/{auth,api_keys,caller}.py`, `scripts/api_key.py` and
  `docker-compose.yml`. #128 has no implementation or repository contract yet.
- Public pi-queue source: `queue-requester.ts`, alongside the membership module's
  documented queue/work-store projection. No real queue/session is opened here.
- Service metadata only: `pi-web-ui.service` is a user unit managed by UID 1000,
  `shinelay`; `User`/`Group` are unset, so it uses the user manager's identity.
  This does not inspect its environment, command-line credentials or private data.
- Temper's corrected declaration `rm-8930526c`, reconciled with the full v2.1
  paper artifact `/home/shinelay/company-lab/usage-feed-3b/ROUTE-DESIGN-S0.md`,
  SHA-256 `236738c6559410e38810dc02895372ae588b383f48703d12a3eb68ee42409333`.
  This replaces the initial v2 artifact
  `efa1f649c4202be0df861ea20b08cc8ad5d22a0142b4e7e6e1335331695a4875`
  after requests `rm-763c2ffb`/`rm-bf65cc98`; agreement is pinned, not a grant to
  later mutable bytes.
  Its quoted dependencies include Ops `rm-638ae2a1`, Data's UNKNOWN rule and
  owner option-A record `dr-78ff2d0aa3a2`; Architecture's A implementation ruling
  is still open (`rm-f1e5f6d4`). This review does not close that ruling.
- Ops delivered its source/principal/policy declaration as `rm-7b0446d6`, replying
  to `rm-9b07ac3c`; the policy wording below is that self-contained owner relay.

No live feed request, database query, browser inspection, model call, credential
read, secret issue/rotation, chat read or private role-folder read is part of this
review. Source-code paths below describe future grants, not live-data inspection.

## Principal and finite grants

**Agreed logical reporting principal: `usage-collector`**, exclusively the
dedicated pi-web-ui accounting Worker running as **`shinelay` (UID 1000)**.
Ops confirmed the service UID and delegated the supported credential-mechanism
choice to S0 in `rm-7b0446d6`; Security selects the exact native Temper path below.
No separate UID, DB account, Temper writer, model account or held Origin/R0/RTPI
capability is created. Implementation must bind this logical name to that worker,
not to a browser, generic CLI or a claimed requester label.

| Input / destination | Minimal permitted access | Witness and refusal boundary |
| --- | --- | --- |
| `<dataDir>/usage-ledger/YYYY-MM.jsonl` (`dataDir` currently `~/.pi-web-ui`) | Bounded read of supported monthly numeric partitions; directory/file metadata for dirty-source following | #306 closed `usage-ledger/1`; response identity, occurrence and captured parent only. Best-effort/zero-provenance gaps remain; it is not complete Pi coverage. |
| Supported Pi/ACP session catalog and explicit files | Catalog metadata and bounded reader-only numeric/header/entry-parent projection; originals before copies | No arbitrary home-directory discovery, prompt/message/tool/summary extraction or content in retained indices. No parent inferred from prose. Unsupported/fileless/deleted sources remain gaps. |
| Original queue add/assignment and work-registry history | Bounded metadata-only projection of original queue identity, task ID, `add.ts`, session binding, event-time project/initiative history | `assigned.ts` is not task birth; copied queues, missing add/sequence, ambiguous parents and latest-state-only history are not proof. Never read a whole chat to recover intent. |
| Requester and payer evidence | Host-admitted input kind/ID plus original task-proposal binding and separately supported policy/payer witness | Display labels, valid ID syntax, title/lead/path/model/time and approving a plan authenticate nothing. No message text or private mailbox is required or permitted. |
| Temper calls | GET only on the exact delivered #128 numeric route with the dedicated feed bearer | No events/run APIs, database, generic CLI/MCP, write route, broad token or model request. No task/project attribution inferred from run/model/time. |
| Collector durable state | Read/write only its private numeric journal, indices, cursor/quarantine and closed snapshots, under W1's agreed single-writer boundary | It must not modify source sessions, queue/registry/policy records, `spend.json`, budgets, stops or credential stores. No durable path is approved merely by this table. |
| Roles/main thread/browser | Closed, bounded, validated snapshot only; fixed-code faults and counts | No key, key hash/prefix, raw cursor, private source paths, arbitrary exceptions or source payloads. Main-thread request handling must not read sources or fetch the feed. |

Read-only source use is an application obligation. This process is not OS-confined:
it shares its UID, home and privileges with agents and the service. A same-UID
shell can read a 0600 key or alter same-user files; same-user hashes, journals and
witnesses are not tamper-proof against it. A Worker is a responsiveness/module
boundary, not credential isolation. Browser users granted arbitrary terminal/file
access inherit that capability too. We can prove that the **accounting browser
DTO path** never exposes the key, not that every authorized browser/agent feature
is unable to obtain it. A stronger claim needs separately approved OS isolation.
No ACL, mount or permission is changed here to manufacture that claim.

## Reporting evidence is not dispatch authority

Ops relays `dr-e108f47f8033` (2026-10-20 about 15:01 PDT) in `rm-7b0446d6`:
the owner chose **"Initiative, unless asked for"**. His recorded option says
"Tasks under the department's own initiative count, except ones whose record
shows you or another role asked for them"; older tasks from before the requester
record count as own work. Every task's cost is shown regardless, and own work
must be filed under the department's initiative to count. Ops's interpretation
on Board `bp-fe7de9ab` distinguishes another role's question/request from its
reply to our own question. Security agrees this **read-only reporting** reading,
not a new native root producer or automatic stop. The rule is applied as follows:

1. First independently establish the original task, its occurrence-time
   initiative and the department whose applicable policy pays. Membership alone
   does not establish payer or own/requested scope.
2. Only within a **verified in-scope task**, an older/unknown requester defaults
   own under the recorded rule. Missing task, payer, event-time parent or source
   provenance is **unknown allocation**, never default own or default exempt.
3. A recorded owner input or another role's actual question/request can support
   requested scope when the host input and original proposal binding are proved.
   A role **reply** to the department's own question is not that exemption.
   An approval, title, lead or `forOwner` display hint alone is not a request.
4. `requesterOf`/`requesterForAdmission` validate/capture metadata, not its durable
   authenticity. Obtain the original add snapshot and source-backed input binding;
   a self-supplied `trusted-native/1`, `rootRef` or matching-looking ID is rejected.
   Mixed, overflowing, missing or contradictory witnesses cannot become a
   reassuring exemption. W4 must test its exact conservative mapping.
5. If no independently vetted native root/payer source satisfies #293, return
   **funding unavailable** and retain observed numeric totals. Do not synthesize
   `DispatchRoot`, register Origin/R0/RTPI or relax the frozen contract.
6. Design own-work remains USD 2,000 Monday-Sunday Pacific; requested and Team
   remain separately visible/exempt as recorded. No new cap, debit or enforcement.
   Missing Temper launch-origin (G12), outside-task home/ad-hoc origin (G13),
   ACP structured parent, pricing or dedupe evidence stays explicit and incomplete.
   Owner-turn treatment is not decided here.

## Agreed credential, network and lifecycle boundary

**Rejected:** adding `usage-collector` to the general named-key registry or using
`TEMPER_API_TOKEN`, `TEMPER_API_TOKENS_FILE`, a run key or browser credential.
`caller.py` gives a non-box named caller `powers = None` (unrestricted), and
`TokenAuthMiddleware` admits broad named/run keys. GET alone is not least privilege.

The corrected design uses **`TEMPER_USAGE_FEED_KEYS_FILE`**, replacing
`TEMPER_USAGE_FEED_KEYS`, which is never read and has no enabling effect. Default
registry path: `configs/api/local/usage-feed-keys.json`, in the existing
read-only configs mount, git-ignored; no new compose mount/environment is needed.
Other containers can read this hash-only registry, not the bearer. No bearer is
in any environment.
The registry contains at most 16 validated name/SHA-256 entries. Missing, empty,
unreadable, malformed, any bad entry or too many names means **OFF for everyone**,
even with global API auth off. No partial acceptance or broad-key fallback.
Reconcile both the renamed setting and default-off wording in downstream plans.

The **selected existing** protected credential mechanism is Temper's
`scripts/api_key.py`: raw key files under
`~/.config/temper/api-keys/<name>.key`, directory 0700/file 0600, exclusive
creation, no token printing; hash-only registry. A future dedicated feed option
must reuse this native mechanism. The agreed intended collector load path is
`/home/shinelay/.config/temper/api-keys/usage-collector.key`; this is a standard
entry in that existing store, not a new ad-hoc secret-file mechanism. No key is
issued or file created by this review. pi-web-ui has no generic non-model secret
store or systemd credential unit today (Ops `rm-7b0446d6`): **do not** repurpose
`/home/shinelay/.pi/agent/auth.json`/SDK AuthStorage, Telegram plugin config,
a dotenv token copy or browser storage for the feed.
The worker reads only that configured file, checks its
expected private regular-file boundary, keeps the bearer in worker memory and
never passes it through command arguments, process-wide environment, worker
messages, persisted snapshots or model/tool contexts. Fail closed on absent,
unreadable, unsafe or empty credential; no shared/run/general-key fallback.

Keep raw keys outside every runner/server/box/repository mount. Compose currently
loads `.env` into **both server and runner**; placing a bearer there would not be
server-only custody. In v2.1 the hash-only registry uses the existing read-only
config mount: a SHA-256 digest of a random 256-bit key is not a bearer. Claiming
that a separate mount creates same-UID isolation would be false. The raw
credential necessarily reaches the authenticated route in request memory,
not its registry/logs. Hash-store write authority stays with its custodian.
These are intended grants, not a same-UID exclusion guarantee. No model worker
or child process receives the bearer or credential contents.

Only **loopback `http://127.0.0.1:8420`** is agreed for this host collector.
The route may remain on Temper's existing listeners; that does not approve this
collector sending its key to every reachable API address. Any non-loopback use
needs an exact approved protected transport/peer, TLS verification where relevant,
no redirects carrying Authorization, and no new listener, tunnel, CORS or browser
credential path. Tailnet/dockernet reachability alone is not such approval.

The route must enforce its own **header-only** dedicated-key check independently
of global auth and in-process caller hints. Bearer-header precedence is fixed;
URL query, cookie, WebSocket and broad named/shared/run credentials cannot substitute.
Compare against every validated stored hash in constant time, without a
match-position early return. All credential refusals use the same closed 403
body, without echo or key/name oracle. Only the exact feed path is exempted
from general middleware for self-authentication; it is never made anonymously readable. Reject write methods.
A feed bearer must not authenticate on general API routes when those require
auth. Existing anonymous reads/writes with global auth off are a separate exposure,
not proof of feed-key permission or a stronger system-wide access guarantee.

**Agreed operational split (v2.1): Temper applies accepted-key additions and
removals** with the supported `scripts/api_key.py --feed` host mechanism, which
writes/deletes the protected raw file without exposing its contents to a chat.
**Ops owns the collector's raw-file load and rotation timing/coordination**.
Temper owns the route, registry and script; Security agrees changes to this split.
The worker itself may only read its selected raw file, never write the registry
or gain general API authority. No role reads, prints or copies raw key contents
into chat. This preserves the approved Temper accepted-key ownership.

A separately authorized rotation has Temper remove then add `usage-collector`
at the same protected path; the collector re-reads after 403. A transient refusal
is delay, never cursor loss or evidence deletion. This v2.1 protocol replaces
the initial two-name overlap proposal. Temper revokes promptly on Ops/Security
request; the owner retains the direct supported revoke path. Ops verifies refusal
without printing a key.
Reload/revoke must take effect on the next request with no stale-cache or restart
dependency. Preserve accounting evidence. Adding the first accepted hash and
reader-epoch initialization are **activation**, requiring separate approval.
An exposed bearer is revoked, not merely removed from logs or source.

Logs, metrics, snapshots and faults use fixed safe codes/counts/statuses.
Request logs may additionally hold a server-generated bounded request ID,
duration/row count and the agreed logical principal name only on success, never
an arbitrary credential-supplied label. Exception class may be retained as a safe
code, never its message/traceback. Never log tokens, hashes, prefixes, headers,
URLs/query strings, private paths, raw response bodies/cursors or OS/parser text. The existing general
`api_keys.py` logs parser problems/paths; copying that logging into the feed
would violate this requirement. Unknown-parameter errors must not echo an
arbitrary supplied parameter name/value. No browser diagnostics endpoint may
return credential configuration or worker exceptions.

## Cursor and failure boundary

The corrected design has an **opaque route-issued cursor**, replayed byte for
byte only after durable batch commit. It carries a server-validated last-returned
anchor, instance and reader epoch, not a frontier or source identity. Public
`after`, row `seq`, `through_seq` and `max_seq` are removed. Native `call_key`
(Pi call ID or exact service start-event linkage) is independent of row identity
`(instance,event_id,revision)`; missing linkage is a gap. Conflicting content for
the same row identity stops ingestion; higher revisions must not double charge.

**Coverage is always `unknown` in v1**, never partial/complete. The corrected
artifact relays Ops `rm-638ae2a1` withdrawing `complete_through` after #309 and
Data requiring UNKNOWN. `assessed_*` is an inspected interval only. The numeric
frontier (`recorded_through`, pending count/oldest, last drain and closed stall
codes) is diagnostic, not completeness. Polling, a row or a fresh DB clock cannot
make the coverage label reassuring. This is a reasoned correction to this note's
initial complete-through expectation, not a claim that the unchanged #309
G7/T0/T1 text/checker already agrees. Ops must reconcile them before queueing.

The route uses a READ ONLY REPEATABLE READ transaction and compares private
source identity before and after row reads. A separate, lead-operated host
script may initialize/rebaseline an append-only reader epoch and append its
private host receipt; **that is not a grant to this read-only collector**.
No automatic/script-step/model/timer may initialize or rebaseline it. A changed
identity/epoch/anchor, regression, instance change or uninitialized reader gets
a closed 409; unreadable identity/not-primary gets an unavailable 503. The
private identity is never in a cursor, DTO or log. Same-identity rollback with
an unchanged anchor remains a declared limitation, not a claimed detection.
New epoch/identity DB code and host script belong to #128's expanded
plan/Architecture ruling and normal approvals, not this docs-only task. v2.1
removes the dedicated hash-store mount change; no compose change is agreed.

Off, 403, timeout, malformed/oversized page, storage error or protocol mismatch
keeps the last good cursor and evidence unchanged, with an explicit unavailable
fault and UNKNOWN coverage. A restore/reset 409 quarantines the old cursor; only
a supported explicit `epoch=<current>` paged re-read after the separately
recorded epoch handshake may reconcile it. Never silently reset to zero or skip
to a maximum; retain missing-restored evidence and never lower prior totals.
The route never rebaselines itself. No MAC on the cursor is a declared residual:
a credential holder may alter its own read position but acquires no extra scope;
consumer durability/replay must not trust an unissued cursor or a UI-supplied one.
Requests use exactly one of cursor (at most 256 characters) or epoch, and limit
1..500; responses are cut before 1 MiB, DB statement timeout is 2 seconds, handler
budget 3 seconds, retry-after 5. No-store/nosniff and no new CORS are required.

## Fixed admission cases (not a live-feed test)

| Fixed input / action | Required result |
| --- | --- |
| Verified original task, applicable payer/policy, unknown legacy requester | Own only under the reviewed reporting rule; retain native evidence references. |
| Same requester but absent task birth, payer or event-time parent | Unknown allocation/funding unavailable; observed cost remains visible. |
| Role request versus reply to our own question; forged owner/trust display label | Only proved original request may be exempt; reply/label does not mint exemption or root. |
| Original/copy/fork plus same-call aliases; missing structured ACP parent | One witnessed call only; pending ancestry/overlap remains a gap, not guessed identity. |
| Valid feed bearer, global auth on and off, native numeric-only page | Only exact feed GET (framework HEAD only with identical auth/no body) succeeds; no general authenticated write powers. |
| Empty/missing/unreadable/malformed registry or key; bad/shared/named/run/anonymous/cookie/query-only credential | Uniform refusal, no raw data, no fallback, no cursor or coverage advancement. |
| Bearer A plus conflicting header B; unsupported method; in-process request without headers | Declared header precedence only; no credential substitution; reject writes and headerless calls. |
| Raw credential in worker input plus planted error/parameter/payload sentinels | Key stays in worker; closed browser/main-thread DTOs and diagnostics contain none of the sentinels, credentials, hashes or private paths. |
| Off/403/503/timeout, torn/oversized/malformed page, journal failure before checkpoint | Exact prior cursor/evidence retained; unavailable and UNKNOWN coverage, never reassuring zero. |
| Restore/reset 409; late-commit rows; repeated page/restart | Quarantine old cursor, bounded proved reset, native-ID dedupe, honest incomplete coverage. |
| Key removal/rotation, atomic registry replacement, failed reload | Revoked key refused at next request; only declared current key(s) accepted; failure is off. |
| Fresh poll/new rows/frontier but UNKNOWN coverage; stalled drain or dead worker | Coverage remains UNKNOWN; diagnostic freshness/stall follows the amended consumer plan, not complete_through or a completeness alarm. |

S0 source/fixture checks can establish declared boundaries only. T0/#128/W6 tests
must execute the real auth, durable-cursor and DTO paths on fixed synthetic inputs;
fixtures that merely assert a proposed function's behavior are not runtime proof.
No live credential, feed request or model call is authorized to satisfy this table.

## Owed results and landing receipt

- **Ops** declaration `rm-7b0446d6` received: principal/source/policy/loopback and
  existing-store selection reviewed. Ops owns operational key lifecycle, not
  Temper's route/config design. Before queueing T0/T1, update their plan/checker
  for the corrected coverage-UNKNOWN, frontier and opaque epoch/cursor/reset
  contract; no complete-through acceptance can survive by implication. Native
  task/payer roots, G12/G13 and ACP gaps remain separate owed sources.
- **Temper** corrected paper design `rm-8930526c` received and read at the exact
  hash above. Record the agreed design and custody split in #128's public
  contract/plan. Its expanded epoch/identity/host-script scope, #126/#127
  knock-ons and proposed #128a/#128b split need normal plan approval and the
  still-open Architecture ruling. Exact-byte Security review **of the actual
  implementation before land** and fixed-input component tests remain owed.
  No second Temper server, production/private data or live key is a test fixture.
- **Security** source/paper readback is complete for this bounded design, not an
  implementation certificate or authenticated root. Any departure from the exact
  principal/auth/custody/UNKNOWN-coverage boundary needs a new bounded review.
  Silence/deadline admission is cancelled in Temper's corrected declaration.

## Validation and receipt

Validation uses only fixed numeric/auth metadata and source code: closed capture
projections must reject extra trust/payload fields, retain unknown allocation
without admitted witnesses and never register a producer; existing header parsing
must ignore query/cookie credentials and honor Bearer precedence; hash comparison
must visit every entry. The general key parser's partial-load behavior is a
negative control proving why the new strict feed loader needs its own tests.
These checks do not exercise absent feed/epoch/collector runtime code.
Executed once after the review edits: **16/16 numeric capture fixtures PASS**
(sealed local process) and **13/13 existing-auth/source fixtures PASS** (seven
header cases, three parser cases including partial-load negative control, two
full-hash-visit cases, one unrestricted-general-key case). Only assertion counts
were emitted; no live credentials, sessions, feed, database or model were read.
The v2.1 readback changes only this note; the exercised source modules are unchanged
from those fixture baselines. First normal landing: `852c7a9`, request
`143-a162ae`, notes gate **3 files / 103 tests PASS**. The v2.1 follow-up receives
its own normal landing check/receipt; it does not rerun unrelated source fixtures.

The normal docs-only landing uses detached `wt land`, including the configured
notes gate and any rebase/recheck it requires. Final commit, gate result and
source-fixture receipt are recorded in Security #17's completion and notebook.
No deploy/restart is part of this task.
