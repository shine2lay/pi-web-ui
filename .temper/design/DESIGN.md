# pi-web-ui Design Foundation (`DESIGN.md`)

Measured off live `pi-web-ui` (`web/index.html`, `themes/paper.css`, `themes/white.css`, `web/src/initiatives-view.css`, `web/src/tasks-roles-v8/styles.ts`, `web/src/model-management.css`) and paired with `.temper/design/tokens.json`. Records the existing look first, documents drift without silently re-theming the app, and marks every addition.

## 1. Who It Is For (Audience & Context)
- **Primary User — Owner Operator (`.temper/product/personas.md`):** Monitors 15 department leads and worker queues across desktop (`1440x900`) and phone (`390x844` / `320x568`) in dark (default) and light themes; needs a 5-second glance answer before drilling into raw evidence.
- **Secondary Actor — Role Agent Runtime:** Consumes deterministic server-owned fields rather than client-computed heuristics.
- **Anti-Personas:** Manual memory editors, cloud multi-tenant admins, or decorative analytics walls.

## 2. Five Failable Design Principles
1. **5-Second Glanceability Over Flat Logs:** Every workspace view opens with a status header and at most 4 summary cards (`<= 5` text fields per card). *Fails if:* a user must read a table or scroll below the fold to tell whether a subsystem is healthy, stale, idle, or offline.
2. **Honest Liveness & Distinct Unhealthy States:** `Healthy`, `Stale`, `Zero Activity`, and `Server Unreachable` are distinct operational truths. *Fails if:* any two share a badge label or icon, an unreachable backend renders `0` as healthy, or any live metric omits its age.
3. **Server-Owned Truth (Zero Client Roll-Up Math):** Every count, rate, and percentage maps 1:1 to a named server field. *Fails if:* browser code sums arrays, divides counters, or invents health thresholds.
4. **Progressive 3-Tier Disclosure:** Tier 1 shows status header, summary cards, and workspace tabs; Tier 2 explains contract vocabulary via `(?)` tooltips (`role="tooltip"`); Tier 3 opens full `L0`/`L1`/`L2` content and provenance in a reader drawer. *Fails if:* raw multi-line markdown, 64-char SHA-256 hashes, or host paths leak into Tier 1 rows.
5. **Derived Native Fit:** New views inherit `pi-web-ui` surface hierarchy, system sans/mono stacks, and `6px`/`10px`/`16px` radii. *Fails if:* a feature introduces external font CDNs, unapproved palettes, or inline style literals outside the token block.

## 3. Visual System (Measured Foundation, Drift & Additions)

### Measured Colour Hierarchy & Recorded Drift
- **Dominant Shell Foundation (Chosen Baseline):** `web/index.html` (`:root` dark) and `themes/paper.css` / `themes/white.css` (light) define `--bg-primary` (`#0d0d0d` dark / `#f7f6f2` light), `--bg-secondary` (`#161616` / `#ffffff`), `--bg-tertiary` (`#1f1f1f` / `#eeece6`), `--bg-hover` (`#262626` / `#e5e2da`), `--border` (`#2a2a2a` / `#dfdcd4`), `--border-light` (`#3a3a3a` / `#c8c4ba`), `--text-primary` (`#ececec` / `#1f1e1c`), `--text-secondary` (`#a0a0a0` / `#57544e`), and `--accent` (`#10a37f` / `#0d8a6a`).
- **Recorded Surface Drift (To Reconcile Later, Not Silently Overwritten):**
  - *Drift A (`web/src/initiatives-view.css`):* Cool-zinc local token set (`--iv-bg: #131316`, `--iv-card: #1b1b1f`, `--iv-border: #2a2a32` dark; `#f6f6f8` / `#ffffff` light).
  - *Drift B (`web/src/tasks-roles-v8/styles.ts`):* Inline JS theme constants (`#0c0d10` canvas, `#14161b` surface, `#1c1f26` elevated dark; `#f8f9fb` light).
  - *Drift C (Legacy Muted Contrast):* `web/index.html` `--text-muted: #6b6b6b` (`3.40:1` on `#161616`) and `themes/paper.css` `--text-muted: #8a867e` (`3.63:1` on `#ffffff`) fail WCAG 2.2 AA `4.5:1`.
