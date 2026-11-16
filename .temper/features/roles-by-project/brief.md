# Feature Brief: Roles page grouped by project (`roles-by-project`)

Recorded by Design from the owner's direct ask (design #323, 2026-11-15); Product may revise.
Grounded in [product brief](../../product/brief.md) and [personas](../../product/personas.md).

## User Moment

The owner opens Roles on laptop or phone a few times a day and thinks project by project:
what needs me, which projects are moving, what is stuck and why. Owner, 2026-11-15: "i typically
like to know by project most of the time, but have ability to group by other things as well,
without alot of knobs".

## Metrics vs Noise

- Matters: needs-you asks with their one answer; per project open / held / needs you / done in
  14 days; done-when progress; what holds each blocked chain and how to unblock it.
- Noise: flat task lists, per-task metadata on the first view, more than two controls.

## Non-Goals

- Changing what tasks do or acting on tasks other than answering the owner's asks.
- Editing projects, tags or queues from this page.
- New queue states or a priority field.

## Acceptance Checks

1. Default view groups by project (tag tiles for project-less tagged tasks); Group by offers
   Project, Now, Department, Status and is remembered; search is the only other control.
2. Needs you is collapsible, shows its first row then "Show N more", and each ask can be answered
   with the existing answer flow.
3. Every closed tile shows its mini task map (max 5 layers from the earliest unfinished layer);
   opening it shows the full map with done tasks green and the root blocker marked.
4. Loading, empty, error (last view kept, Try again) and no-results states render at 320, 390 and
   1440 px in light and dark with 0 overflow and 0 overlap.
