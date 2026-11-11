# Product Brief: Pi Web UI (`pi-web-ui`)

## Problem and user outcome
- **Pi Web UI** is the owner's unified command center for running, observing, and steering a 15-department AI software organization (`architecture`, `backend`, `coo`, `data`, `design`, `docs`, `frontend`, `marketing`, `ops`, `product`, `qa`, `rollcall`, `security`, `systems`, `temper`) across home chats, task queues, initiatives/projects, Show&Tell design reviews, and shared/personal OpenViking memory.
- Every page in Pi Web UI is built for **5-second executive glanceability**: the owner can tell at a glance what is running, what is waiting on him, whether core systems (like task queues and OpenViking memory) are actively working right now, and drill into details via progressive disclosure (`(?)` tooltips and expandable drawers) without reading walls of text.

## Target user and current stage
- **Primary user:** The owner overseeing all 15 department leads, reviewing Show&Tell deliverables, answering owner-only decision cards, and auditing system health and memory.
- **Secondary users:** Department lead agents coordinating tasks, projects, and memory across queues.

## Core capabilities
- **Multi-Role Chats, Task Queues & Initiatives/Roles Pages:** Real-time chat streaming, durable task queues with parallel lanes and `after` chains, and glanceable Roles & Initiatives rollups.
- **Show&Tell Visual Review Surface (`/showtell`):** Interactive HTML prototype and deliverable review with anchored comments and one-click approval.
- **OpenViking Memory Dashboard:** Live visibility into whether OpenViking (`openviking.service` `:1933` + `pi-openviking`) is actively serving and committing memory right now across Layer 1 (Shared Repo Resources & Craft Preferences) and Layer 2 (15 Per-Role Personal Memories), with `L0 -> L1 -> L2` progressive disclosure and changelog/guardrail auditing.

## Hard guardrails and non-goals
- **5-Second First View & Progressive Disclosure:** Never clutter primary views with long explanations, raw file paths, or internal hashes; use `(?)` tooltips (`role="tooltip"`) for contract/rule logic and expandable drawers for full content.
- **Zero fake or silent fallback numbers:** Never invent `0` when a service or file is unreachable; display explicit `Offline` or `Degraded Fallback` badges with the real reason.
