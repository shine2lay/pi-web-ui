# Canonical codec Task 1 RED receipt

## Pin consumption

Historical #602 manifest c8d277d114937642d116f8967852e7a53be66f08e934351774714de102fb004b:
31/31 entries verified from architecture-dept.
Successor #607 manifest 295fafebb19fc605facdd7b0dc0152ff3d2171c4e1fbbdd30b0ea3d738f320dd:
7/7 entries verified separately from architecture-dept-inbox-boundary-607.
Source/corpus/checker/contract exact hashes in pins.json; no historical artifact rewritten.
Security GO rm-1ab7b1d6 applies to that reference delta, not runtime implementation.

## Command and result

From pi-web-ui worktree:

`scripts/sealed.sh node --import tsx --test --test-reporter=tap acceptance/inbox-wire/codec.acceptance.ts`

Observed exit 1; 329 tests, 261 pass, 68 fail, 0 skipped/cancelled/todo.
Failures are acceptance assertions against the inert fail-closed codec (false versus true).
The first run used the default reporter; its summary was truncated. Repeated once with
TAP to retain the actual totals above, rather than guessing from the corpus.
No runtime imports the codec. Rejecting invalid inputs in the stub is not proof of
implemented schema validation; the valid twins prevent that all-refuse stub from passing.

## Coverage

- 43 original U602.1 view/ledger vectors, unchanged.
- 5 original core view vectors, unchanged (core corpus remains 90).
- 232 expanded #607 vectors: 227 invalid and 5 valid.
- 47 valid twins; 2 corpus count/uniqueness assertions.
- Effect-only reference vectors are applied to lifecycle.effect through the actual
  TypeScript view decoder; no copied reference effect decoder is introduced.
- Invalid views assert no exception, claimable=false and next-dispatch=null.
- Reader UNKNOWN/no effect enforcement belongs to acceptance/inbox-runtime, not this codec claim.

## Immutable assertion hashes

| Artifact | SHA256 |
|---|---|
| codec.acceptance.ts | d40c1e41c6f8bfded8184d3dcd91f86c01340285d40fd9567e7e258ab47cee79 |
| pins.json | ae45f38ae9a9a94cb8b84f987498c86a142183bb0d6b40532beb16d3213e7106 |
| inert server/shared/inbox-wire.ts | 3fd02d1fd165acb824bfcf9e167fbaedc0c21def1a2b4797fbdbf0d5fb755d5c |

Task 2 changes the inert implementation, never weakens these assertions or changes pins.
Standard repo gates and final land receipts are recorded by the parent handoff separately.
