# Roles project card — stages and completed tasks (approved direction; proposed implementation)

Grounded in [product brief](../../product/brief.md), [personas](../../product/personas.md), and [Roles brief](../roles-by-project/brief.md). Accountable lead: Ops; Product shapes meaning, Design owns presentation.
Owner source: Shine chose "Stages + completed tasks" in Ops on 2026-11-26, decision `ask:call_4770ba35684c4e2bb292e2ab28eb9175|fc_0c3636d540921aec016b08da42ea1087d1b967ef7e3e560dd7` (Ops request rm-9d246a08).

## User Moment
Shine opens Roles to understand how far a project has actually progressed, what is happening now, and what comes next or blocks it. A card showing only Novega's 1/6 ring beside 19 tasks done in 14 days hides the difference between delivered milestones and activity. Make that distinction understandable at a glance without opening a chat.

## Metrics vs Noise
- Primary: real milestone/stage names and their recorded completion; current work; next explicitly known step or blocker with the responsible role. Use the registry's done_when entries as milestones, never infer delivery from closed tasks.
- Secondary: completed tasks with the existing time window plainly labeled (e.g. "19 tasks completed · last 14 days"). This measures activity, not project completion. Preserve access to actual completed work in the existing task detail/map.
- Where stages run in parallel, show parallel current work rather than pretending there is one sequential stage. If a current task cannot be mapped to a milestone, show it as current work without assigning a stage.
- Missing milestone plans, task mappings or next steps stay explicitly unknown/not recorded; never invent a percentage, delivery date, stage completion or blocker. Compact labels may shorten words, not change meaning; full names remain accessible.

## Non-Goals
- Changed: project-card progress presentation only. Frozen: page layout/navigation, grouping/search, needs-you and answer flows, non-project cards, existing task-map behavior and queue/registry semantics. No new stage editor or model-generated project plan.
- No redesign outside the card, no progress based on task-count ratios, no changing milestone status because activity looks complete. Design prototypes on the real existing component and records Changed versus Frozen (Rule 38).

## Acceptance Checks
1. Novega-style data with 1 of 6 milestones met and 19 completed tasks in 14 days shows both distinctly, with actual milestone names; neither 19 tasks nor current work changes the 1/6 completion measure.
2. The closed card makes completed milestones, current work and known next/blocker legible; real parallel tasks remain parallel. Details expose the source milestone/task names and blocker owner without fabricated mappings.
3. Missing milestone data or next-step evidence is labeled honestly; a failed read is not rendered as zero progress or success. Finished, active, blocked, waiting and no-active-task projects remain distinguishable using existing recorded state.
4. At 320/390/1440px in light/dark, no overflow/overlap or console errors; keyboard-accessible detail disclosure retains full labels. Frozen components and existing controls behave unchanged in Live versus Proposed comparison.

## Hypothesis
Problem/evidence: the supplied Novega card mixes 1/6 milestones, 1 open, 19 done in 14 days and 1 working without explaining delivered progress. Change: name real milestones and separate current/next work from recent completions. Expected: in Shine's prototype review he can identify what is delivered, happening now and next/blocked without opening chat; deterministic fixtures verify exact counts and unknown states. Wrong if he still confuses recent task completions with delivered milestones or any displayed stage lacks a recorded source.
