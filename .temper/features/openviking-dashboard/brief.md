# Memory Explorer: Brief Pointer

## Status

Superseded by [brief-v3.md](brief-v3.md). The original activity dashboard is removed.
Use v3's find → browse → read → fix/remove order, not the former dashboard card/tab order.

## Current Guidance

- Product intent and acceptance checks: [brief-v3.md](brief-v3.md).
- Delivered explorer layout, states and reference evidence: [design.md](design.md).
- API/security contracts: Architecture-owned `spec-explorer*.md` in this folder.

## User Moment

Find, read and correct memory; see v3's User Moment.

## Metrics vs Noise

Find → browse → read → fix/remove; compact health only. See v3's priority order.

## Non-Goals

Do not restore the removed activity dashboard or its obsolete requirements.

## Acceptance Checks

Canonical acceptance checks are in [brief-v3.md](brief-v3.md), not the original dashboard checks:
- Find relevant notes by meaning or exact words with scope and no-result recovery.
- Browse copyable paths and read the three levels with honest missing-data states.
- Confirm edits/deletes, offer Undo and record changes; protect setup files and owner access.
- Render honest loading/down/error states at 320/390/1440 in both themes.