- **Marked Additions in `.temper/design/tokens.json` (`origin: "addition"`):**
  - `color.text-muted`: AA-calibrated muted text (`#94949c` / `oklch(0.669 0.012 286.1)` dark at `5.47:1`; `#68645d` / `oklch(0.505 0.012 81.8)` light at `4.98:1`), keeping `text-muted-legacy` only as recorded drift.
  - `color.status-healthy-bg`, `color.status-stale-bg`, `color.status-unreachable-bg`, `color.status-info-bg`: Opaque surface pairings for measured semantic foregrounds (`#34d399`/`#065f46`, `#fbbf24`/`#92400e`, `#f87171`/`#b91c1c`, `#60a5fa`/`#1e40af`) for deterministic AA contrast.
  - `color.status-zero-fg` & `color.status-zero-bg`: Neutral slate pair (`#b4b4bb` on `#222226` dark; `#4b5563` on `#f3f4f6` light) so `Zero Activity` is distinct from `Stale` (amber) and `Server Unreachable` (crimson).

### Typography, Spacing & Radii
- **Font Stacks (Measured):** Sans `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif` (`web/index.html`); Mono `"SF Mono", "Fira Code", "JetBrains Mono", Consolas, monospace` (`web/index.html`). Zero external webfont requests.
- **Type Scale (Measured + Floor Rule):** `24px` (`size-xl`, primary metric, `700`), `18px` (`size-lg`, section/drawer title, `600`), `16px` (`size-body`, primary reading copy, `400`), `14px` (`size-md`, controls/table cells, `500`), `13px` (`size-sm`, secondary metadata, `400`), `12px` (`size-xs`, badges/headers/ages, `600`). Sub-12px drift (`10px`–`11px` in `web/index.html`) is banned in new surfaces. All numeric counters and ages set `font-variant-numeric: tabular-nums`.
- **Spacing & Radii (Measured):** Spacing `4px`, `8px`, `12px`, `16px`, `20px`, `24px`, `32px`. Radii `6px` (`--radius-sm`), `10px` (`--radius`), `16px` (`--radius-lg`), `999px` (pills).

## 4. Layout & Breakpoints (320px / 390px / 1440px)
- **Desktop (`1440x900`):** Max width `1360px` centered (`24px` padding). Full-width status header above a 3-column summary card grid (`repeat(3, minmax(0, 1fr))`, `16px` gap) and tabbed workspace. Reader drawer opens as a `520px` right slide-over panel.
- **Mobile (`390x844` and `320x568`):** Single-column stack (`12px` padding at `320px`, `16px` at `390px`). Cards stack `1fr`; tabs wrap with `0px` horizontal overflow (`scrollWidth <= clientWidth`); tables collapse secondary columns into stacked cards without overlapping text; reader drawer opens full-width (`100vw`).
- **Scroll Discipline:** Only the document viewport and open reader drawer scroll vertically; nested clipped card scrollbars are forbidden.

## 5. Component Inventory & Rules
1. **Status Header Bar:** Subsystem title, mode badge (`Active (15/15 Roles Live)`, `Degraded Local Fallback`, or `Offline`), non-colour icon, last-checked age, and cadence note.
2. **Summary Bento Card:** `bg-surface`, `1px solid border-subtle`, `10px` radius, `16px` padding. At most **5 text fields**: (1) title + `(?)` trigger, (2) primary metric (`24px` tabular-nums), (3) status pill + icon, (4) secondary context line, (5) age/cadence footer.
3. **Workspace Tab Strip:** `role="tablist"` with 3 `role="tab"` buttons (`>= 24x24px`, `36px` height), `accent-primary` active indicator, `ArrowLeft`/`ArrowRight` navigation.
4. **Concept Tooltip (`(?)`):** Button (`>= 24x24px`) bound via `aria-describedby` to a `role="tooltip"` popover explaining contract terms (`L0`/`L1`/`L2`, `Slot 1-5`, `Commit Guard`, `Sidecar`). Opens on hover and `:focus-visible`, closes on `Escape`.
5. **Expandable Row & Tier 3 Reader Drawer:** Row trigger (`aria-expanded="false|true"`) shows Tier 1 metadata only; activation opens the Reader Drawer (`role="dialog"`) with `L0 Abstract`, `L1 Overview`, and `L2 Full Content` tabs plus provenance.
6. **Read-Only Surface:** Zero mutation controls (`Edit`, `Delete`, `Promote`, `Override`, `Write`, `Commit`) exist anywhere.

## 6. Accessibility Floor
- **Contrast:** WCAG 2.2 AA (`>= 4.5:1` normal text, `>= 3.0:1` large text `>= 18px` bold / `24px`) across both dark and light themes.
- **Non-Colour Cues:** Every health/freshness state pairs colour with a distinct icon glyph and label (`●` Healthy, `◐` Stale, `◌` Zero Activity, `✕` Server Unreachable / Offline).
- **Targets, Focus & Motion:** Controls `>= 24x24px`, visible `:focus-visible` ring (`2px solid var(--accent-primary)`), keyboard-reachable tooltips/drawer (`Escape` closes), and `@media (prefers-reduced-motion: reduce)`.
