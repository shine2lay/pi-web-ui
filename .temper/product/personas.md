# User Personas: Pi Web UI (`pi-web-ui`)

## Primary Persona — The Owner (Executive Operator & System Overseer)
- **Context & goal:** Steers 15 autonomous departments simultaneously; asks direct operational questions like *"Is it using OpenViking right now? Is there a dashboard for it?"* and needs an honest, 5-second visual answer backed by real live telemetry rather than raw JSONL logs.
- **How they use the OpenViking Memory Dashboard:**
  1. **5-Second Live Check:** Glances at the top status strip and 3 summary cards to confirm `openviking.service` (`:1933`) and `pi-openviking` are actively injecting Mode 1 (`L0` lead cards) and Mode 2 (Worker Turn-1 pre-fetches), syncing `.temper` resources on `wt land`, and committing task/session lessons.
  2. **Inspect Shared vs. Personal Role Memory:** Switches between **Layer 1 (Shared Resources & 8 Craft Preferences)** and **Layer 2 (15 Roles' Personal Preferences, Cases & Experiences)**, scanning 1-line `L0` abstracts first and clicking any item to unfold its `L1 Overview` or `L2 Full Document`.
  3. **Verify Safety Guardrails:** Checks that worker preference write attempts are blocked (`R-PREF-WRITE-GUARD-1`) and `rm-*` role messages are deduplicated before memory commit.
- **Frustrations to avoid:** Flat ungrouped lists, walls of markdown text in the default view, raw URIs/hashes without plain-English labels, or a dashboard that looks green when `openviking.service` is actually in degraded fallback.

## Secondary Persona — Department Lead / Ops Engineer (Memory & Sync Auditor)
- **Context & goal:** Verifies that `.temper` and `architecture-dept` convention changes landed via `wt land` synced cleanly into `viking://resources/`, checks why a worker pre-fetch dropped or included a doc, and audits `/home/shinelay/.pi/openviking/memory-changelog.jsonl`.
- **Frustrations to avoid:** Having to SSH and run `jq` over `/home/shinelay/.pi/openviking/memory-changelog.jsonl` or `metrics.jsonl` just to see what was committed or injected.
