# Task 1120 — canonical inbox wire seam

## Problem and evidence

U602.1 has a pinned reference contract but no canonical TypeScript host codec.
Independent delivery and helper builds would otherwise invent incompatible readers.
Architecture's parent-boundary review found three strictness defects: processed
reply-required items, numeric opKey coercion, and an array effect throwing.

## Change

Declare one inert codec boundary in server/shared/inbox-wire.ts, and explicit
acceptance assertions at that boundary. No caller is installed by Task 1.
Consume the final Architecture #607 pin before freezing the assertions.
Runtime, helper, identity, OV and queue acceptance belong to disjoint slices.

## Measurement

Every pinned wire case and its exact expected refusal/acceptance is asserted.
Valid cases must fail against the inert stub; malformed cases must never throw.
Legacy standard gates remain green because nothing imports this seam at runtime.
A codec build makes these same assertions green without changing their hashes.

## Falsification

A second policy decoder, weakened corpus, active runtime caller, missing pin,
or an acceptance suite that merely tests a reference model falsifies the seam.
This is groundwork, not a claim of working runtime behavior.
